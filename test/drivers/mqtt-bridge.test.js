// mqtt-bridge driver against an in-process aedes broker over real sockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMqttBridgeDriver } from '../../src/drivers/mqtt-bridge.js';
import { createCaptureLog, createFakeClock, makeCtx, makeDevice, realClock, sleep, waitFor } from '../_support/drivers/helpers.js';
import { startBroker } from '../_support/drivers/servers.js';

/** @type {Awaited<ReturnType<typeof startBroker>>} */
let broker;
before(async () => {
  broker = await startBroker();
});
after(() => broker.close());

function setup({ clock = realClock, log = createCaptureLog(), options = {} } = {}) {
  const drv = createMqttBridgeDriver().create(makeCtx({ log, clock, options }));
  return { drv, log };
}
const bridgeDevice = (tags, conn = {}, intervalMs = 10_000) =>
  makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: broker.url, sampleIntervalMs: intervalMs, ...conn }, tags, intervalMs });

/** Publish until the driver has the value (subscriptions are asynchronous). */
async function publishSeen(drv, h, topic, payload, tagName) {
  await waitFor(async () => {
    await broker.publish(topic, payload);
    await sleep(10);
    return (await drv.read(h, [{ name: tagName, topic }], { reason: 'once' })).values[tagName] !== undefined;
  }, { what: `a message on ${topic}` });
}
/** Wait until the driver's connection has subscribed (a probe tag sees a message). */
async function subscribed(drv, h, topic) {
  await publishSeen(drv, h, topic, '0', '__probe');
}
const read = (drv, h, tags, reason = 'interval') => drv.read(h, tags, { reason, signal: new AbortController().signal });

test('Tasmota telemetry: JSON path into tele/plug1/SENSOR, and "ON" on stat/plug1/POWER → 1', async () => {
  const { drv } = setup();
  const device = bridgeDevice([
    { name: 'power', topic: 'tele/plug1/SENSOR', jsonPath: 'ENERGY.Power' },
    { name: 'relay', topic: 'stat/plug1/POWER' },
    { name: '__probe', topic: 'probe/a' },
  ]);
  const h = await drv.open(device);
  await subscribed(drv, h, 'probe/a');
  await broker.publish('tele/plug1/SENSOR', JSON.stringify({ Time: '2026-09-26T10:00:00', ENERGY: { Power: 42.5, Voltage: 231 } }));
  await broker.publish('stat/plug1/POWER', 'ON');
  await waitFor(async () => Object.keys((await read(drv, h, device.tags.slice(0, 2), 'once')).values).length === 2);
  const r = await read(drv, h, device.tags.slice(0, 2));
  assert.deepEqual(r.values, { power: 42.5, relay: 1 });
  assert.equal(r.reachable, true);
  await broker.publish('stat/plug1/POWER', 'OFF');
  await waitFor(async () => (await read(drv, h, [device.tags[1]], 'once')).values.relay === 0);
  await drv.close(h);
});

test('+ and # filters, array indexes, latest wins, nothing new → no values', async () => {
  const { drv } = setup();
  const device = bridgeDevice([
    { name: 'plug_power', topic: 'tele/+/SENSOR', jsonPath: 'ENERGY.Power' },
    { name: 'room', topic: 'sensors/#' },
    { name: 'second', topic: 'arr/x', jsonPath: 'readings.1.t' },
    { name: '__probe', topic: 'probe/b' },
  ]);
  const tags = device.tags.slice(0, 3);
  const h = await drv.open(device);
  await subscribed(drv, h, 'probe/b');
  await broker.publish('tele/kitchen/SENSOR', '{"ENERGY":{"Power":10}}');
  await broker.publish('sensors/room1/temp', '21.5');
  await broker.publish('arr/x', '{"readings":[{"t":1},{"t":2.5}]}');
  for (const p of [11, 12, 13]) await broker.publish('tele/kitchen/SENSOR', `{"ENERGY":{"Power":${p}}}`);
  await waitFor(async () => (await read(drv, h, tags, 'once')).values.plug_power === 13);
  const r = await read(drv, h, tags);
  assert.deepEqual(r.values, { plug_power: 13, room: 21.5, second: 2.5 });
  const again = await read(drv, h, tags);
  assert.deepEqual(again.values, {}, 'nothing new since the previous read');
  assert.equal(again.reachable, true);
  // A read of only some tags leaves the others' news for later.
  await broker.publish('sensors/room2/temp', '"22.25"');
  await broker.publish('arr/x', '{"readings":[{"t":1},{"t":3}]}');
  await waitFor(async () => (await read(drv, h, [tags[2]], 'once')).values.second === 3);
  assert.deepEqual((await read(drv, h, [tags[1]])).values, { room: 22.25 });
  assert.deepEqual((await read(drv, h, [tags[2]])).values, { second: 3 });
  await drv.close(h);
});

test('an object payload without a JSON path is skipped and warned once', async () => {
  const { drv, log } = setup();
  const device = bridgeDevice([{ name: 'whole', topic: 'obj/t' }, { name: '__probe', topic: 'probe/c' }]);
  const h = await drv.open(device);
  await subscribed(drv, h, 'probe/c');
  await broker.publish('obj/t', '{"a":1}');
  await broker.publish('obj/t', '{"a":2}');
  await broker.publish('obj/t', '[1,2]');
  await sleep(50);
  const r = await read(drv, h, [device.tags[0]]);
  assert.deepEqual(r.values, {});
  const warns = log.lines.filter((l) => l.level === 'warn' && /set a JSON path/.test(l.msg));
  assert.equal(warns.length, 1);
  await drv.close(h);
});

test('retained messages are picked up on subscribe', async () => {
  await broker.publish('stat/plug9/POWER', 'ON', { retain: true });
  const { drv } = setup();
  const device = bridgeDevice([{ name: 'relay', topic: 'stat/plug9/POWER' }]);
  const h = await drv.open(device);
  await waitFor(async () => (await read(drv, h, device.tags, 'once')).values.relay === 1, { what: 'the retained message' });
  assert.deepEqual((await read(drv, h, device.tags)).values, { relay: 1 });
  await drv.close(h);
});

test('read/once answers from the cache, and says so when nothing has arrived', async () => {
  const { drv } = setup();
  const device = bridgeDevice([{ name: 'v', topic: 'once/none' }, { name: 'bad', topic: 'a/#/b' }]);
  const h = await drv.open(device);
  const r = await read(drv, h, [device.tags[0]], 'once');
  assert.deepEqual(r.values, {});
  assert.equal(r.errors.v, 'no message received yet on once/none');
  const bad = await read(drv, h, [device.tags[1]], 'once');
  assert.match(bad.errors.bad, /"#" must be the last level/);
  await drv.close(h);
});

test('bridge/no_message after max(3 × interval, 300 s); conn.staleMs overrides; 0 = never', async () => {
  const clock = createFakeClock();
  const { drv } = setup({ clock });
  const dflt = await drv.open(bridgeDevice([{ name: 'a', topic: 'stale/a' }], {}, 10_000));
  const slow = await drv.open(bridgeDevice([{ name: 'a', topic: 'stale/a' }], {}, 200_000));
  const custom = await drv.open(bridgeDevice([{ name: 'b', topic: 'stale/b' }], { staleMs: 5_000 }));
  const never = await drv.open(bridgeDevice([{ name: 'c', topic: 'stale/c' }], { staleMs: 0 }));
  await publishSeen(drv, custom, 'stale/b', '0', 'b');
  assert.deepEqual(drv.status(custom), { reachable: true });

  clock.advance(5_001);
  assert.deepEqual(drv.status(custom), { reachable: false, reason: 'bridge/no_message' });
  const r = await read(drv, custom, [{ name: 'b', topic: 'stale/b' }]);
  assert.equal(r.reachable, false);
  assert.equal(r.reason, 'bridge/no_message');
  await broker.publish('stale/b', '1');
  await waitFor(() => drv.status(custom).reachable, { what: 'recovery on a new message' });

  clock.advance(300_000 - 5_001 - 1);
  assert.equal(drv.status(dflt).reachable, true, 'Tasmota\'s 300 s default must not flap');
  clock.advance(2);
  assert.deepEqual(drv.status(dflt), { reachable: false, reason: 'bridge/no_message' });
  assert.equal(drv.status(slow).reachable, true, '3 × 200 s = 600 s');
  clock.advance(300_000);
  assert.equal(drv.status(slow).reachable, false);
  assert.deepEqual(drv.status(never), { reachable: true });
  for (const h of [dflt, slow, custom, never]) await drv.close(h);
});

test('bridge/disconnected once the local broker has been gone for more than 10 s', async () => {
  const local = await startBroker();
  const clock = createFakeClock();
  const { drv, log } = setup({ clock });
  const device = makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: local.url, staleMs: 0 }, tags: [{ name: 'a', topic: 'x' }] });
  const h = await drv.open(device);
  await waitFor(() => local.clients() === 1, { what: 'the bridge to connect' });
  assert.deepEqual(drv.status(h), { reachable: true });
  await local.close();
  await waitFor(() => /lost the connection/.test(log.text()), { what: 'the close to be noticed' });
  clock.advance(10_000);
  assert.deepEqual(drv.status(h), { reachable: true }, 'a blip under 10 s is not an outage');
  clock.advance(1);
  assert.deepEqual(drv.status(h), { reachable: false, reason: 'bridge/disconnected' });
  await drv.close(h);
});

test('a broker that is down from the start is reported after 10 s too', async () => {
  const clock = createFakeClock();
  const { drv } = setup({ clock });
  const device = makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: 'mqtt://127.0.0.1:1', staleMs: 0 }, tags: [{ name: 'a', topic: 'x' }] });
  const h = await drv.open(device);
  clock.advance(10_001);
  assert.deepEqual(drv.status(h), { reachable: false, reason: 'bridge/disconnected' });
  await drv.close(h);
});

test('devices on the same broker share one connection; it closes with the last device', async () => {
  const local = await startBroker();
  try {
    const { drv, log } = setup();
    const mk = (topic) => makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: local.url }, tags: [{ name: 'v', topic }] });
    const d1 = mk('pool/1');
    const d2 = mk('pool/2');
    const h1 = await drv.open(d1);
    const h2 = await drv.open(d2);
    await waitFor(() => local.clients() === 1);
    await sleep(50);
    assert.equal(local.clients(), 1, 'one local connection for two devices');
    const probe = async (h, topic, payload) =>
      waitFor(async () => {
        await local.publish(topic, payload);
        await sleep(10);
        return (await read(drv, h, [{ name: 'v', topic }], 'once')).values.v === Number(payload);
      });
    await probe(h1, 'pool/1', '1');
    await probe(h2, 'pool/2', '2');
    assert.deepEqual((await read(drv, h1, d1.tags)).values, { v: 1 }, 'each device sees only its own topics');
    await drv.close(h1);
    await sleep(50);
    assert.equal(local.clients(), 1, 'still used by the second device');
    await probe(h2, 'pool/2', '3');
    await drv.close(h2);
    await waitFor(() => local.clients() === 0, { what: 'the pooled connection to close' });
    await sleep(20);
    assert.equal(/lost the connection/.test(log.text()), false, 'closing on purpose is not an outage');
  } finally {
    await local.close();
  }
});

test('credentials reach the broker but never a log line', async () => {
  const PASS = 'pa55-Wörd-for-local-broker';
  const URLPASS = 'url-secret-99';
  let auths = 0;
  const local = await startBroker({
    authenticate: (client, username, password, cb) => {
      const ok = (username === 'bridge' && password?.toString() === PASS) || (username === 'u2' && password?.toString() === URLPASS);
      if (ok) auths++;
      const err = ok ? null : Object.assign(new Error('bad credentials'), { returnCode: 4 });
      cb(err, ok);
    },
  });
  try {
    const { drv, log } = setup();
    const d1 = makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: local.url, username: 'bridge', password: PASS }, tags: [{ name: 'v', topic: 'cred/#' }] });
    const d2 = makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: local.url.replace('mqtt://', `mqtt://u2:${URLPASS}@`) }, tags: [{ name: 'w', topic: 'cred/w' }] });
    const d3 = makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: local.url, username: 'bridge', password: 'wrong' }, tags: [{ name: 'x', topic: 'cred/x' }] });
    const h1 = await drv.open(d1);
    const h2 = await drv.open(d2);
    const h3 = await drv.open(d3);
    await waitFor(() => auths === 2 && local.clients() === 2, { what: 'both good logins' });
    await local.publish('cred/obj', '{"no":"path"}'); // provokes a warning that names the device
    await waitFor(() => /Bad username or password|Not authorized/.test(log.text()), { what: 'the refused login to be logged' });
    for (const h of [h1, h2, h3]) await drv.close(h);
    assert.ok(log.secrets.includes(PASS), 'conn.password registered with the redactor');
    assert.ok(log.secrets.includes(URLPASS), 'the URL password registered too');
    const text = log.text();
    assert.equal(text.includes(PASS), false, 'conn.password never logged');
    assert.equal(text.includes(URLPASS), false, 'URL password never logged');
    assert.match(text, /connecting to mqtt:\/\/127\.0\.0\.1:\d+ as synacl-test-gw-01-/);
  } finally {
    await local.close();
  }
});

test('writes are refused with a clear message; bad config fails open()', async () => {
  const { drv } = setup();
  const h = await drv.open(bridgeDevice([{ name: 'v', topic: 't' }]));
  assert.deepEqual(await drv.write(h, { kind: 'modbus', registerType: 'coil', address: 0, value: 1 }), { ok: false, error: 'modbus writes are not supported for protocol "mqtt-bridge"' });
  assert.deepEqual(await drv.write(h, { kind: 'actuator', value: 1 }), { ok: false, error: 'actuator writes are not supported for protocol "mqtt-bridge"' });
  await drv.close(h);
  await drv.close(h);
  await assert.rejects(drv.open(makeDevice({ protocol: 'mqtt-bridge', conn: {}, tags: [] })), (e) => /brokerUrl is missing/.test(e.reason));
  await assert.rejects(drv.open(makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: 'http://x' }, tags: [] })), /not supported/);
  await assert.rejects(drv.open(makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: 'not a url' }, tags: [] })), /not a valid URL/);
});

test('an explicit clientId is used as-is (and keys its own pool)', async () => {
  const local = await startBroker();
  const ids = [];
  local.aedes.on('client', (c) => ids.push(c.id));
  try {
    const { drv } = setup();
    const a = await drv.open(makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: local.url, clientId: 'my-bridge' }, tags: [{ name: 'v', topic: 'a' }] }));
    const b = await drv.open(makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: local.url }, tags: [{ name: 'v', topic: 'b' }] }));
    await waitFor(() => ids.length === 2);
    assert.ok(ids.includes('my-bridge'));
    assert.ok(ids.some((id) => /^synacl-test-gw-01-[0-9a-f]{6}$/.test(id)), ids.join(','));
    await drv.close(a);
    await drv.close(b);
  } finally {
    await local.close();
  }
});
