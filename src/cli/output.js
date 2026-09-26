// Human and --json output for the CLI commands. One convention everywhere: results on stdout,
// problems on stderr prefixed "error:" / "warning:", and with --json stdout carries exactly one
// JSON document so it can be piped into jq.

import { Writable } from 'node:stream';

/** @typedef {import('../core/types.js').CliIO} CliIO */

/**
 * @param {CliIO} io
 * @param {{json?: boolean}} [opts]
 */
export function createOutput(io, { json = false } = {}) {
  const write = (stream, text) => stream.write(text.endsWith('\n') ? text : `${text}\n`);
  return {
    json,
    /** A line of normal output (suppressed in --json mode, where only `data` reaches stdout). */
    line(text = '') { if (!json) write(io.stdout, text); },
    info(text) { if (!json) write(io.stdout, text); },
    warn(text) { write(io.stderr, `warning: ${text}`); },
    error(text, hint) {
      write(io.stderr, `error: ${text}`);
      if (hint) write(io.stderr, `  ${hint}`);
    },
    data(obj) { io.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); },
  };
}

/** Left-aligned columns; `rows` are arrays of cell strings. */
export function table(rows, { indent = '' } = {}) {
  const widths = [];
  for (const r of rows) r.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, String(c ?? '').length); });
  return rows.map((r) => indent + r.map((c, i) => (i === r.length - 1 ? String(c ?? '') : String(c ?? '').padEnd(widths[i]))).join('  ').trimEnd()).join('\n');
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatAgo(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return 'never';
  const d = now - ts;
  return d < 0 ? 'just now' : `${formatDuration(d)} ago`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1048576).toFixed(1)} MiB`;
}

/**
 * A stream that replaces every registered secret before passing text on. main.js wraps the
 * CLI's stdout/stderr with it as a last line of defence: commands are written never to print
 * the password, and this makes that true even for a message we didn't anticipate.
 * Secrets shorter than 6 characters are ignored — replacing "abc" everywhere would mangle output.
 * @param {NodeJS.WritableStream} target
 * @param {string[]} secrets
 */
export function redactingStream(target, secrets) {
  const list = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 6))].sort((a, b) => b.length - a.length);
  const scrub = (text) => list.reduce((t, s) => t.split(s).join('***'), text);
  const stream = new Writable({
    decodeStrings: false,
    write(chunk, encoding, cb) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      // Hand over and return at once: buffering here would lose lines on process.exit.
      target.write(scrub(text));
      cb();
    },
  });
  // Commands (and the logger's "auto" format) look at these to pick colours / text vs JSON.
  for (const k of ['isTTY', 'columns', 'rows', 'fd']) {
    if (target[k] !== undefined) Object.defineProperty(stream, k, { get: () => target[k], enumerable: true });
  }
  return stream;
}

/** Resolves once everything written so far has been handed to the OS (before process.exit). */
export function flushStream(stream) {
  return new Promise((resolve) => {
    if (!stream || typeof stream.write !== 'function' || stream.destroyed || stream.writableEnded) { resolve(); return; }
    try { stream.write('', () => resolve()); } catch { resolve(); }
  });
}
