import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublisher, cleanValues } from '../../src/core/publisher.js';
import {
  createFakeClock, createFakeTransport, createTopics, createValidators, createMemoryLogger, createMemoryBackfill, devId, flush,
} from '../_support/core-runtime/fakes.js';

function setup({ strict = true } = {}) {
  const clock = createFakeClock();
  const transport = createFakeTransport(clock);
  const backfill = createMemoryBackfill();
  const validators = createValidators();
  const log = createMemoryLogger();
  const pub = createPublisher({ transport, topics: createTopics(), validators, backfill, clock, log, strict });
  return { clock, transport, backfill, validators, log, pub };
}

const D = devId(1);

test('cleanValues keeps finite numbers, booleans and strings only', () => {
  assert.deepEqual(
    cleanValues({ a: 1.5, b: NaN, c: Infinity, d: -Infinity, e: null, f: undefined, g: {}, h: [1], i: true, j: 'on', k: 0 }),
    { a: 1.5, i: true, j: 'on', k: 0 },
  );
});

test('data: non-finite values are dropped; nothing left → no message', async () => {
  const { pub, transport, backfill } = setup();
  assert.equal(await pub.data({ deviceId: D, ts: 1, values: { a: NaN, b: null } }, { intervalMs: 5000 }), 'dropped');
  assert.equal(transport.sent.length, 0);
  assert.equal(backfill.records.length, 0);
  assert.equal(await pub.data({ deviceId: D, ts: 1, values: { a: NaN, b: 2 } }, { intervalMs: 5000 }), 'live');
  assert.deepEqual(transport.sent[0].body.values, { b: 2 });
});

test('data: integer ts, seq kept, live body validates against the data schema', async () => {
  const { pub, transport, validators, clock } = setup();
  await pub.data({ deviceId: D, ts: clock.now() + 0.7, values: { t: 21.5 }, seq: 7 }, { intervalMs: 5000 });
  const m = transport.sent[0];
  assert.equal(m.suffix, `devices/${D}/data`);
  assert.ok(Number.isInteger(m.body.ts));
  assert.equal(m.body.seq, 7);
  assert.equal(m.qos, 0);
  assert.equal(m.retain, false);
  assert.ok(validators.validate('data', m.body).ok);
});

test('data: nothing is handed to the transport while disconnected — it goes to backfill', async () => {
  const { pub, transport, backfill, validators } = setup();
  transport.connected = false;
  const publish = transport.publish;
  let calls = 0;
  transport.publish = (...a) => { calls++; return publish(...a); };
  assert.equal(await pub.data({ deviceId: D, ts: 5, values: { t: 1 }, seq: 0 }, { intervalMs: 5000 }), 'backfill');
  assert.equal(calls, 0);
  assert.deepEqual(backfill.records, [{ deviceId: D, ts: 5, values: { t: 1 }, seq: 0 }]);
  assert.ok(validators.validate('data-backfill', { batch: backfill.records }).ok);
});

test('data: backlogged while the previous message has no write callback', async () => {
  const { pub, transport, backfill, clock } = setup();
  transport.hold = true;
  const first = pub.data({ deviceId: D, ts: clock.now(), values: { t: 1 } }, { intervalMs: 5000 });
  await flush();
  await clock.advance(5000);
  assert.equal(await pub.data({ deviceId: D, ts: clock.now(), values: { t: 2 } }, { intervalMs: 5000 }), 'backfill');
  assert.equal(backfill.records.length, 1);
  transport.release();
  assert.equal(await first, 'live');
});

test('data: backlogged when the previous message was written less than I/2 ago', async () => {
  const { pub, backfill, clock } = setup();
  assert.equal(await pub.data({ deviceId: D, ts: clock.now(), values: { t: 1 } }, { intervalMs: 10000 }), 'live');
  await clock.advance(4999);
  assert.equal(await pub.data({ deviceId: D, ts: clock.now(), values: { t: 2 } }, { intervalMs: 10000 }), 'backfill');
  await clock.advance(1);
  assert.equal(await pub.data({ deviceId: D, ts: clock.now(), values: { t: 3 } }, { intervalMs: 10000 }), 'live');
  assert.equal(backfill.records.length, 1);
});

test('data: backlog is per device', async () => {
  const { pub } = setup();
  assert.equal(await pub.data({ deviceId: devId(1), ts: 1, values: { t: 1 } }, { intervalMs: 10000 }), 'live');
  assert.equal(await pub.data({ deviceId: devId(2), ts: 1, values: { t: 1 } }, { intervalMs: 10000 }), 'live');
});

test('data: a read-once reply bypasses the backlog check and does not count as the previous message', async () => {
  const { pub, clock } = setup();
  assert.equal(await pub.data({ deviceId: D, ts: clock.now(), values: { t: 1 } }, { intervalMs: 10000 }), 'live');
  await clock.advance(1000);
  assert.equal(await pub.data({ deviceId: D, ts: clock.now(), values: { t: 2 } }, { intervalMs: 10000, bypassBacklog: true }), 'live');
  await clock.advance(4000); // 5 s after the scheduled one, 4 s after the once reply
  assert.equal(await pub.data({ deviceId: D, ts: clock.now(), values: { t: 3 } }, { intervalMs: 10000 }), 'live');
});

test('data: a wall clock set back does not park the device in backfill', async () => {
  const { pub, clock } = setup();
  assert.equal(await pub.data({ deviceId: D, ts: clock.now(), values: { t: 1 } }, { intervalMs: 5000 }), 'live');
  clock.jump(-3600000);
  await clock.advance(5000);
  assert.equal(await pub.data({ deviceId: D, ts: clock.now(), values: { t: 2 } }, { intervalMs: 5000 }), 'live');
});

test('data: a publish that fails mid-way keeps the reading in backfill', async () => {
  const { pub, transport, backfill } = setup();
  transport.publish = () => Promise.reject(new Error('socket closed'));
  assert.equal(await pub.data({ deviceId: D, ts: 9, values: { t: 1 } }, { intervalMs: 5000 }), 'backfill');
  assert.equal(backfill.records.length, 1);
});

test('strict: an invalid uplink throws; non-strict logs and still sends', async () => {
  const s = setup({ strict: true });
  await assert.rejects(s.pub.gateway('gateway.status', { online: true, bogus: 1 }), /fails the protocol schema/);
  assert.equal(s.transport.sent.length, 0);
  const l = setup({ strict: false });
  assert.equal(await l.pub.gateway('gateway.status', { online: true, bogus: 1 }), true);
  assert.equal(l.transport.sent.length, 1);
  assert.ok(l.log.lines.some((x) => x.level === 'warn' && /fails the protocol schema/.test(x.msg)));
});

test('deviceStatus: retained, ts, reason only when unreachable and ≤128 chars', async () => {
  const { pub, transport, validators } = setup();
  await pub.deviceStatus(D, { reachable: true, reason: 'ignored' });
  await pub.deviceStatus(D, { reachable: false, reason: 'x'.repeat(300) });
  const [a, b] = transport.sent;
  assert.equal(a.retain, true);
  assert.deepEqual(Object.keys(a.body).sort(), ['reachable', 'ts']);
  assert.equal(b.body.reason.length, 128);
  assert.ok(validators.validate('device-status', a.body).ok && validators.validate('device-status', b.body).ok);
});

test('ack: shapes for ok, error, boolean and non-finite values', async () => {
  const { pub, transport, validators } = setup();
  await pub.ack(D, { correlationId: 'c1', status: 'ok', error: null, value: 3 });
  await pub.ack(D, { correlationId: 'c2', status: 'error', error: 'nope' });
  await pub.ack(D, { correlationId: 'c3', status: 'ok', value: true });
  await pub.ack(D, { correlationId: 'c4', status: 'ok', value: NaN });
  await pub.ack(D, { correlationId: 'c5', status: 'ok', value: 'text' });
  const b = transport.sent.map((m) => m.body);
  assert.deepEqual({ ...b[0], ts: 0 }, { correlationId: 'c1', status: 'ok', error: null, value: 3, ts: 0 });
  assert.equal(b[1].error, 'nope');
  assert.ok(!('value' in b[1]));
  assert.equal(b[2].value, 1);
  assert.equal(b[3].value, null);
  assert.ok(!('value' in b[4]));
  for (const x of b) assert.ok(validators.validate('cmd-ack', x).ok, JSON.stringify(x));
  assert.equal(transport.sent[0].suffix, `devices/${D}/cmd/ack`);
});

test('alert: message and code are bounded', async () => {
  const { pub, transport, validators } = setup();
  await pub.alert(D, { ts: 1, severity: 'warning', code: 'C'.repeat(80), message: 'm'.repeat(600), tag: 't', value: 1 });
  const b = transport.sent[0].body;
  assert.equal(b.code.length, 64);
  assert.equal(b.message.length, 512);
  assert.ok(validators.validate('alert', b).ok);
});

test('gateway: QoS/retain default from the topic table; accepts id, short id or suffix', async () => {
  const { pub, transport } = setup();
  await pub.gateway('gateway.status', { online: true });
  await pub.gateway('config-request', { hash: 0 });
  await pub.gateway('status', { online: false }, { qos: 1, retain: true });
  const [a, b, c] = transport.sent;
  assert.deepEqual([a.suffix, a.qos, a.retain], ['status', 0, true]);
  assert.deepEqual([b.suffix, b.qos, b.retain], ['config/request', 0, false]);
  assert.deepEqual([c.suffix, c.qos, c.retain], ['status', 1, true]);
  await assert.rejects(pub.gateway('config-push', {}), /unknown uplink/);
});

test('gateway/alert/ack/status resolve false while disconnected', async () => {
  const { pub, transport } = setup();
  transport.connected = false;
  assert.equal(await pub.gateway('gateway.status', { online: true }), false);
  assert.equal(await pub.alert(D, { ts: 1, severity: 'info', code: 'X' }), false);
  assert.equal(await pub.ack(D, { correlationId: 'c', status: 'ok' }), false);
  assert.equal(await pub.deviceStatus(D, { reachable: true }), false);
  assert.equal(transport.sent.length, 0);
});
