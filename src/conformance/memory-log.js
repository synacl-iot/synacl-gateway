// An in-memory Logger (src/core/types.js contract) for conformance runs and driver tests.
//
// It keeps every line so a run can assert on what was logged, and it applies the same
// redaction rules the real logger promises (registered secrets, secret-looking keys), so a
// check that "the password never appears" is meaningful: the only way to fail it is to log
// the secret before it was registered, or to leak it by some other route.

/** @typedef {import('../core/types.js').Logger} Logger */
/** @typedef {import('../core/types.js').LogLine} LogLine */

const SECRET_KEY = /pass|secret|token|authorization/i;

/**
 * @param {{clock?: {now(): number}, level?: 'debug'|'info'|'warn'|'error', echo?: (line: LogLine) => void}} [opts]
 * @returns {Logger & {lines: (LogLine & {fields?: Object})[], secrets: string[], raw: string[]}}
 */
export function createMemoryLogger({ clock = { now: () => Date.now() }, level = 'debug', echo } = {}) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[level] ?? 10;
  const secrets = [];
  const lines = [];
  const raw = [];          // unredacted-by-key text as built, before secret replacement (for self-checks)
  const listeners = new Set();

  const scrub = (s) => {
    let out = String(s);
    for (const secret of secrets) if (secret) out = out.split(secret).join('***');
    return out;
  };
  const scrubFields = (value, depth = 0) => {
    if (value == null || depth > 4) return value;
    if (typeof value === 'string') return scrub(value);
    if (typeof value !== 'object') return value;
    if (value instanceof Error) return scrub(value.message);
    if (Array.isArray(value)) return value.map((v) => scrubFields(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '***' : scrubFields(v, depth + 1);
    return out;
  };
  const fmt = (fields) => {
    if (!fields || typeof fields !== 'object') return '';
    const parts = [];
    for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    return parts.length ? ` ${parts.join(' ')}` : '';
  };

  function make(category) {
    const write = (lvl) => (msg, fields) => {
      if ((order[lvl] ?? 0) < min) return;
      const clean = scrubFields(fields);
      raw.push(String(msg) + fmt(fields));
      /** @type {LogLine & {fields?: Object}} */
      const line = { ts: clock.now(), level: lvl, category, msg: scrub(String(msg) + fmt(clean)) };
      if (clean !== undefined) line.fields = clean;
      lines.push(line);
      if (echo) echo(line);
      for (const fn of listeners) {
        try { fn({ ts: line.ts, level: line.level, category: line.category, msg: line.msg }); } catch { /* a tap must never break logging */ }
      }
    };
    return {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (cat) => make(cat || category),
      redact: (secret) => { if (typeof secret === 'string' && secret.length && !secrets.includes(secret)) secrets.push(secret); },
      tap: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      /** The last 100 lines (the diagnostics snapshot's recentLogs). */
      recent: () => lines.slice(-100).map(({ ts, level: lv, category: c, msg }) => ({ ts, level: lv, category: c, msg })),
      lines,
      secrets,
      raw,
    };
  }
  return make('system');
}

/** Every logged line (message and fields) that contains any of `secrets`. */
export function linesContaining(logger, secrets) {
  const needles = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  return logger.lines.filter((l) => {
    const text = l.msg + (l.fields ? JSON.stringify(l.fields) : '');
    return needles.some((s) => text.includes(s));
  });
}
