// Self-tests for the verifier: a conformance suite that cannot fail proves nothing, so each
// piece is shown here to catch the misbehaviour it exists to catch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualClock } from '../../src/conformance/virtual-clock.js';
import { createMemoryBroker, maxInWindow, topicMatches } from '../../src/conformance/memory-transport.js';
import { createRateModel, PLAN_PROFILES } from '../../src/conformance/rate-model.js';
import { createScriptedCloud, chunkPayload } from '../../src/conformance/scripted-cloud.js';
import { createHarness, prefixAcl } from '../../src/conformance/harness.js';
import { fnv1a32, gatewayTopics } from '../../src/conformance/protocol.js';
import { FIXTURE_537, FIXTURE_537_HASH, FIXTURE_3420619844, GATEWAY, PASSWORD, TENANT, USERNAME, configPayload, device, deviceId } from '../../src/conformance/fixtures.js';

const T = gatewayTopics({ tenant: TENANT, gateway: GATEWAY });

function world({ latencyMs = 5, jitterMs = 0, plan = 'free' } = {}) {
  const clock = createVirtualClock();
  const broker = createMemoryBroker({ clock, latencyMs, jitterMs, users: { [USERNAME]: PASSWORD }, acl: prefixAcl(TENANT, GATEWAY) });
  const cloud = createScriptedCloud({ broker, clock, plan });
  return { clock, broker, cloud };
}

async function connected(w, extra = {}) {
  const t = w.broker.createTransport();
  const inbox = [];
  t.on('message', (topic, payload, info) => inbox.push({ topic, body: payload.toString(), retain: info.retain }));
  t.connect({ url: 'mqtt://x', clientId: GATEWAY, username: USERNAME, password: PASSWORD, keepalive: 60, rejectUnauthorized: true,
    will: { topic: T.topic('status'), payload: '{"online":false}', qos: 1, retain: true }, ...extra });
  await w.clock.advance(50);
  return { t, inbox };
}

describe('VirtualClock', () => {
  test('fires timers in due order, re-arms intervals, honours clear', async () => {
    const c = createVirtualClock();
    const seen = [];
    c.setTimeout(() => seen.push('b'), 20);
    c.setTimeout(() => seen.push('a'), 10);
    const iv = c.setInterval(() => seen.push('i'), 15);
    const x = c.setTimeout(() => seen.push('never'), 5);
    c.clearTimeout(x);
    await c.advance(31);
    c.clearInterval(iv);
    await c.advance(100);
    assert.deepEqual(seen, ['a', 'i', 'b', 'i']);
  });
  test('lets async continuations run between timers', async () => {
    const c = createVirtualClock();
    const seen = [];
    c.setTimeout(async () => { await Promise.resolve(); seen.push(`first@${c.now()}`); c.setTimeout(() => seen.push(`chained@${c.now()}`), 0); }, 10);
    const start = c.now();
    await c.advance(10);
    assert.deepEqual(seen, [`first@${start + 10}`, `chained@${start + 10}`]);
  });
});

describe('MemoryBroker / MemoryTransport', () => {
  test('refuses bad credentials with CONNACK 4', async () => {
    const w = world();
    const t = w.broker.createTransport();
    let code = null;
    t.on('connack-refused', (c) => { code = c; });
    t.connect({ url: 'mqtt://x', clientId: GATEWAY, username: USERNAME, password: 'wrong', keepalive: 60 });
    await w.clock.advance(50);
    assert.equal(code, 4);
    assert.equal(t.connected, false);
  });
  test('SUBACK grants 128 for a filter outside the ACL; retained replays with the retain flag', async () => {
    const w = world();
    w.broker.publish(`${T.prefix}/cmd`, '{"command":"x"}', { retain: true });
    const { t, inbox } = await connected(w);
    const p = t.subscribe([`${T.prefix}/cmd`, 'tenants/other/sources/gateway/x/cmd'], 1);
    await w.clock.advance(50);
    assert.deepEqual(await p, [1, 128]);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].retain, true);
  });
  test('publish rejects while disconnected and nothing is delivered later', async () => {
    const w = world();
    const t = w.broker.createTransport();
    await assert.rejects(t.publish(T.topic('status'), '{"online":true}'));
    t.connect({ url: 'mqtt://x', clientId: GATEWAY, username: USERNAME, password: PASSWORD, keepalive: 60 });
    await w.clock.advance(1000);
    assert.equal(w.broker.log.length, 0);
    assert.equal(w.broker.stats.offlinePublishAttempts, 1);
  });
  test('the will is published on drop, not after a graceful end', async () => {
    const w = world();
    const a = await connected(w);
    a.t.drop();
    await w.clock.advance(20);
    assert.equal(w.broker.log.filter((m) => m.lwt).length, 1);
    const b = await connected(w);
    await b.t.end(true);
    await w.clock.advance(20);
    assert.equal(w.broker.log.filter((m) => m.lwt).length, 1);
  });
  test('a second connection with the same client id takes the first over (will published)', async () => {
    const w = world();
    const a = await connected(w);
    let closed = false;
    a.t.on('close', () => { closed = true; });
    await connected(w);
    await w.clock.advance(20);
    assert.equal(closed, true);
    assert.equal(w.broker.stats.takeovers, 1);
    assert.equal(w.broker.log.filter((m) => m.lwt).length, 1);
  });
  test('a publish the ACL refuses is dropped silently (QoS 1 still resolves)', async () => {
    const w = world();
    const { t } = await connected(w);
    const p = t.publish('tenants/other/sources/gateway/x/status', '{"online":true}', { qos: 1 });
    await w.clock.advance(50);
    await p;
    assert.equal(w.broker.log.length, 0);
    assert.equal(w.broker.denied.length, 1);
  });
  test('jitter never reorders one connection\'s messages', async () => {
    const w = world({ jitterMs: 400 });
    const { t } = await connected(w);
    for (let i = 0; i < 50; i++) { t.publish(T.topic('status'), JSON.stringify({ online: true, bufRam: i })); await w.clock.advance(3); }
    await w.clock.advance(1000);
    const order = w.cloud.up('gateway.status').map((u) => u.body.bufRam);
    assert.deepEqual(order, [...order].sort((x, y) => x - y));
  });
  test('topic matching and burst window', () => {
    assert.ok(topicMatches('a/+/c', 'a/b/c'));
    assert.ok(topicMatches('a/#', 'a/b/c'));
    assert.ok(!topicMatches('#', '$SYS/x'));
    assert.equal(maxInWindow([{ arrivedAt: 0 }, { arrivedAt: 10 }, { arrivedAt: 999 }, { arrivedAt: 1000 }], 1000), 3);
  });
});

describe('rate model', () => {
  const setup = (plan = 'free') => { const clock = createVirtualClock(); return { clock, rate: createRateModel({ clock, plan }) }; };
  test('arrival gap shorter than the plan interval is a violation', async () => {
    const { clock, rate } = setup();
    assert.equal(rate.gateLive('d', { ts: clock.now(), values: { a: 1 } }).accepted, true);
    await clock.advance(4_000);
    const r = rate.gateLive('d', { ts: clock.now() - 10_000, values: { a: 1 } });
    assert.equal(r.accepted, false);
    assert.equal(rate.violations('d'), 0, 'a ts a full interval OLDER than the last accepted one is late, not a violation');
    const r2 = rate.gateLive('d', { ts: clock.now(), values: { a: 1 } });
    assert.equal(r2.reason, 'interval');
    assert.equal(rate.violations('d'), 1);
  });
  test('a burst of correctly spaced readings is accepted on the device-ts path', async () => {
    const { clock, rate } = setup();
    const t0 = clock.now() - 20_000;
    assert.equal(rate.gateLive('d', { ts: t0, values: { a: 1 } }).path, 'arrival');
    assert.equal(rate.gateLive('d', { ts: t0 + 5_000, values: { a: 1 } }).path, 'device-ts');
    assert.equal(rate.gateLive('d', { ts: t0 + 10_000, values: { a: 1 } }).path, 'device-ts');
    assert.equal(rate.violations(), 0);
  });
  test('an implausible (future) ts does not buy tolerance', () => {
    const { clock, rate } = setup();
    rate.gateLive('d', { ts: clock.now(), values: { a: 1 } });
    assert.equal(rate.gateLive('d', { ts: clock.now() + 60_000, values: { a: 1 } }).reason, 'interval');
  });
  test('the account window drops (without violations) above the plan ceiling', () => {
    const { clock, rate } = setup();
    for (let i = 0; i < 6; i++) rate.gateLive(`d${i}`, { ts: clock.now(), values: { a: 1 } });
    assert.equal(rate.drops().tenant_rate, 1);
    assert.equal(rate.violations(), 0);
  });
  test('read-once: the marker exempts messages and is consumed by the first one carrying the tag', async () => {
    const { clock, rate } = setup();
    rate.gateLive('d', { ts: clock.now(), values: { a: 1 } });
    assert.equal(rate.armReadOnce('d', 'b'), true);
    assert.equal(rate.armReadOnce('d', 'b'), false, 'one arm per 5 s');
    await clock.advance(100);
    // The race: a scheduled message carrying the tag takes the exemption …
    assert.equal(rate.gateLive('d', { ts: clock.now(), values: { a: 1, b: 2 } }).ephemeral, 'b');
    // … so the actual reply is judged normally and counts as a violation.
    assert.equal(rate.gateLive('d', { ts: clock.now(), values: { b: 2 } }).reason, 'interval');
  });
  test('backfill ceiling and suspension after 20 violations', async () => {
    const clock = createVirtualClock();
    // No account window, so every too-fast message reaches the interval check.
    const rate = createRateModel({ clock, plan: { minIntervalMs: 5000, maxMsgsPerSec: 0 } });
    assert.equal(rate.gateBackfill('d', 3000).accepted, true);
    assert.equal(rate.gateBackfill('d', 1).reason, 'backfill_rate');
    await clock.advance(60_000);
    assert.equal(rate.gateBackfill('d', 40).accepted, true);
    rate.gateLive('x', { ts: clock.now(), values: { a: 1 } });
    for (let i = 0; i < 30; i++) { await clock.advance(100); rate.gateLive('x', { ts: clock.now(), values: { a: 1 } }); }
    assert.equal(rate.suspended('x'), true);
    assert.ok(rate.events.some((e) => e.type === 'quota/suspended'));
  });
  test('plan profiles', () => {
    assert.deepEqual([PLAN_PROFILES.free.minIntervalMs, PLAN_PROFILES.s1.minIntervalMs, PLAN_PROFILES.s2.minIntervalMs], [5000, 1000, 500]);
    assert.deepEqual([PLAN_PROFILES.free.maxMsgsPerSec, PLAN_PROFILES.s1.maxMsgsPerSec, PLAN_PROFILES.s2.maxMsgsPerSec], [5, 30, 120]);
  });
});

describe('scripted cloud', () => {
  async function requester(opts = {}) {
    const w = world(opts);
    const { t, inbox } = await connected(w);
    const p = t.subscribe(T.downlinkFilters(), 1);
    await w.clock.advance(50);
    await p;
    const ask = async (body) => { inbox.length = 0; t.publish(T.topic('config/request'), JSON.stringify(body)); await w.clock.advance(50); return inbox.filter((m) => m.topic.endsWith('/config/push')).map((m) => m.body); };
    return { ...w, t, inbox, ask };
  }
  test('config requests: full for hash 0 or a mismatch, unchanged only for a matching non-zero hash', async () => {
    const w = await requester();
    w.cloud.register({ tenant: TENANT, gateway: GATEWAY, config: FIXTURE_3420619844 });
    assert.deepEqual(await w.ask({ hash: 0 }), [FIXTURE_3420619844]);
    assert.deepEqual(await w.ask({ hash: 123 }), [FIXTURE_3420619844]);
    assert.deepEqual(await w.ask({ hash: 3420619844 }), ['{"unchanged":true}']);
    assert.equal(w.cloud.configCurrent(TENANT, GATEWAY), true);
    await w.ask({});
    assert.equal(w.cloud.configCurrent(TENANT, GATEWAY), false, 'no hash is recorded as 0');
    assert.ok(w.inbox.some((m) => m.topic.endsWith('/macros/push')), 'macros/push follows every request');
  });
  test('an unknown gateway gets the empty config', async () => {
    const w = await requester();
    assert.deepEqual(await w.ask({ hash: 0 }), ['{"devices":[],"success":true}']);
  });
  test('over budget: silence and a config-too-large event until capabilities are stored', async () => {
    const w = await requester();
    const big = configPayload([device(2, { tags: Array.from({ length: 200 }, (_, i) => ({ name: `tag_${i}_padding_padding` })) })]);
    w.cloud.register({ tenant: TENANT, gateway: GATEWAY, config: big });
    assert.deepEqual(await w.ask({ hash: 0 }), []);
    assert.equal(w.cloud.eventsOf('gateway/config-too-large').length, 1);
    assert.equal(w.cloud.busy(TENANT, GATEWAY), false);
    w.t.publish(T.topic('firmware/response'), JSON.stringify({ version: '0.1.0', protocols: ['rs485'], sensorModels: {}, maxConfigBytes: 1048576 }));
    await w.clock.advance(50);
    assert.deepEqual(await w.ask({ hash: 0 }), [big]);
    assert.equal(w.cloud.busy(TENANT, GATEWAY), true);
  });
  test('chunking: the 537-byte vector in 13 parts; a bad part index is served as part 0', async () => {
    const c = chunkPayload(FIXTURE_537, FIXTURE_537_HASH, 120);
    assert.equal(c.parts, 13);
    assert.equal(c.part(0).d.length, 56);
    assert.equal(c.part(12).d.length, 44);
    const joined = Buffer.concat(Array.from({ length: 13 }, (_, i) => Buffer.from(c.part(i).d, 'base64')));
    assert.equal(fnv1a32(joined), FIXTURE_537_HASH);
    const w = await requester();
    w.cloud.register({ tenant: TENANT, gateway: GATEWAY, config: FIXTURE_537 });
    const [p5] = await w.ask({ hash: 0, cap: 120, part: 5 });
    assert.equal(JSON.parse(p5).p, 5);
    const [p0] = await w.ask({ hash: 0, cap: 120, part: 99 });
    assert.equal(JSON.parse(p0).p, 0);
  });
  test('capabilities are stored only when protocols or sensorModels is present', async () => {
    const w = await requester();
    w.cloud.register({ tenant: TENANT, gateway: GATEWAY });
    w.t.publish(T.topic('firmware/response'), JSON.stringify({ version: '0.1.0' }));
    await w.clock.advance(50);
    assert.equal(w.cloud.gateway(TENANT, GATEWAY).capabilities, null);
    assert.equal(w.cloud.gateway(TENANT, GATEWAY).firmware, '0.1.0');
  });
  test('strict validation flags an undeclared key; the platform still processes it (stripped)', async () => {
    const w = await requester();
    w.cloud.register({ tenant: TENANT, gateway: GATEWAY });
    w.t.publish(T.topic('status'), JSON.stringify({ online: true, paused: true }), { retain: true });
    await w.clock.advance(50);
    assert.equal(w.cloud.problems.filter((p) => p.kind === 'schema').length, 1);
    assert.equal(w.cloud.gatewayOnline(TENANT, GATEWAY), true);
  });
  test('a null value fails and the platform drops the whole message', async () => {
    const w = await requester();
    w.cloud.register({ tenant: TENANT, gateway: GATEWAY, config: configPayload([device(2)]) });
    w.t.publish(T.topic('devices/{deviceId}/data', deviceId(2)), JSON.stringify({ ts: w.clock.now(), values: { a: null } }));
    await w.clock.advance(50);
    assert.equal(w.cloud.problems.length, 1);
    assert.equal(w.cloud.dataLog.length, 0);
  });
  test('a retained data message and a non-retained heartbeat are flagged', async () => {
    const w = await requester();
    w.cloud.register({ tenant: TENANT, gateway: GATEWAY, config: configPayload([device(2)]) });
    w.t.publish(T.topic('status'), '{"online":true}');
    w.t.publish(T.topic('devices/{deviceId}/data', deviceId(2)), JSON.stringify({ ts: w.clock.now(), values: { a: 1 } }), { retain: true });
    await w.clock.advance(50);
    assert.equal(w.cloud.problems.filter((p) => p.kind === 'retain').length, 2);
  });
  test('presence: gateway stale after 180 s of server time, devices after 90 s', async () => {
    const w = await requester();
    w.cloud.register({ tenant: TENANT, gateway: GATEWAY, config: configPayload([device(2)]) });
    w.t.publish(T.topic('status'), '{"online":true}', { retain: true });
    w.t.publish(T.topic('devices/{deviceId}/status', deviceId(2)), JSON.stringify({ ts: w.clock.now(), reachable: true }), { retain: true });
    await w.clock.advance(89_000);
    assert.equal(w.cloud.deviceOnline(TENANT, GATEWAY, deviceId(2)), true);
    await w.clock.advance(2_000);
    assert.equal(w.cloud.deviceOnline(TENANT, GATEWAY, deviceId(2)), false);
    assert.equal(w.cloud.gatewayOnline(TENANT, GATEWAY), true);
    await w.clock.advance(90_000);
    assert.equal(w.cloud.gatewayOnline(TENANT, GATEWAY), false);
  });
});

describe('end to end: the verifier fails a misconfigured run', () => {
  test('a device configured faster than the plan floor accumulates violations', async () => {
    const h = createHarness({ id: 'NEG' });
    const env = await h.env({ cloudConfig: configPayload([device(2, { tickDuration: 1_000 })]), plan: 'free' });
    await env.start();
    await env.waitSynced(60_000);
    await env.advance(60_000);
    const v = env.cloud.rate.violations();
    await h._cleanup();
    assert.ok(v > 10, `expected violations, got ${v}`);
  });
});
