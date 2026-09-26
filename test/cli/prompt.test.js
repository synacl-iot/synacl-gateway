import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { promptHidden, promptLine, readStdinLine } from '../../src/cli/prompt.js';
import { capture } from '../_support/cli/helpers.js';

function fakeTty() {
  const s = new PassThrough();
  s.isTTY = true;
  s.isRaw = false;
  s.rawCalls = [];
  s.setRawMode = (on) => { s.rawCalls.push(on); s.isRaw = on; return s; };
  return s;
}

test('readStdinLine takes the first line, strips CR, and rejects on empty input', async () => {
  const a = new PassThrough();
  const p = readStdinLine(a);
  a.write('sec');
  a.end('ret\r\nsecond line\n');
  assert.equal(await p, 'secret');
  const b = new PassThrough();
  const q = readStdinLine(b);
  b.end('no newline');
  assert.equal(await q, 'no newline');
  const c = new PassThrough();
  const r = readStdinLine(c);
  c.end();
  await assert.rejects(r, (e) => e.code === 'ABORTED');
});

test('promptHidden on a terminal: raw mode, no echo, backspace, restores the mode', async () => {
  const stdin = fakeTty();
  const stderr = capture({ isTTY: true });
  const p = promptHidden('Password: ', { stdin, stderr });
  stdin.write('abX');
  stdin.write('\u007f');
  stdin.write('c\r');
  assert.equal(await p, 'abc');
  assert.deepEqual(stdin.rawCalls, [true, false]);
  assert.equal(stderr.text(), 'Password: \n', 'nothing typed is echoed');
});

test('promptHidden: Ctrl-C aborts; a pasted value with a trailing newline works', async () => {
  let stdin = fakeTty();
  let p = promptHidden('P: ', { stdin, stderr: capture() });
  stdin.write('ab\u0003');
  await assert.rejects(p, (e) => e.code === 'ABORTED');
  assert.equal(stdin.isRaw, false);

  stdin = fakeTty();
  p = promptHidden('P: ', { stdin, stderr: capture() });
  stdin.write('Zx8vQm2Lk9Rt4Yb7Nc1Sd6Fg\n');
  assert.equal(await p, 'Zx8vQm2Lk9Rt4Yb7Nc1Sd6Fg');
});

test('promptHidden from a pipe reads a line; promptLine shows its question on stderr', async () => {
  const stdin = new PassThrough();
  const stderr = capture();
  const p = promptHidden('P: ', { stdin, stderr });
  stdin.end('piped\n');
  assert.equal(await p, 'piped');
  assert.equal(stderr.text(), '', 'no prompt text when nobody is looking');

  const s2 = new PassThrough();
  const e2 = capture();
  const q = promptLine('Email: ', { stdin: s2, stderr: e2 });
  s2.end('me@example.com\n');
  assert.equal(await q, 'me@example.com');
  assert.equal(e2.text(), 'Email: ');
});
