// Logger: levels, categories, redaction, a live-tail tap and a small ring for diagnostics.
//
// Redaction happens once, before a line is written anywhere (stdout, taps, the ring), so a
// credential can never leak through a side channel. Three rules apply to every line:
//   1. strings registered with `redact()` (broker and local-broker passwords) are replaced
//      wherever they appear — in the message and in any field value, however deeply nested;
//   2. a field whose key looks like a credential (pass, secret, token, authorization) is `***`;
//   3. URL userinfo (`mqtt://user:pw@host`) is replaced, so a URL is always safe to log.

/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').LogLine} LogLine */
/** @typedef {import('./types.js').LogLevel} LogLevel */
/** @typedef {import('./types.js').LogCategory} LogCategory */
/** @typedef {import('./types.js').Clock} Clock */

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/** Wire bitmask of each category (debug/logs/start `cats`). */
export const CATEGORY_BITS = Object.freeze({ system: 1, network: 2, commands: 4, modbus: 8, sensors: 16, macros: 32 });

const SECRET_KEY = /pass|secret|token|authorization/i;
// scheme://userinfo@ — userinfo is anything up to the first '@' that has no '/', '?', '#' or space.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
const MASK = '***';
const RING_SIZE = 100;
const MAX_DEPTH = 6;

/**
 * @param {Object} [opts]
 * @param {LogLevel} [opts.level]
 * @param {'auto'|'text'|'json'} [opts.format]  auto = text on a TTY, JSON lines otherwise.
 * @param {NodeJS.WritableStream} [opts.stdout]  debug + info
 * @param {NodeJS.WritableStream} [opts.stderr]  warn + error
 * @param {Clock} [opts.clock]
 * @param {LogCategory} [opts.category]
 * @returns {Logger & {setLevel(level: LogLevel): void, readonly level: LogLevel, recent(): LogLine[]}}
 */
export function createLogger({ level = 'info', format = 'auto', stdout = process.stdout, stderr = process.stderr, clock, category = 'system' } = {}) {
  const root = {
    threshold: LEVELS[level] ?? LEVELS.info,
    levelName: LEVELS[level] ? level : 'info',
    json: format === 'json' || (format !== 'text' && !stdout?.isTTY),
    secrets: /** @type {string[]} */ ([]),
    taps: new Set(),
    ring: /** @type {LogLine[]} */ ([]),
    dispatching: false,
    now: () => (clock ? clock.now() : Date.now()),
  };

  function redactText(s) {
    let out = String(s);
    for (const secret of root.secrets) if (out.includes(secret)) out = out.split(secret).join(MASK);
    return out.replace(URL_USERINFO, `$1${MASK}@`);
  }

  function redactValue(v, depth) {
    if (typeof v === 'string') return redactText(v);
    if (v === null || typeof v !== 'object') return v;
    if (depth >= MAX_DEPTH) return '[…]';
    if (v instanceof Error) {
      const e = { name: v.name, message: redactText(v.message) };
      if (v.code !== undefined) e.code = v.code;
      return e;
    }
    if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
    if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) ? MASK : redactValue(x, depth + 1);
    return o;
  }

  function fieldsText(fields) {
    if (!fields) return '';
    let s = '';
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      const str = typeof v === 'string' ? (/[\s="]/.test(v) || v === '' ? JSON.stringify(v) : v) : safeJson(v);
      s += ` ${k}=${str}`;
    }
    return s;
  }

  function emit(lvl, cat, msg, rawFields) {
    if (LEVELS[lvl] < root.threshold) return;
    const ts = root.now();
    const text = redactText(msg);
    const fields = rawFields && typeof rawFields === 'object' ? redactValue(rawFields, 0) : undefined;

    const stream = LEVELS[lvl] >= LEVELS.warn ? stderr : stdout;
    let out;
    if (root.json) {
      out = safeJson({ ...(fields || {}), time: new Date(ts).toISOString(), level: lvl, category: cat, msg: text }) + '\n';
    } else {
      out = `${new Date(ts).toISOString()} ${lvl.toUpperCase().padEnd(5)} [${cat}] ${text}${fieldsText(fields)}\n`;
    }
    try { stream?.write(out); } catch { /* a closed stream must never take the gateway down */ }

    /** @type {LogLine} */
    const line = { ts, level: lvl, category: cat, msg: text + fieldsText(fields) };
    root.ring.push(line);
    if (root.ring.length > RING_SIZE) root.ring.shift();

    // A tap listener that logs (e.g. the live tail reporting a publish failure) must not
    // recurse into itself: nested lines still reach stdout and the ring, just not the taps.
    if (root.dispatching || root.taps.size === 0) return;
    root.dispatching = true;
    try {
      for (const fn of root.taps) {
        try { fn(line); } catch { /* one broken listener must not silence the others */ }
      }
    } finally {
      root.dispatching = false;
    }
  }

  function make(cat) {
    return {
      debug: (msg, fields) => emit('debug', cat, msg, fields),
      info: (msg, fields) => emit('info', cat, msg, fields),
      warn: (msg, fields) => emit('warn', cat, msg, fields),
      error: (msg, fields) => emit('error', cat, msg, fields),
      child: (c) => make(CATEGORY_BITS[c] ? c : cat),
      redact(secret) {
        if (typeof secret !== 'string' || secret.length === 0) return;
        const forms = new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
        for (const f of forms) if (f && !root.secrets.includes(f)) root.secrets.push(f);
        // Longest first, so a secret that contains another is masked whole.
        root.secrets.sort((a, b) => b.length - a.length);
      },
      tap(listener) {
        root.taps.add(listener);
        return () => root.taps.delete(listener);
      },
      setLevel(lvl) {
        if (!LEVELS[lvl]) return;
        root.threshold = LEVELS[lvl];
        root.levelName = lvl;
      },
      get level() { return root.levelName; },
      recent: () => root.ring.map((l) => ({ ...l })),
    };
  }

  return make(CATEGORY_BITS[category] ? category : 'system');
}

function safeJson(v) {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
  } catch {
    return '"[unserialisable]"';
  }
}

/**
 * A logger that discards everything but still honours the Logger shape. For tests and for
 * library callers that pass nothing.
 * @returns {Logger}
 */
export function nullLogger() {
  const noop = () => {};
  const l = {
    debug: noop, info: noop, warn: noop, error: noop,
    child: () => l, redact: noop, tap: () => noop, setLevel: noop, level: 'info', recent: () => [],
  };
  return l;
}
