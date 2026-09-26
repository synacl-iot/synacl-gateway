import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../../src/core/log.js';
import { createFakeClock } from '../_support/core-runtime/fakes.js';

function sink(isTTY = false) {
  const chunks = [];
  return { isTTY, chunks, write(s) { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

function make(opts = {}) {
  const stdout = sink(opts.tty);
  const stderr = sink(opts.tty);
  const clock = createFakeClock();
  const log = createLogger({ level: 'debug', format: 'json', stdout, stderr, clock, ...opts });
  return { log, stdout, stderr, all: () => stdout.text() + stderr.text() };
}

test('a registered secret is replaced in the message, nested fields and the tap', () => {
  const { log, all } = make();
  const tapped = [];
  log.tap((l) => tapped.push(l));
  log.redact('hunter2-pw');
  log.info('connecting with hunter2-pw now', { nested: { deep: ['x hunter2-pw y'] } });
  assert.ok(!all().includes('hunter2-pw'));
  assert.ok(all().includes('***'));
  assert.ok(!tapped[0].msg.includes('hunter2-pw'));
  assert.ok(!JSON.stringify(log.recent()).includes('hunter2-pw'));
});

test('children share the redactor, the taps and the ring', () => {
  const { log, all } = make();
  const tapped = [];
  log.tap((l) => tapped.push(l));
  const child = log.child('modbus');
  log.redact('s3cr3t!');
  child.warn('failed with s3cr3t!');
  assert.ok(!all().includes('s3cr3t!'));
  assert.equal(tapped[0].category, 'modbus');
  assert.equal(log.recent().at(-1).category, 'modbus');
});

test('a percent-encoded secret is redacted too', () => {
  const { log, all } = make();
  log.redact('p@ss w/rd');
  log.info('url tail p%40ss%20w%2Frd');
  assert.ok(!all().includes('p%40ss%20w%2Frd'));
});

test('credential-looking keys are masked at any depth', () => {
  const { log, stdout } = make();
  log.info('opts', { password: 'a', conn: { brokerPassword: 'b', apiToken: 'c', Authorization: 'Bearer d', clientSecret: 'e', host: 'h' } });
  const rec = JSON.parse(stdout.text());
  assert.equal(rec.password, '***');
  assert.deepEqual(rec.conn, { brokerPassword: '***', apiToken: '***', Authorization: '***', clientSecret: '***', host: 'h' });
});

test('URL userinfo is stripped from messages and field values', () => {
  const { log, all } = make();
  log.info('bridge mqtt://user:pw123@10.0.0.5:1883/x', { url: 'wss://a:b@host/mqtt' });
  assert.ok(!all().includes('user:pw123'));
  assert.ok(!all().includes('a:b@'));
  assert.ok(all().includes('mqtt://***@10.0.0.5:1883/x'));
});

test('an Error field keeps message and code, redacted', () => {
  const { log, stderr } = make();
  log.redact('topsecret');
  const err = Object.assign(new Error('auth failed for topsecret'), { code: 'EAUTH' });
  log.error('boom', { err });
  const rec = JSON.parse(stderr.text());
  assert.equal(rec.err.code, 'EAUTH');
  assert.equal(rec.err.message, 'auth failed for ***');
});

test('json format: one object per line with time, level, category, msg', () => {
  const { log, stdout, stderr } = make();
  log.child('network').info('connected', { attempt: 2 });
  log.warn('slow');
  const rec = JSON.parse(stdout.text().trim());
  assert.equal(rec.level, 'info');
  assert.equal(rec.category, 'network');
  assert.equal(rec.msg, 'connected');
  assert.equal(rec.attempt, 2);
  assert.match(rec.time, /^\d{4}-\d\d-\d\dT/);
  assert.equal(JSON.parse(stderr.text().trim()).level, 'warn');
});

test('auto format: text on a TTY, JSON otherwise', () => {
  const tty = make({ format: 'auto', tty: true });
  tty.log.info('hello', { a: 1 });
  assert.match(tty.stdout.text(), /^\d{4}-.*Z INFO  \[system\] hello a=1\n$/);
  const pipe = make({ format: 'auto', tty: false });
  pipe.log.info('hello');
  assert.equal(JSON.parse(pipe.stdout.text()).msg, 'hello');
});

test('level threshold and setLevel', () => {
  const { log, all } = make({ level: 'warn' });
  log.info('quiet');
  assert.equal(all(), '');
  log.setLevel('debug');
  assert.equal(log.level, 'debug');
  log.debug('loud');
  assert.ok(all().includes('loud'));
});

test('the ring keeps the last 100 lines', () => {
  const { log } = make();
  for (let i = 0; i < 150; i++) log.info(`line ${i}`);
  const r = log.recent();
  assert.equal(r.length, 100);
  assert.equal(r[0].msg, 'line 50');
});

test('a tap listener that logs does not recurse', () => {
  const { log } = make();
  let calls = 0;
  log.tap(() => { calls++; log.info('from inside the tap'); });
  log.info('outer');
  assert.equal(calls, 1);
});

test('unsubscribe stops the tap', () => {
  const { log } = make();
  const got = [];
  const off = log.tap((l) => got.push(l));
  log.info('a');
  off();
  log.info('b');
  assert.equal(got.length, 1);
});
