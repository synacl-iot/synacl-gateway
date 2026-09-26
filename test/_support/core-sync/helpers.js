// Test helpers for the core-sync tests: a manual clock, the platform's config slicing (re-
// implemented from the published protocol description) and a scripted config/request answerer.

import { fnv1a32 } from '../../../src/core/fnv.js';

/** Let pending promise chains run (a few macrotask turns). */
export async function flush(turns = 5) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

/** A Clock whose time only moves in advance(); timers fire in due order. */
export function createFakeClock(start = Date.UTC(2026, 0, 1)) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn, every: 0 });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(1, ms), fn, every: Math.max(1, ms) });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    pending: () => timers.size,
    /** Advance time, firing due timers in order and letting async work settle after each. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let nextId = null;
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= end && (next === null || t.at < next.at || (t.at === next.at && id < nextId))) { next = t; nextId = id; }
        }
        if (!next) break;
        now = next.at;
        if (next.every) next.at += next.every; else timers.delete(nextId);
        next.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
  return clock;
}

/**
 * The platform's chunking: base64 of the UTF-8 bytes, `per = max(4, cap − 64)` floored to a
 * multiple of 4 (each slice decodes on its own), parts `{p, n, h, d}`.
 */
export function sliceConfig(bytes, cap, hash = fnv1a32(bytes)) {
  const b64 = Buffer.from(bytes).toString('base64');
  let per = Math.max(4, cap - 64);
  per -= per % 4;
  const n = Math.max(1, Math.ceil(b64.length / per));
  return Array.from({ length: n }, (_, p) => ({ p, n, h: hash, d: b64.slice(p * per, (p + 1) * per) }));
}

/** A transport stand-in that records what was published. */
export function createRecordingTransport() {
  const published = [];
  return {
    connected: true,
    published,
    publish(topic, payload, opts = {}) {
      if (!this.connected) return Promise.reject(new Error('not connected'));
      published.push({ topic, payload: Buffer.from(payload), opts });
      return Promise.resolve();
    },
    requests(suffix = '/config/request') {
      return published.filter((m) => m.topic.endsWith(suffix)).map((m) => JSON.parse(m.payload.toString('utf8')));
    },
  };
}

/**
 * Answers config/request the way the platform documents it: `{unchanged:true}` for a matching
 * non-zero hash, one chunk when `cap` is present and the payload is larger, else the payload.
 * `tamper(part)` may rewrite a chunk; `silent` drops requests (e.g. an oversized config).
 */
export function createScriptedPlatform(bytes) {
  const p = {
    bytes: Buffer.from(bytes),
    silent: false,
    tamper: null,
    served: [],
    answer(req) {
      if (p.silent) return null;
      const hash = fnv1a32(p.bytes);
      if (req.hash && req.hash === hash) return Buffer.from('{"unchanged":true}');
      if (req.cap && p.bytes.length > req.cap) {
        const parts = sliceConfig(p.bytes, req.cap, hash);
        const idx = Number.isInteger(req.part) && req.part >= 0 && req.part < parts.length ? req.part : 0;
        let part = parts[idx];
        if (p.tamper) part = p.tamper(part) ?? part;
        p.served.push(idx);
        return Buffer.from(JSON.stringify(part));
      }
      return p.bytes;
    },
  };
  return p;
}

/**
 * Wire a recording transport to a scripted platform: every config/request published is answered
 * (asynchronously) into `deliver`.
 */
export function autoAnswer(transport, platform, deliver) {
  const orig = transport.publish.bind(transport);
  transport.publish = (topic, payload, opts) => {
    const r = orig(topic, payload, opts);
    if (topic.endsWith('/config/request')) {
      const reply = platform.answer(JSON.parse(Buffer.from(payload).toString('utf8')));
      if (reply) setImmediate(() => deliver(reply));
    }
    return r;
  };
}

/** A Logger that remembers every line. */
export function createMemoryLogger() {
  const lines = [];
  const secrets = [];
  const mk = (category) => {
    const scrub = (s) => secrets.reduce((acc, x) => acc.split(x).join('***'), s);
    const at = (level) => (msg, fields) => lines.push({ level, category, msg: scrub(String(msg)), fields: fields === undefined ? undefined : JSON.parse(scrub(JSON.stringify(fields))) });
    return {
      debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'),
      child: (c) => mk(c),
      redact: (s) => { if (s) secrets.push(String(s)); },
      tap: () => () => {},
      recent: () => [],
    };
  };
  const log = mk('system');
  log.lines = lines;
  log.text = () => lines.map((l) => `${l.level} ${l.msg} ${l.fields ? JSON.stringify(l.fields) : ''}`).join('\n');
  return log;
}
