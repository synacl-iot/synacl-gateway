// Store-and-forward buffer: readings taken while the uplink is down (or while a device's live
// publish is backlogged) are kept on disk and replayed later on `data/backfill`.
//
// Layout (inside the per-gateway state dir):
//   backfill/seg-000001.jsonl …  one data-backfill record per line, segments ≤ 1 MiB
//   backfill/cursor.json         {seg, line, dropped, writeErrors}
//
// Records are appended synchronously, so a reading that was accepted survives a crash. The
// cursor only moves after the batch was handed to the socket: a batch lost in a disconnect is
// sent again (the platform de-duplicates by device + ts), never skipped. Replay never goes to the
// live data topic — the live path rate-gates per device and would suspend a device replaying
// its backlog.

import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './state.js';

/** @typedef {import('./types.js').Clock} Clock */
/** @typedef {import('./types.js').Logger} Logger */

export const MAX_BATCH_RECORDS = 40;
/** The whole serialised `{"batch":[…]}` body, as the reference firmware packs it. */
export const MAX_BATCH_BYTES = 3500;
const ENVELOPE_BYTES = Buffer.byteLength('{"batch":[]}');
const MAX_SEGMENT_BYTES = 1024 * 1024;
const SEG_RE = /^seg-(\d+)\.jsonl$/;
const DEVICE_ID_RE = /^[0-9a-fA-F]{24}$/;
const QUALITIES = new Set(['good', 'bad', 'uncertain', 'stale']);
/** Before this the clock has not been set (a board without an RTC, before NTP). */
const MIN_VALID_YEAR = 2025;

const segName = (n) => `seg-${String(n).padStart(6, '0')}.jsonl`;

/**
 * The exact data-backfill record, or null. Keys outside the schema would fail the platform's
 * validation of the whole batch, so the record is rebuilt rather than passed through.
 */
export function toRecord(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.deviceId !== 'string' || !DEVICE_ID_RE.test(r.deviceId)) return null;
  if (!Number.isInteger(r.ts) || r.ts < 0) return null;
  if (!r.values || typeof r.values !== 'object' || Array.isArray(r.values)) return null;
  const values = {};
  let n = 0;
  for (const [k, v] of Object.entries(r.values)) {
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || typeof v === 'string') {
      values[k] = v;
      n++;
    }
  }
  if (n === 0) return null;
  const out = { deviceId: r.deviceId, ts: r.ts, values };
  if (typeof r.q === 'string' && QUALITIES.has(r.q)) out.q = r.q;
  if (Number.isInteger(r.seq) && r.seq >= 0) out.seq = r.seq;
  return out;
}

/**
 * @param {{dir: string, clock: Clock, log?: Logger,
 *          limits?: {maxBytes?: number, maxAgeHours?: number, segmentBytes?: number}}} opts
 */
export function createBackfill({ dir, clock, log, limits = {} }) {
  const maxBytes = Math.max(1024, limits.maxBytes ?? 64 * 1024 * 1024);
  const maxAgeMs = Math.max(1, limits.maxAgeHours ?? 168) * 3600 * 1000;
  // Several segments must fit under maxBytes, or dropping "the oldest segment" would drop
  // everything at once.
  const segmentBytes = limits.segmentBytes ?? Math.min(MAX_SEGMENT_BYTES, Math.max(4096, Math.floor(maxBytes / 4)));
  const cursorFile = join(dir, 'cursor.json');

  /** @type {{n: number, file: string, bytes: number, lines: number, lastTs: number}[]} oldest first */
  let segments = [];
  let cursor = { seg: 1, line: 0 };
  let dropped = 0;
  let writeErrors = 0;
  let draining = false;
  let closed = false;
  /** @type {{n: number, bytes: number, lines: string[]} | null} */
  let cache = null;
  const warned = new Set();

  function warnOnce(key, msg, fields) {
    if (warned.has(key)) return;
    warned.add(key);
    log?.warn(msg, fields);
  }

  function persistCursor() {
    try {
      atomicWrite(cursorFile, JSON.stringify({ seg: cursor.seg, line: cursor.line, dropped, writeErrors }));
    } catch (err) {
      log?.warn('could not save the buffer cursor', { error: err.message });
    }
  }

  function lastTsOf(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ts = JSON.parse(lines[i]).ts;
        if (Number.isInteger(ts)) return ts;
      } catch { /* corrupt line; look further back */ }
    }
    return -Infinity;
  }

  function open() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
    let saved = null;
    try { saved = JSON.parse(readFileSync(cursorFile, 'utf8')); } catch { /* first run, or unreadable */ }
    if (saved && typeof saved === 'object') {
      if (Number.isInteger(saved.dropped) && saved.dropped >= 0) dropped = saved.dropped;
      if (Number.isInteger(saved.writeErrors) && saved.writeErrors >= 0) writeErrors = saved.writeErrors;
    }

    const found = readdirSync(dir).map((f) => SEG_RE.exec(f)).filter(Boolean)
      .map((m) => ({ n: Number(m[1]), file: join(dir, m[0]) })).sort((a, b) => a.n - b.n);
    for (const { n, file } of found) {
      let buf;
      try { buf = readFileSync(file); } catch { continue; }
      // A crash mid-append leaves a line without its newline: cut it off rather than let it
      // glue onto the next record.
      const end = buf.lastIndexOf(0x0a) + 1;
      if (end < buf.length) {
        try { truncateSync(file, end); } catch { /* read-only; the drain skips it as corrupt */ }
        dropped++;
        buf = buf.subarray(0, end);
      }
      const lines = buf.length ? buf.toString('utf8').split('\n').slice(0, -1) : [];
      segments.push({ n, file, bytes: buf.length, lines: lines.length, lastTs: lastTsOf(lines) });
    }

    const want = saved && Number.isInteger(saved.seg) && Number.isInteger(saved.line) ? saved : { seg: 0, line: 0 };
    const at = segments.find((s) => s.n >= want.seg);
    if (!at) {
      // Everything on disk is before the cursor: already sent.
      const next = Math.max(want.seg, (segments.at(-1)?.n ?? 0) + 1, 1);
      for (const s of segments) rmSync(s.file, { force: true });
      segments = [];
      cursor = { seg: next, line: 0 };
    } else {
      cursor = at.n === want.seg ? { seg: at.n, line: Math.min(Math.max(0, want.line), at.lines) } : { seg: at.n, line: 0 };
      for (const s of segments.filter((x) => x.n < cursor.seg)) rmSync(s.file, { force: true });
      segments = segments.filter((x) => x.n >= cursor.seg);
    }
    tidy();
  }

  function pending() {
    let n = 0;
    for (const s of segments) {
      if (s.n > cursor.seg) n += s.lines;
      else if (s.n === cursor.seg) n += s.lines - cursor.line;
    }
    return n;
  }

  function totalBytes() {
    return segments.reduce((a, s) => a + s.bytes, 0);
  }

  /** Delete a segment, counting whatever in it had not been sent yet as dropped. */
  function dropSegment(seg, why) {
    const lost = seg.n > cursor.seg ? seg.lines : seg.n === cursor.seg ? seg.lines - cursor.line : 0;
    dropped += lost;
    rmSync(seg.file, { force: true });
    segments = segments.filter((s) => s !== seg);
    if (cache && cache.n === seg.n) cache = null;
    if (cursor.seg <= seg.n) cursor = { seg: segments[0]?.n ?? seg.n + 1, line: 0 };
    if (lost > 0) log?.warn(`buffer ${why}: dropped ${lost} buffered reading(s)`, { dropped });
  }

  /** Once everything is sent, delete the files so an idle gateway keeps an empty buffer dir. */
  function tidy() {
    if (segments.length === 0 || pending() > 0) return;
    const next = segments.at(-1).n + 1;
    for (const s of segments) rmSync(s.file, { force: true });
    segments = [];
    cache = null;
    cursor = { seg: next, line: 0 };
  }

  function enforceAge(now) {
    while (segments.length > 0 && segments[0].lines > 0 && segments[0].lastTs < now - maxAgeMs) {
      dropSegment(segments[0], `older than ${maxAgeMs / 3600000} h`);
    }
  }

  function enforceCap(incoming) {
    while (segments.length > 0 && totalBytes() + incoming > maxBytes) {
      dropSegment(segments[0], `full (${maxBytes} bytes)`);
    }
  }

  function writeSegment(incoming) {
    const last = segments.at(-1);
    if (last && (last.bytes === 0 || last.bytes + incoming <= segmentBytes)) return last;
    const n = Math.max((last?.n ?? 0) + 1, cursor.seg);
    const seg = { n, file: join(dir, segName(n)), bytes: 0, lines: 0, lastTs: -Infinity };
    segments.push(seg);
    return seg;
  }

  function readLines(seg) {
    if (cache && cache.n === seg.n && cache.bytes === seg.bytes) return cache.lines;
    const buf = readFileSync(seg.file);
    const lines = buf.length ? buf.toString('utf8').split('\n').slice(0, -1) : [];
    cache = { n: seg.n, bytes: seg.bytes, lines };
    return lines;
  }

  open();

  return {
    /**
     * @param {{deviceId: string, ts: number, values: Object, seq?: number, q?: string}} record
     * @returns {boolean} true when stored. Never throws.
     */
    append(record) {
      if (closed) return false;
      const now = clock.now();
      const rec = toRecord(record);
      if (new Date(now).getUTCFullYear() < MIN_VALID_YEAR || (rec && new Date(rec.ts).getUTCFullYear() < MIN_VALID_YEAR)) {
        dropped++;
        warnOnce('clock', 'the system clock is not set (year before 2025); readings are not buffered until it is');
        return false;
      }
      if (!rec) {
        dropped++;
        warnOnce('shape', 'a reading could not be buffered: it is not a valid data-backfill record');
        return false;
      }
      const line = `${JSON.stringify(rec)}\n`;
      const bytes = Buffer.byteLength(line);
      if (ENVELOPE_BYTES + bytes - 1 > MAX_BATCH_BYTES) {
        dropped++;
        warnOnce('size', `a reading is too large to replay (over ${MAX_BATCH_BYTES} bytes); not buffered`, { deviceId: rec.deviceId });
        return false;
      }
      try {
        enforceAge(now);
        enforceCap(bytes);
        const seg = writeSegment(bytes);
        appendFileSync(seg.file, line, { mode: 0o600 });
        seg.bytes += bytes;
        seg.lines += 1;
        if (rec.ts > seg.lastTs) seg.lastTs = rec.ts;
        return true;
      } catch (err) {
        writeErrors++;
        dropped++;
        log?.warn('could not write to the store-and-forward buffer', { error: err.message, writeErrors });
        return false;
      }
    },

    /**
     * Send the next batch — oldest first, ≤ 40 records, ≤ 3500 bytes as `{"batch":[…]}`.
     * @param {(batch: Object[]) => Promise<void>} send  Resolves once the batch is written.
     * @returns {Promise<number>} records sent (0 when empty or a drain is already running).
     *   Rejects with send's error; the cursor then stays put and the batch is sent again.
     */
    async drainTick(send) {
      if (closed || draining) return 0;
      enforceAge(clock.now());
      if (pending() === 0) { tidy(); return 0; }
      draining = true;
      try {
        const start = { ...cursor };
        const pos = { ...cursor };
        const records = [];
        let size = ENVELOPE_BYTES;
        let skipped = 0;
        let full = false;
        for (let i = segments.findIndex((s) => s.n === pos.seg); i >= 0 && i < segments.length && !full; i++) {
          const seg = segments[i];
          if (seg.n !== pos.seg) { pos.seg = seg.n; pos.line = 0; }
          let lines;
          try {
            lines = readLines(seg);
          } catch (err) {
            log?.warn('a buffer segment is unreadable; dropping it', { error: err.message });
            dropSegment(seg, 'segment unreadable');
            return 0;
          }
          for (let j = pos.line; j < lines.length; j++) {
            let rec = null;
            try { rec = toRecord(JSON.parse(lines[j])); } catch { /* corrupt line */ }
            if (!rec) { skipped++; pos.line = j + 1; continue; }
            const add = Buffer.byteLength(JSON.stringify(rec)) + (records.length ? 1 : 0);
            if (records.length >= MAX_BATCH_RECORDS || size + add > MAX_BATCH_BYTES) { full = true; break; }
            records.push(rec);
            size += add;
            pos.line = j + 1;
          }
        }
        if (skipped > 0) warnOnce('corrupt', 'skipped corrupt line(s) in the store-and-forward buffer');
        if (records.length > 0) await send(records);
        // A cap/age drop during the await may already have moved the cursor past this batch.
        const moved = cursor.seg !== start.seg || cursor.line !== start.line;
        if (!moved || pos.seg > cursor.seg || (pos.seg === cursor.seg && pos.line > cursor.line)) {
          cursor = { seg: pos.seg, line: pos.line };
          dropped += skipped;
        }
        for (const s of segments.filter((x) => x.n < cursor.seg)) {
          rmSync(s.file, { force: true });
          if (cache && cache.n === s.n) cache = null;
        }
        segments = segments.filter((x) => x.n >= cursor.seg);
        tidy();
        persistCursor();
        return records.length;
      } finally {
        draining = false;
      }
    },

    stats() {
      return { records: pending(), bytes: totalBytes(), dropped, writeErrors };
    },

    close() {
      if (closed) return;
      closed = true;
      persistCursor();
    },
  };
}
