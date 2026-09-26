// Test doubles for the runtime modules: a manual clock, an in-memory transport, the topic
// builder and plain-Ajv validators over the vendored protocol schemas.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const topicTable = JSON.parse(readFileSync(`${root}protocol/v1/topics.json`, 'utf8'));

export const TENANT = '64b7a1000000000000000001';
export const GATEWAY = 'gw_test01';
export const PREFIX = `tenants/${TENANT}/sources/gateway/${GATEWAY}`;

/** Settle every pending promise chain (one macrotask turn drains the microtask queue). */
export async function flush(turns = 3) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

/**
 * A clock whose time only moves when told to. Timers run in due order; promise chains are
 * drained between timers so async code behaves as it would in real time. `jump()` steps the
 * WALL clock (what now() returns) without moving timers — a clock that is set backwards.
 */
export function createFakeClock(start = Date.UTC(2026, 8, 26, 10, 0, 0)) {
  let mono = 0;
  let offset = start;
  let nextId = 1;
  const timers = new Map();
  const add = (fn, ms, every) => {
    const id = nextId++;
    timers.set(id, { id, at: mono + Math.max(0, ms), fn, every });
    return id;
  };
  const clock = {
    now: () => mono + offset,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms)),
    clearInterval: (id) => { timers.delete(id); },
    /** Advance time by ms, running every timer that falls due, in order. */
    async advance(ms) {
      const target = mono + ms;
      await flush();
      for (;;) {
        let next = null;
        for (const t of timers.values()) if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
        if (!next) break;
        mono = next.at;
        if (next.every) next.at += next.every;
        else timers.delete(next.id);
        next.fn();
        await flush();
      }
      mono = target;
      await flush();
    },
    jump(ms) { offset += ms; },
    pending: () => timers.size,
  };
  return clock;
}

export function createTopics() {
  return {
    prefix: PREFIX,
    up(name, deviceId) {
      const row = topicTable.topics.find((t) => t.direction === 'up' && t.scope === 'gateway' && (t.id === name || t.id === `gateway.${name}` || t.suffix === name));
      if (!row) throw new Error(`unknown uplink ${name}`);
      return `${PREFIX}/${row.suffix.replace('{deviceId}', deviceId ?? '')}`;
    },
  };
}

/** Topic suffix after the gateway prefix, e.g. "devices/<id>/data". */
export const suffix = (topic) => topic.slice(PREFIX.length + 1);

/**
 * In-memory transport. Records every publish with the clock time it was handed over.
 * `hold = true` keeps publishes pending until `release()` — a wedged socket.
 */
export function createFakeTransport(clock) {
  const held = [];
  const t = {
    connected: true,
    hold: false,
    sent: [],
    publish(topic, payload, opts = {}) {
      if (!t.connected) return Promise.reject(new Error('not connected'));
      const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
      const rec = { topic, suffix: suffix(topic), text, body: JSON.parse(text), qos: opts.qos ?? 0, retain: !!opts.retain, at: clock.now() };
      t.sent.push(rec);
      if (!t.hold) return Promise.resolve();
      return new Promise((resolve) => held.push(resolve));
    },
    release() { for (const r of held.splice(0)) r(); },
    bySuffix: (re) => t.sent.filter((m) => (typeof re === 'string' ? m.suffix === re : re.test(m.suffix))),
  };
  return t;
}

let ajvCache;
/** Plain Ajv over protocol/v1/schemas: no removeAdditional, no useDefaults. */
export function createValidators() {
  if (!ajvCache) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const dir = `${root}protocol/v1/schemas`;
    const byName = new Map();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const schema = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      ajv.addSchema(schema);
      byName.set(f.replace(/\.json$/, ''), schema.$id);
    }
    ajvCache = { ajv, byName };
  }
  const { ajv, byName } = ajvCache;
  return {
    validate(name, value) {
      const fn = ajv.getSchema(byName.get(name));
      if (!fn) return { ok: false, errors: [`no schema ${name}`] };
      const ok = fn(value);
      return { ok: !!ok, errors: ok ? [] : fn.errors.map((e) => `${e.instancePath || '/'} ${e.message}`) };
    },
    names: () => [...byName.keys()],
  };
}

/** A Logger that records lines (and exposes tap/recent like the real one). */
export function createMemoryLogger() {
  const lines = [];
  const taps = new Set();
  const make = (category) => {
    const emit = (level) => (msg, fields) => {
      const line = { ts: 0, level, category, msg: fields ? `${msg} ${JSON.stringify(fields, (k, v) => (v instanceof Error ? v.message : v))}` : msg };
      lines.push(line);
      for (const fn of taps) fn(line);
    };
    return {
      debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error'),
      child: (c) => make(c), redact() {}, tap(fn) { taps.add(fn); return () => taps.delete(fn); },
      recent: () => lines.slice(-100), setLevel() {}, level: 'debug',
    };
  };
  const log = make('system');
  log.lines = lines;
  return log;
}

/** Records every state write; starts from the given overrides/seq. */
export function createMemoryState({ overrides = { v: 1, devices: {} }, seq = { v: 1, devices: {} } } = {}) {
  const s = {
    overrides: structuredClone(overrides),
    seq: structuredClone(seq),
    seqWrites: 0,
    readOverrides: () => structuredClone(s.overrides),
    writeOverrides: (o) => { s.overrides = structuredClone(o); },
    readSeq: () => structuredClone(s.seq),
    writeSeq: (q) => { s.seq = structuredClone(q); s.seqWrites++; },
  };
  return s;
}

/** A backfill stand-in that just collects records. */
export function createMemoryBackfill() {
  const records = [];
  return { records, append: (r) => records.push(structuredClone(r)), stats: () => ({ records: records.length, bytes: 0, dropped: 0, writeErrors: 0 }) };
}

/** Build a DeviceSpec with the defaults config-model would fill in. */
export function device(id, { protocol = 'fake', intervalMs = 5000, tags = [{ name: 't1' }], conn = {} } = {}) {
  const full = tags.map((t) => ({
    isIntervalRead: true, scaleFactor: 1, offset: 0, thresholdStart: 0, thresholdEnd: 0, mbAddress: 0,
    registerType: 'holding', mbFormat: 'u16', mbWordOrder: 'big', metric: '', topic: '', cmdTopic: '', jsonPath: '', raw: {}, ...t,
  }));
  return { id, protocol, conn, tags: full, intervalMs, readIntervalMs: 0, fingerprint: JSON.stringify({ protocol, conn, tags: full }), raw: {} };
}

/** A 24-hex device id from a small number. */
export const devId = (n) => `64b7a1${String(n).padStart(18, '0')}`;
