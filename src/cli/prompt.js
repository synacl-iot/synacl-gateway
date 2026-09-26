// Interactive input for `init --pass-stdin` and `doctor`. Prompts go to stderr so stdout stays
// clean for --json. On a terminal the password is read with echo off; from a pipe the first
// line is taken, so `printf '%s\n' "$PASS" | synacl-gateway init … --pass-stdin` works.

/** @typedef {import('../core/types.js').CliIO} CliIO */

export class PromptAbortedError extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'PromptAbortedError';
    this.code = 'ABORTED';
  }
}

/**
 * Reads a secret without echoing it.
 * @param {string} question
 * @param {Pick<CliIO, 'stdin'|'stderr'>} io
 * @returns {Promise<string>}
 */
export function promptHidden(question, io) {
  const { stdin, stderr } = io;
  if (!stdin?.isTTY || typeof stdin.setRawMode !== 'function') {
    if (question && stderr?.isTTY) stderr.write(question);
    return readStdinLine(stdin);
  }
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = Boolean(stdin.isRaw);
    const finish = (err) => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      try { stdin.setRawMode(wasRaw); } catch { /* terminal already gone */ }
      stdin.pause();
      stderr.write('\n');
      if (err) reject(err); else resolve(value);
    };
    const onEnd = () => finish(value ? null : new PromptAbortedError());
    const onData = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') { finish(null); return; }
        if (ch === '\u0003') { finish(new PromptAbortedError()); return; }        // Ctrl-C (raw mode swallows SIGINT)
        if (ch === '\u0004') { finish(value ? null : new PromptAbortedError()); return; } // Ctrl-D
        if (ch === '\u007f' || ch === '\b') { value = [...value].slice(0, -1).join(''); continue; }
        if (ch === '\u0015') { value = ''; continue; }                              // Ctrl-U clears the line
        if (ch === '\u001b') return;                                                // arrow keys etc.: drop the sequence
        if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.resume();
  });
}

/**
 * Reads a visible line (e.g. an e-mail address).
 * @param {string} question
 * @param {Pick<CliIO, 'stdin'|'stderr'>} io
 */
export function promptLine(question, io) {
  if (question) io.stderr.write(question);
  return readStdinLine(io.stdin);
}

/**
 * The first line of a stream, without its line ending. Rejects with PromptAbortedError when the
 * stream ends before anything was read.
 * @param {NodeJS.ReadableStream} stdin
 * @returns {Promise<string>}
 */
export function readStdinLine(stdin) {
  return new Promise((resolve, reject) => {
    if (!stdin) { reject(new PromptAbortedError('no input')); return; }
    let buf = '';
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      stdin.pause?.();
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk) => {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) done(null, buf.slice(0, nl).replace(/\r$/, ''));
    };
    const onEnd = () => (buf ? done(null, buf.replace(/\r$/, '')) : done(new PromptAbortedError('no input on stdin')));
    const onError = (err) => done(err);
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume?.();
  });
}
