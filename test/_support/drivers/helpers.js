// Shared helpers for the driver tests: a manual clock, a capturing logger that does NOT
// redact (so a test proves the driver never logs a secret in the first place), device/tag
// builders with the platform's defaults, and small async utilities.
import { createServer } from 'node:net';

/**
 * A clock whose time only moves when the test calls advance(). Timers run in due order.
 * @param {number} [start]
 */
export function createFakeClock(start = 1_767_225_600_000) {
  let now = start;
  let seq = 0;
  /** @type {Map<object, {due: number, fn: () => void, every: number|null, seq: number}>} */
  const timers = new Map();
  const add = (fn, ms, every) => {
    const id = { timer: ++seq };
    timers.set(id, { due: now + Math.max(0, Number(ms) || 0), fn, every, seq });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: (id) => void timers.delete(id),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 1)),
    clearInterval: (id) => void timers.delete(id),
    /** Move time forward, running every timer that falls due on the way. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.due <= target && (!next || t.due < next[1].due || (t.due === next[1].due && t.seq < next[1].seq))) next = [id, t];
        }
        if (!next) break;
        const [id, t] = next;
        now = Math.max(now, t.due);
        if (t.every) t.due += t.every;
        else timers.delete(id);
        t.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

/** The real clock, in the Clock shape. */
export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(/** @type {any} */ (h)),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(/** @type {any} */ (h)),
};

/**
 * A Logger that records every line verbatim and every redact() call.
 * @returns {import('../../../src/core/types.js').Logger & {lines: Array<{level: string, category: string, msg: string, fields?: object}>, secrets: string[], text: () => string}}
 */
export function createCaptureLog() {
  const lines = [];
  const secrets = [];
  const make = (category) => {
    const at = (level) => (msg, fields) => lines.push({ level, category, msg: String(msg), ...(fields ? { fields } : {}) });
    return {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: (c) => make(c),
      redact: (s) => {
        if (typeof s === 'string' && s) secrets.push(s);
      },
      tap: () => () => {},
    };
  };
  const log = /** @type {any} */ (make('system'));
  log.lines = lines;
  log.secrets = secrets;
  log.text = () => lines.map((l) => `${l.level} ${l.msg} ${l.fields ? JSON.stringify(l.fields) : ''}`).join('\n');
  return log;
}

/** A TagSpec with the platform's omitted-at-default keys filled in. */
export function makeTag(partial) {
  return {
    name: 'value',
    isIntervalRead: true,
    scaleFactor: 1,
    offset: 0,
    thresholdStart: 0,
    thresholdEnd: 0,
    mbAddress: 0,
    registerType: 'holding',
    mbFormat: 'u16',
    mbWordOrder: 'big',
    metric: '',
    topic: '',
    cmdTopic: '',
    jsonPath: '',
    raw: {},
    ...partial,
  };
}

let deviceSeq = 0;
/** A DeviceSpec; tags are run through makeTag. */
export function makeDevice({ id, protocol, conn = {}, tags = [], intervalMs = 10_000 } = {}) {
  deviceSeq++;
  return {
    id: id ?? `66f1a2b3c4d5e6f7081${String(deviceSeq).padStart(5, '0')}`,
    protocol,
    conn,
    tags: tags.map(makeTag),
    intervalMs,
    readIntervalMs: 0,
    fingerprint: '',
    raw: {},
  };
}

/** A DriverContext for tests. */
export function makeCtx({ log = createCaptureLog(), clock = realClock, options = {}, gatewayId = 'test-gw-01', signal = new AbortController().signal } = {}) {
  return { log, clock, gatewayId, dataDir: '/nonexistent-driver-data', signal, options };
}

/** A TCP port nothing is listening on (at the moment of asking). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `pred` until it is truthy (or throw after `timeoutMs`). */
export async function waitFor(pred, { timeoutMs = 3000, stepMs = 5, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}
