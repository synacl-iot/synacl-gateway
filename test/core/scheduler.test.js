import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, NOT_IN_CONFIG } from '../../src/core/scheduler.js';
import { createPublisher } from '../../src/core/publisher.js';
import { createThresholds } from '../../src/core/thresholds.js';
import { createSim } from '../../src/core/sim.js';
import {
  createFakeClock, createFakeTransport, createTopics, createValidators, createMemoryLogger, createMemoryBackfill,
  createMemoryState, device, devId, flush,
} from '../_support/core-runtime/fakes.js';
import { createFakeDriver, prng } from '../_support/core-runtime/fake-driver.js';

function setup({ driver: driverOpts = {}, minIntervalMs = 250, state = createMemoryState(), sim = null } = {}) {
  const clock = createFakeClock();
  const transport = createFakeTransport(clock);
  const log = createMemoryLogger();
  const backfill = createMemoryBackfill();
  const publisher = createPublisher({ transport, topics: createTopics(), validators: createValidators(), backfill, clock, log, strict: true });
  const thresholds = createThresholds({ publisher, clock, log });
  const evaluated = [];
  const th = { ...thresholds, evaluate: (d, v, ts) => { evaluated.push({ id: d.id, values: v, ts }); thresholds.evaluate(d, v, ts); } };
  const driver = createFakeDriver(clock, driverOpts);
  const reach = [];
  const sched = createScheduler({
    clock, log, drivers: driver.registry, publisher, thresholds: th, state, minIntervalMs, sim,
    onReachability: (id, s) => reach.push({ id, ...s, at: clock.now() }),
  });
  const data = (id) => transport.bySuffix(id ? `devices/${id}/data` : /^devices\/[^/]+\/data$/);
  const acks = (id) => transport.bySuffix(`devices/${id}/cmd/ack`).map((m) => m.body);
  return { clock, transport, log, backfill, publisher, sched, driver, reach, evaluated, state, data, acks };
}

function gaps(msgs) {
  const out = [];
  for (let i = 1; i < msgs.length; i++) out.push(msgs[i].body.ts - msgs[i - 1].body.ts);
  return out;
}

// ─── pacing ────────────────────────────────────────────────────────────────────────────

test('1000 jittered ticks per device: ts spacing never below the interval, no overlapping reads', async () => {
  const rand = prng(42);
  const s = setup({
    // 0–1100 ms: mostly inside the 800–1200 ms timeouts (0.8 × I), some beyond them.
    driver: { duration: () => Math.floor(rand() * 1100) },
  });
  const ids = [devId(1), devId(2), devId(3)];
  const I = (k) => 1000 + k * 250;
  await s.sched.apply(ids.map((id, k) => device(id, { intervalMs: I(k) })));
  await s.clock.advance(1000 * I(2) + 10000);
  for (const [k, id] of ids.entries()) {
    const reads = s.driver.stats.reads.filter((r) => r.deviceId === id);
    assert.ok(reads.length >= 1000, `device ${k}: only ${reads.length} ticks`);
    // Every reading, live or deferred to backfill, is at least one interval after the previous.
    const all = [...s.data(id).map((m) => m.body.ts), ...s.backfill.records.filter((r) => r.deviceId === id).map((r) => r.ts)].sort((a, b) => a - b);
    const g = all.slice(1).map((t, i) => t - all[i]);
    assert.ok(g.every((x) => x >= I(k)), `device ${k}: min ts gap ${Math.min(...g)} < ${I(k)}`);
    // Jittered read durations shrink ARRIVAL gaps; the publisher defers any reading that would
    // land within I/2 of the previous live one, so live wire gaps never drop below I/2.
    const wireAt = s.data(id).map((m) => m.at);
    const wg = wireAt.slice(1).map((t, i) => t - wireAt[i]);
    assert.ok(wg.every((x) => x >= I(k) / 2), `device ${k}: live wire gap ${Math.min(...wg)} < I/2`);
    for (const m of s.data(id)) assert.ok(Number.isInteger(m.body.ts));
  }
  assert.equal(s.driver.stats.overlaps, 0);
  await s.sched.stop();
});

test('steady read durations: every reading goes out live, exactly one interval apart', async () => {
  const s = setup({ driver: { duration: () => 120 } });
  await s.sched.apply([device(devId(1), { intervalMs: 2000 })]);
  await s.clock.advance(2000 * 1000);
  const g = gaps(s.data(devId(1)));
  assert.ok(g.length >= 998);
  assert.ok(g.every((x) => x === 2000));
  assert.equal(s.backfill.records.length, 0);
  await s.sched.stop();
});

test('stagger: newcomers spread across min(I, 10 s), grouped by interval', async () => {
  const s = setup();
  const t0 = s.clock.now();
  await s.sched.apply([
    device(devId(1), { intervalMs: 5000 }), device(devId(2), { intervalMs: 5000 }), device(devId(3), { intervalMs: 5000 }),
    device(devId(4), { intervalMs: 60000 }), device(devId(5), { intervalMs: 60000 }),
  ]);
  await s.clock.advance(10000);
  const first = (id) => s.driver.stats.reads.find((r) => r.deviceId === id).at - t0;
  assert.deepEqual([1, 2, 3].map((n) => first(devId(n))), [1250, 2500, 3750]);
  assert.deepEqual([4, 5].map((n) => first(devId(n))), [3333, 6667]);
  await s.sched.stop();
});

test('a read slower than the interval: the overlapping tick is skipped, never run concurrently', async () => {
  const s = setup({ driver: { duration: (id, tags, reason) => (reason === 'interval' ? 2500 : 0) } });
  await s.sched.apply([device(devId(1), { intervalMs: 1000 })]);
  await s.clock.advance(20000);
  assert.equal(s.driver.stats.overlaps, 0);
  const reads = s.driver.stats.reads;
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i].at >= reads[i - 1].endedAt, 'a read started before the previous one returned');
  // The driver never returns within 0.8 × I, so every read times out: no data, device unreachable.
  assert.equal(s.data().length, 0);
  assert.equal(s.reach.at(-1).reachable, false);
  assert.equal(s.reach.at(-1).reason, 'timeout');
  assert.ok(reads.every((r) => r.aborted));
  await s.sched.stop();
});

test('failure backoff: the delay doubles after 3 failures, capped at max(I, 60 s); recovery resets it', async () => {
  let up = false;
  const s = setup({ driver: { result: (id, tags) => (up ? { values: { [tags[0].name]: 1 }, reachable: true } : { values: {}, reachable: false, reason: 'modbus/timeout' }) } });
  await s.sched.apply([device(devId(1), { intervalMs: 5000 })]);
  await s.clock.advance(5000 + 300000);
  const at = s.driver.stats.reads.map((r) => r.at);
  const g = at.slice(1).map((t, i) => t - at[i]);
  assert.deepEqual(g.slice(0, 7), [5000, 5000, 10000, 20000, 40000, 60000, 60000]);
  up = true;
  await s.clock.advance(60000);
  const n = s.driver.stats.reads.length;
  await s.clock.advance(20000);
  assert.equal(s.driver.stats.reads.length - n, 4, 'back to one read per interval');
  assert.deepEqual(s.reach.map((r) => r.reachable), [false, true]);
  assert.equal(s.reach[0].reason, 'modbus/timeout');
  await s.sched.stop();
});

test('the wall clock going backwards by more than I resets the baseline instead of stalling', async () => {
  const s = setup();
  await s.sched.apply([device(devId(1), { intervalMs: 5000 })]);
  await s.clock.advance(30000);
  const before = s.data().length;
  s.clock.jump(-3600000);
  await s.clock.advance(12000);
  assert.ok(s.data().length - before >= 2, 'reads continue at the interval after the jump');
  assert.ok(s.log.lines.some((l) => /went backwards/.test(l.msg)));
  const after = s.data().slice(before);
  assert.ok(gaps(after).every((x) => x >= 5000));
  await s.sched.stop();
});

test('a small backwards step (< I) only delays the next tick; spacing still holds', async () => {
  const s = setup();
  await s.sched.apply([device(devId(1), { intervalMs: 5000 })]);
  await s.clock.advance(20000);
  s.clock.jump(-2000);
  await s.clock.advance(20000);
  assert.ok(gaps(s.data()).every((x) => x >= 5000));
  await s.sched.stop();
});

test('an early timer is re-armed for the remainder', async () => {
  const s = setup();
  await s.sched.apply([device(devId(1), { intervalMs: 5000 })]);
  await s.clock.advance(10000);
  // Step the wall clock FORWARD-then-back so the pending timer fires "early" in wall terms.
  s.clock.jump(-1500);
  await s.clock.advance(15000);
  assert.ok(gaps(s.data()).every((x) => x >= 5000));
  await s.sched.stop();
});

// ─── configuration changes ─────────────────────────────────────────────────────────────

test('apply: unchanged devices keep their handle; changed ones reopen but keep pacing; removed ones close', async () => {
  const s = setup();
  const a = device(devId(1), { intervalMs: 5000 });
  const b = device(devId(2), { intervalMs: 5000 });
  await s.sched.apply([a, b]);
  await s.clock.advance(12000);
  assert.equal(s.driver.stats.opens, 2);
  await s.sched.apply([a, b]);
  assert.equal(s.driver.stats.opens, 2, 'same fingerprint → same handle');

  const b2 = device(devId(2), { intervalMs: 5000, conn: { ip: '10.0.0.9' } });
  const lastB = s.data(devId(2)).at(-1).body.ts;
  await s.sched.apply([a, b2]);
  assert.equal(s.driver.stats.closes, 1);
  await s.clock.advance(20000);
  assert.equal(s.driver.stats.opens, 3);
  const nextB = s.data(devId(2)).find((m) => m.body.ts > lastB).body.ts;
  assert.ok(nextB - lastB >= 5000, 'a reconfigured device is never published early');

  await s.sched.apply([a]);
  assert.equal(s.driver.stats.closes, 2);
  const n = s.data(devId(2)).length;
  await s.clock.advance(20000);
  assert.equal(s.data(devId(2)).length, n);
  assert.deepEqual(s.sched.snapshot().map((d) => d.id), [devId(1)]);
  await s.sched.stop();
});

test('unsupported protocol → reachable:false with the reason, no reads', async () => {
  const s = setup();
  await s.sched.apply([device(devId(1), { protocol: 'zigbee' })]);
  await s.clock.advance(30000);
  assert.deepEqual(s.reach[0], { id: devId(1), reachable: false, reason: 'unsupported protocol: zigbee', at: s.reach[0].at });
  assert.equal(s.driver.stats.reads.length, 0);
  assert.equal(s.sched.snapshot()[0].supported, false);
  assert.equal(s.data().length, 0);
  await s.sched.stop();
});

test('isIntervalRead:false tags are never part of regular data', async () => {
  const s = setup();
  await s.sched.apply([device(devId(1), { intervalMs: 1000, tags: [{ name: 'a' }, { name: 'ondemand', isIntervalRead: false }] })]);
  await s.clock.advance(10000);
  assert.ok(s.data().length > 5);
  assert.ok(s.data().every((m) => !('ondemand' in m.body.values)));
  assert.ok(s.driver.stats.reads.every((r) => !r.tags.includes('ondemand')));
  await s.sched.stop();
});

test('thresholds are evaluated on every successful reading', async () => {
  const s = setup();
  await s.sched.apply([device(devId(1), { intervalMs: 1000 })]);
  await s.clock.advance(5000);
  assert.equal(s.evaluated.length, s.data().length);
  await s.sched.stop();
});

test('reachable → unreachable resets the device threshold state', async () => {
  let up = true;
  const s = setup({ driver: { result: (id, tags) => (up ? { values: { [tags[0].name]: 90 }, reachable: true } : { values: {}, reachable: false }) } });
  await s.sched.apply([device(devId(1), { intervalMs: 1000, tags: [{ name: 't', thresholdStart: 10, thresholdEnd: 80 }] })]);
  await s.clock.advance(3000);
  up = false;
  await s.clock.advance(2000);
  up = true;
  await s.clock.advance(3000);
  const alerts = s.transport.bySuffix(`devices/${devId(1)}/alert`).map((m) => m.body.code);
  assert.deepEqual(alerts, ['THRESHOLD_VIOLATION', 'THRESHOLD_VIOLATION']);
  await s.sched.stop();
});

test('readIntervalMs: sampled in between for thresholds, data still once per interval', async () => {
  let v = 50;
  const s = setup({ driver: { duration: () => 300, result: (id, tags) => ({ values: { [tags[0].name]: v }, reachable: true }) } });
  const id = devId(1);
  const d = { ...device(id, { intervalMs: 10000, tags: [{ name: 't', thresholdStart: 0, thresholdEnd: 80 }] }), readIntervalMs: 2000 };
  await s.sched.apply([d]);
  await s.clock.advance(20000);
  const dataBefore = s.data(id).length;
  v = 95; // leaves the band between two publishes
  await s.clock.advance(2100);
  const alerts = s.transport.bySuffix(`devices/${id}/alert`);
  assert.equal(alerts.length, 1, 'the sampling read raised the alarm');
  assert.equal(s.data(id).length, dataBefore, 'without publishing data');
  await s.clock.advance(60000);
  const g = gaps(s.data(id));
  assert.ok(g.every((x) => x >= 10000), `data gaps ${g}`);
  assert.ok(g.filter((x) => x === 10000).length >= g.length - 1, 'sampling never pushes a publish back by an interval');
  const reads = s.driver.stats.reads.filter((r) => r.at > s.clock.now() - 60000).length;
  assert.ok(reads >= 25, `only ${reads} reads in 60 s`);
  assert.equal(s.driver.stats.overlaps, 0);
  await s.sched.stop();
  await s.clock.advance(1000); // a read in flight at stop() finishes; nothing re-arms after it
  assert.equal(s.clock.pending(), 0);
});

test('readIntervalMs not below the publish interval: no extra reads', async () => {
  const s = setup();
  const id = devId(1);
  await s.sched.apply([{ ...device(id, { intervalMs: 2000 }), readIntervalMs: 5000 }]);
  await s.clock.advance(20000);
  assert.equal(s.driver.stats.reads.length, s.data(id).length);
  await s.sched.stop();
});

// ─── read/once ─────────────────────────────────────────────────────────────────────────

test('read/once: data carrying only the tag goes out immediately, then the ack', async () => {
  const s = setup();
  const id = devId(1);
  await s.sched.apply([device(id, { intervalMs: 10000, tags: [{ name: 'a' }, { name: 'b' }] })]);
  await s.clock.advance(6000); // first scheduled data at +5000
  const before = s.transport.sent.length;
  await s.sched.readOnce(id, 'b', 'corr-1');
  const out = s.transport.sent.slice(before);
  assert.deepEqual(out.map((m) => m.suffix), [`devices/${id}/data`, `devices/${id}/cmd/ack`]);
  assert.deepEqual(Object.keys(out[0].body.values), ['b']);
  const ack = out[1].body;
  assert.equal(ack.correlationId, 'corr-1');
  assert.equal(ack.status, 'ok');
  assert.equal(ack.error, null);
  assert.equal(ack.value, out[0].body.values.b);
  assert.equal(ack.ts, out[0].body.ts);
  // Published only 1 s after the scheduled message: outside the pacing check by design.
  assert.equal(s.backfill.records.length, 0);
  await s.sched.stop();
});

test('read/once reads an isIntervalRead:false tag', async () => {
  const s = setup();
  const id = devId(1);
  await s.sched.apply([device(id, { tags: [{ name: 'a' }, { name: 'od', isIntervalRead: false }] })]);
  await s.sched.readOnce(id, 'od', 'c');
  assert.deepEqual(Object.keys(s.data(id)[0].body.values), ['od']);
  assert.equal(s.acks(id)[0].status, 'ok');
  assert.equal(s.driver.stats.reads[0].reason, 'once');
  await s.sched.stop();
});

test('read/once: unknown tag and unknown device → error acks, no read', async () => {
  const s = setup();
  const id = devId(1);
  await s.sched.apply([device(id)]);
  await s.sched.readOnce(id, 'nope', 'c1');
  await s.sched.readOnce(devId(9), 'a', 'c2');
  assert.deepEqual(s.acks(id)[0], { ...s.acks(id)[0], status: 'error', error: 'tag "nope" not found' });
  assert.equal(s.acks(devId(9))[0].error, NOT_IN_CONFIG);
  assert.equal(s.driver.stats.reads.length, 0);
  await s.sched.stop();
});

test('read/once failure: no data, error ack', async () => {
  const s = setup({ driver: { result: () => ({ values: {}, reachable: false, reason: 'modbus/timeout' }) } });
  const id = devId(1);
  await s.sched.apply([device(id)]);
  await s.sched.readOnce(id, 't1', 'c');
  assert.equal(s.data(id).length, 0);
  assert.equal(s.acks(id)[0].status, 'error');
  assert.match(s.acks(id)[0].error, /modbus\/timeout/);
  await s.sched.stop();
});

test('read/once: a driver\'s per-tag reason is the ack error as-is', async () => {
  const s = setup({ driver: { result: () => ({ values: {}, errors: { t1: 'no message received yet on tele/plug1/SENSOR' }, reachable: true }) } });
  const id = devId(1);
  await s.sched.apply([device(id)]);
  await s.sched.readOnce(id, 't1', 'c');
  assert.equal(s.acks(id)[0].error, 'no message received yet on tele/plug1/SENSOR');
  await s.sched.stop();
});

test('read/once without a correlationId: data, no ack', async () => {
  const s = setup();
  const id = devId(1);
  await s.sched.apply([device(id)]);
  await s.sched.readOnce(id, 't1', null);
  assert.equal(s.data(id).length, 1);
  assert.equal(s.acks(id).length, 0);
  await s.sched.stop();
});

test('race: a scheduled read in flight that carries the tag and goes live IS the reply', async () => {
  const s = setup({ driver: { duration: () => 400 } });
  const id = devId(1);
  await s.sched.apply([device(id, { intervalMs: 5000, tags: [{ name: 'a' }] })]);
  await s.clock.advance(2500 + 100); // the first scheduled read (at +2500) is in flight
  assert.equal(s.driver.stats.reads.length, 1);
  const p = s.sched.readOnce(id, 'a', 'corr');
  await s.clock.advance(400);
  await p;
  assert.equal(s.driver.stats.reads.length, 1, 'no second read');
  assert.equal(s.data(id).length, 1);
  const ack = s.acks(id)[0];
  assert.equal(ack.status, 'ok');
  assert.equal(ack.value, s.data(id)[0].body.values.a);
  await s.sched.stop();
});

test('race: a scheduled read in flight WITHOUT the tag is awaited, then the tag is read on its own', async () => {
  const s = setup({ driver: { duration: () => 400 } });
  const id = devId(1);
  await s.sched.apply([device(id, { intervalMs: 5000, tags: [{ name: 'a' }, { name: 'od', isIntervalRead: false }] })]);
  await s.clock.advance(2600);
  const p = s.sched.readOnce(id, 'od', 'corr');
  await s.clock.advance(1000);
  await p;
  assert.equal(s.driver.stats.overlaps, 0);
  assert.deepEqual(s.driver.stats.reads.map((r) => r.reason), ['interval', 'once']);
  const [sched, once] = s.data(id).map((m) => Object.keys(m.body.values));
  assert.deepEqual([sched, once], [['a'], ['od']]);
  await s.sched.stop();
});

test('race: a scheduled read that went to backfill does not answer — the tag is re-read live', async () => {
  const s = setup({ driver: { duration: () => 400 } });
  const id = devId(1);
  await s.sched.apply([device(id, { intervalMs: 5000, tags: [{ name: 'a' }] })]);
  await s.clock.advance(2600);
  s.transport.connected = false;
  const p = s.sched.readOnce(id, 'a', 'corr');
  await s.clock.advance(300);
  s.transport.connected = true; // back before the once-read
  await s.clock.advance(1000);
  await p;
  assert.equal(s.backfill.records.length, 1);
  assert.deepEqual(s.driver.stats.reads.map((r) => r.reason), ['interval', 'once']);
  assert.equal(s.acks(id)[0].status, 'ok');
  await s.sched.stop();
});

test('race: while a read-once is pending, the scheduled tick is held; pacing resumes after the ack', async () => {
  const s = setup({ driver: { duration: (id, tags, reason) => (reason === 'once' ? 4000 : 0) } });
  const id = devId(1);
  await s.sched.apply([device(id, { intervalMs: 1000, tags: [{ name: 'a' }, { name: 'od', isIntervalRead: false }] })]);
  await s.clock.advance(3000);
  const p = s.sched.readOnce(id, 'od', 'corr');
  await s.clock.advance(1);
  const heldFrom = s.clock.now();
  await s.clock.advance(4200);
  await p;
  const ackAt = s.transport.sent.find((m) => m.suffix.endsWith('/cmd/ack')).at;
  const during = s.data(id).filter((m) => m.at > heldFrom && m.at < ackAt && 'a' in m.body.values);
  assert.equal(during.length, 0, 'no scheduled data while the read-once is pending');
  await s.clock.advance(5000);
  const scheduled = s.data(id).filter((m) => 'a' in m.body.values);
  assert.ok(scheduled.at(-1).at > ackAt, 'the schedule resumed');
  assert.ok(gaps(scheduled).every((x) => x >= 1000));
  assert.equal(s.driver.stats.overlaps, 0);
  await s.sched.stop();
});

test('a wedged transport never parks the schedule behind a read-once', async () => {
  const s = setup();
  const id = devId(1);
  await s.sched.apply([device(id, { intervalMs: 1000 })]);
  await s.clock.advance(3000);
  s.transport.hold = true; // writes never complete from here on
  s.sched.readOnce(id, 't1', 'c');
  await s.clock.advance(1000);
  const n = s.driver.stats.reads.length;
  await s.clock.advance(31000);
  assert.ok(s.driver.stats.reads.length - n >= 1, 'reads resumed after the read-once budget');
  assert.ok(s.backfill.records.length >= 1, 'readings behind the wedged write go to backfill');
  s.transport.release();
  s.transport.hold = false;
  await s.sched.stop();
});

test('read/once readings are evaluated against the band too', async () => {
  const s = setup({ driver: { result: (id, tags) => ({ values: { [tags[0].name]: 99 }, reachable: true }) } });
  const id = devId(1);
  await s.sched.apply([device(id, { tags: [{ name: 't', isIntervalRead: false, thresholdStart: 10, thresholdEnd: 80 }] })]);
  await s.sched.readOnce(id, 't', 'c');
  await flush();
  assert.equal(s.transport.bySuffix(`devices/${id}/alert`).length, 1);
  await s.sched.stop();
});

// ─── pause / interval ──────────────────────────────────────────────────────────────────

test('pause manual: no reads, persisted, survives a restart; read/enable reads promptly', async () => {
  const state = createMemoryState();
  const s = setup({ state });
  const id = devId(1);
  await s.sched.apply([device(id, { intervalMs: 5000 })]);
  await s.clock.advance(6000);
  s.sched.pause(id, 'manual');
  assert.deepEqual(state.overrides.devices[id].read, { enabled: false, mode: 'manual' });
  const n = s.driver.stats.reads.length;
  await s.clock.advance(60000);
  assert.equal(s.driver.stats.reads.length, n);
  assert.equal(s.sched.snapshot()[0].paused, 'manual');
  await s.sched.stop();

  // a new process with the same state starts paused
  const s2 = setup({ state });
  await s2.sched.apply([device(id, { intervalMs: 5000 })]);
  await s2.clock.advance(30000);
  assert.equal(s2.driver.stats.reads.length, 0);
  s2.sched.resume(id);
  await s2.clock.advance(1);
  assert.equal(s2.driver.stats.reads.length, 1, 'read promptly on resume');
  assert.equal(state.overrides.devices[id]?.read, undefined);
  await s2.sched.stop();
});

test('pause restart: in memory only', async () => {
  const state = createMemoryState();
  const s = setup({ state });
  const id = devId(1);
  await s.sched.apply([device(id)]);
  s.sched.pause(id, 'restart');
  assert.equal(state.overrides.devices[id], undefined);
  await s.clock.advance(30000);
  assert.equal(s.driver.stats.reads.length, 0);
  await s.sched.stop();
  const s2 = setup({ state });
  await s2.sched.apply([device(id)]);
  await s2.clock.advance(10000);
  assert.ok(s2.driver.stats.reads.length > 0);
  await s2.sched.stop();
});

test('pause timed: resumes on its own, persisted with until, cleared after', async () => {
  const state = createMemoryState();
  const s = setup({ state });
  const id = devId(1);
  await s.sched.apply([device(id, { intervalMs: 5000 })]);
  await s.clock.advance(6000);
  s.sched.pause(id, 'timed', 30000);
  assert.equal(state.overrides.devices[id].read.mode, 'timed');
  assert.equal(state.overrides.devices[id].read.until, s.clock.now() + 30000);
  const n = s.driver.stats.reads.length;
  await s.clock.advance(29999);
  assert.equal(s.driver.stats.reads.length, n);
  await s.clock.advance(2);
  assert.equal(s.driver.stats.reads.length, n + 1);
  assert.equal(state.overrides.devices[id]?.read, undefined);
  await s.sched.stop();
});

test('a paused device keeps its reachability (presence reports it online)', async () => {
  const s = setup();
  const id = devId(1);
  await s.sched.apply([device(id, { intervalMs: 1000 })]);
  await s.clock.advance(2000);
  s.sched.pause(id, 'manual');
  const snap = s.sched.snapshot()[0];
  assert.equal(snap.paused, 'manual');
  assert.equal(snap.reachable, true);
  await s.sched.stop();
});

test('setInterval: clamped to the floor and ceiling, persisted, applied live', async () => {
  const state = createMemoryState();
  const s = setup({ state, minIntervalMs: 1000 });
  const id = devId(1);
  await s.sched.apply([device(id, { intervalMs: 10000 })]);
  await s.clock.advance(6000);
  s.sched.setInterval(id, 100);
  assert.equal(s.sched.snapshot()[0].intervalMs, 1000);
  assert.equal(state.overrides.devices[id].intervalMs, 1000);
  assert.equal(state.overrides.devices[id].intervalSetAt, s.clock.now());
  const n = s.data(id).length;
  await s.clock.advance(10000);
  assert.ok(s.data(id).length - n >= 9);
  assert.ok(gaps(s.data(id)).every((x) => x >= 1000));
  s.sched.setInterval(id, 5e6);
  assert.equal(s.sched.snapshot()[0].intervalMs, 3600000);
  await s.sched.stop();
});

// ─── writes, seq, sim ──────────────────────────────────────────────────────────────────

test('write: passes to the driver; not in config and no-write drivers get an error naming the protocol', async () => {
  const s = setup();
  await s.sched.apply([device(devId(1))]);
  assert.deepEqual(await s.sched.write(devId(1), { kind: 'modbus', registerType: 'coil', address: 3, value: 1 }), { ok: true, value: 1 });
  assert.deepEqual(await s.sched.write(devId(9), { kind: 'modbus', registerType: 'coil', address: 3, value: 1 }), { ok: false, error: NOT_IN_CONFIG });
  await s.sched.stop();

  const ro = setup({ driver: { writable: false } });
  await ro.sched.apply([device(devId(1))]);
  assert.deepEqual(await ro.sched.write(devId(1), { kind: 'modbus', registerType: 'holding', address: 3, value: 1 }),
    { ok: false, error: 'modbus writes are not supported for protocol "fake"' });
  assert.deepEqual(await ro.sched.write(devId(1), { kind: 'actuator', value: 1 }),
    { ok: false, error: 'actuator writes are not supported for protocol "fake"' });
  await ro.sched.stop();
});

test('seq: per device, loaded +1000 across restarts, persisted on stop', async () => {
  const state = createMemoryState({ seq: { v: 1, devices: { [devId(1)]: 41 } } });
  const s = setup({ state });
  await s.sched.apply([device(devId(1), { intervalMs: 1000 }), device(devId(2), { intervalMs: 1000 })]);
  await s.clock.advance(3000);
  assert.equal(s.data(devId(1))[0].body.seq, 1041);
  assert.equal(s.data(devId(2))[0].body.seq, 0);
  await s.sched.stop();
  assert.equal(state.seq.devices[devId(1)], 1041 + s.data(devId(1)).length);
  assert.equal(state.seq.devices[devId(2)], s.data(devId(2)).length);
});

test('sim mode: synthetic readings for every device, including unsupported ones', async () => {
  const simulator = createSim({ clock: createFakeClock() });
  const t = setup({ sim: simulator });
  simulator.start();
  await t.sched.apply([device(devId(1), { intervalMs: 1000 }), device(devId(2), { protocol: 'zigbee', intervalMs: 1000 })]);
  await t.clock.advance(5000);
  assert.ok(t.data(devId(1)).length >= 3);
  assert.ok(t.data(devId(2)).length >= 3);
  assert.equal(t.driver.stats.reads.length, 0, 'hardware is not touched');
  simulator.stop();
  const n = t.data(devId(2)).length;
  await t.clock.advance(5000);
  assert.equal(t.data(devId(2)).length, n, 'the unsupported device stops again');
  await t.sched.stop();
});

test('stop: closes every handle and stops all timers', async () => {
  const s = setup();
  await s.sched.apply([device(devId(1)), device(devId(2))]);
  await s.clock.advance(10000);
  await s.sched.stop();
  assert.equal(s.driver.stats.closes, 2);
  const n = s.driver.stats.reads.length;
  await s.clock.advance(60000);
  assert.equal(s.driver.stats.reads.length, n);
  assert.equal(s.clock.pending(), 0);
});
