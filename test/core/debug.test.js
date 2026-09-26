import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebug, TAIL_WINDOW_MS } from '../../src/core/debug.js';
import { createLogger } from '../../src/core/log.js';
import { createPublisher } from '../../src/core/publisher.js';
import {
  createFakeClock, createFakeTransport, createTopics, createValidators, devId, flush,
} from '../_support/core-runtime/fakes.js';

const nullStream = () => ({ isTTY: false, write() { return true; } });

function setup({ devices = [] } = {}) {
  const clock = createFakeClock();
  const transport = createFakeTransport(clock);
  const validators = createValidators();
  const log = createLogger({ level: 'debug', format: 'json', stdout: nullStream(), stderr: nullStream(), clock });
  const publisher = createPublisher({ transport, topics: createTopics(), validators, clock, log, strict: true });
  const dbg = createDebug({
    publisher, log, clock, version: '0.1.0',
    snapshot: () => ({ configHash: 3420619844, connected: true, devices }),
    netInfo: () => ({ ip: '192.168.1.50', uplink: 'wifi' }),
    uptimeMs: () => 123456,
    memory: () => ({ heapTotal: 10_000_000, heapUsed: 6_000_000 }),
  });
  const batches = () => transport.bySuffix('debug/log').map((m) => m.body);
  return { clock, transport, validators, log, dbg, batches };
}

test('diag: schema-valid, echoes the correlationId, ids and protocols only — no names, no conn, no secrets', async () => {
  const devices = Array.from({ length: 250 }, (_, i) => ({
    id: devId(i), protocol: 'modbus-tcp', reachable: i % 2 === 0, reason: 'timeout', lastPollAt: Date.UTC(2026, 8, 26, 9, 59, 50),
    lastError: 'e'.repeat(400), intervalMs: 5000, paused: i === 3 ? 'manual' : null,
    name: 'Boiler room meter', conn: { ip: '10.0.0.5', password: 'pw' },
  }));
  const s = setup({ devices });
  s.log.redact('pw-secret-1');
  for (let i = 0; i < 130; i++) s.log.info(`line ${i} pw-secret-1 ${'x'.repeat(i === 5 ? 900 : 1)}`);
  await s.dbg.diag('corr-123');
  const [m] = s.transport.bySuffix('debug/response');
  const b = m.body;
  assert.ok(s.validators.validate('debug-response', b).ok, JSON.stringify(s.validators.validate('debug-response', b).errors));
  assert.equal(b.correlationId, 'corr-123');
  assert.equal(b.fw, '0.1.0');
  assert.equal(b.configHash, 3420619844);
  assert.equal(b.uptimeMs, 123456);
  assert.equal(b.freeHeap, 4_000_000);
  assert.equal(b.uplink, 'wifi');
  assert.equal(b.devices.length, 200);
  assert.equal(b.devices[0].lastPollMs, 10000);
  assert.equal(b.devices[3].online, true, 'a paused device is online');
  assert.equal(b.devices[1].online, false);
  assert.ok(b.devices.every((d) => d.lastError.length <= 256));
  assert.equal(b.recentLogs.length, 100);
  assert.ok(b.recentLogs.every((l) => l.length <= 512));
  const text = m.text;
  for (const bad of ['Boiler room', '10.0.0.5', 'pw-secret-1', '"conn"', '"name"']) assert.ok(!text.includes(bad), `leaked ${bad}`);
});

test('tail: only the selected categories (system always on), ≤50 lines per 1 s flush, redacted', async () => {
  const s = setup();
  s.log.redact('hunter2');
  s.dbg.startLogs(8); // modbus (+ system)
  s.log.child('modbus').info('read ok hunter2');
  s.log.child('network').info('reconnect');
  s.log.child('commands').info('cmd');
  s.log.info('lifecycle');
  await s.clock.advance(1000);
  const [b] = s.batches();
  assert.ok(s.validators.validate('debug-log', b).ok);
  const joined = b.lines.join('\n');
  assert.match(joined, /\[system\] debug log tail started \(modbus\)/);
  assert.match(joined, /\[modbus\] read ok \*\*\*/);
  assert.match(joined, /\[system\] lifecycle/);
  assert.ok(!/reconnect|\[commands\]|hunter2/.test(joined));
  s.dbg.stop();
});

test('tail: token bucket 20 lines/s with burst 40; overflow is reported as one dropped line', async () => {
  const s = setup();
  s.dbg.startLogs(1);
  for (let i = 0; i < 100; i++) s.log.info(`burst ${i}`);
  await s.clock.advance(1000);
  const [b] = s.batches();
  // 40 tokens: the "started" line + 39 of the burst; the other 61 are reported as one line.
  assert.equal(b.lines.length, 41);
  assert.match(b.lines[0], /… 61 lines dropped \(rate limit\)/);
  assert.equal(b.lines.filter((l) => /burst/.test(l)).length, 39);
  for (const x of s.batches()) {
    assert.ok(x.lines.length <= 50);
    assert.ok(s.validators.validate('debug-log', x).ok);
  }
  // Sustained 50 lines/s for 10 s → about 20/s get through.
  for (let t = 0; t < 10; t++) {
    for (let i = 0; i < 50; i++) s.log.info(`steady ${t}.${i}`);
    await s.clock.advance(1000);
  }
  const streamed = s.batches().slice(1).flatMap((x) => x.lines).filter((l) => /steady/.test(l)).length;
  assert.ok(streamed >= 200 && streamed <= 240, `streamed ${streamed}`);
  s.dbg.stop();
});

test('tail: batches carry an increasing seq, lines are at most 512 chars', async () => {
  const s = setup();
  s.dbg.startLogs(1);
  s.log.info('y'.repeat(2000));
  await s.clock.advance(1000);
  s.log.info('second');
  await s.clock.advance(1000);
  const b = s.batches();
  assert.deepEqual(b.map((x) => x.seq), [0, 1]);
  assert.ok(b[0].lines.every((l) => l.length <= 512));
  s.dbg.stop();
});

test('tail: 5-minute window, extended by a re-start, then auto-stopped', async () => {
  const s = setup();
  s.dbg.startLogs(1);
  await s.clock.advance(4 * 60000);
  s.dbg.startLogs(3); // re-scope + extend
  await s.clock.advance(TAIL_WINDOW_MS - 1000);
  assert.equal(s.dbg.tailActive, true);
  await s.clock.advance(2000);
  assert.equal(s.dbg.tailActive, false);
  const n = s.batches().length;
  s.log.info('after the window');
  await s.clock.advance(5000);
  assert.equal(s.batches().length, n);
  assert.equal(s.clock.pending(), 0, 'the flush timer is gone');
});

test('tail: stop ends it; a flush while offline keeps the lines for the next one', async () => {
  const s = setup();
  s.dbg.startLogs(1);
  s.transport.connected = false;
  s.log.info('during the outage');
  await s.clock.advance(3000);
  assert.equal(s.batches().length, 0);
  s.transport.connected = true;
  await s.clock.advance(1000);
  assert.match(s.batches()[0].lines.join('\n'), /during the outage/);
  s.dbg.stopLogs();
  s.log.info('after stop');
  await s.clock.advance(3000);
  assert.ok(!s.batches().flatMap((b) => b.lines).some((l) => /after stop/.test(l)));
});

test('start without a mask (older platform) = system + commands', async () => {
  const s = setup();
  s.dbg.startLogs(undefined);
  s.log.child('commands').info('a command');
  s.log.child('modbus').info('a read');
  await s.clock.advance(1000);
  const joined = s.batches()[0].lines.join('\n');
  assert.match(joined, /a command/);
  assert.ok(!/a read/.test(joined));
  s.dbg.stop();
  await flush();
});
