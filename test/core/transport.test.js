// MqttTransport against a real in-process broker (aedes) with ACL hooks.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMqttTransport, clientOptions } from '../../src/core/transport.js';
import { startBroker, waitFor } from '../_support/core-sync/broker.js';

const TENANT = '64b7a1000000000000000004';
const GW = 'gw_3f2a9c1e7b41';
const P = `tenants/${TENANT}/sources/gateway/${GW}`;
const USERS = {
  '123456': { password: 'gw-secret', prefix: P, denySubscribe: ['macros/abort'] },
  backend: { password: 'backend-pw' },
  locked: { password: 'x', connack: 4 },
};

let broker;
let transports;
beforeEach(async () => { broker = await startBroker({ users: USERS }); transports = []; });
afterEach(async () => {
  await Promise.all(transports.map((t) => t.end(false).catch(() => {})));
  await broker.close();
});

function make() {
  const t = createMqttTransport();
  transports.push(t);
  return t;
}

function opts(over = {}) {
  return {
    url: broker.url, clientId: GW, username: '123456', password: 'gw-secret', keepalive: 60,
    will: { topic: `${P}/status`, payload: '{"online":false}', qos: 1, retain: true }, rejectUnauthorized: true, ...over,
  };
}

async function connected(t, o = opts()) {
  const p = new Promise((resolve, reject) => {
    t.on('connect', resolve);
    t.on('connack-refused', (code) => reject(new Error(`refused ${code}`)));
  });
  t.connect(o);
  await p;
}

test('mqtt.js options: 3.1.1, clean, no auto-reconnect, no resubscribe, no QoS 0 queue', () => {
  const o = clientOptions(opts({ ca: 'PEM' }));
  assert.equal(o.protocolVersion, 4);
  assert.equal(o.clean, true);
  assert.equal(o.keepalive, 60);
  assert.equal(o.connectTimeout, 30000);
  assert.equal(o.reconnectPeriod, 0);
  assert.equal(o.resubscribe, false);
  assert.equal(o.queueQoSZero, false);
  assert.equal(o.rejectUnauthorized, true);
  assert.equal(o.ca, 'PEM');
  assert.deepEqual({ ...o.will, payload: o.will.payload.toString() }, { topic: `${P}/status`, payload: '{"online":false}', qos: 1, retain: true });
});

test('connects with the gateway id, credentials and the exact Last Will', async () => {
  const t = make();
  await connected(t);
  assert.equal(t.connected, true);
  const c = broker.events.find((e) => e.type === 'connect' && e.clientId === GW);
  assert.equal(c.username, '123456');
  assert.equal(c.clean, true);
  assert.equal(c.version, 4);
  assert.equal(c.keepalive, 60);
  assert.deepEqual(c.will, { topic: `${P}/status`, payload: '{"online":false}', qos: 1, retain: true });
});

test('subscribe returns the granted list; a refused filter is 128', async () => {
  const t = make();
  await connected(t);
  const granted = await t.subscribe([`${P}/cmd`, `${P}/devices/+/cmd`, `${P}/macros/abort`, 'tenants/other/#'], 1);
  assert.deepEqual(granted, [1, 1, 128, 128]);
});

test('publish: resolves on write (QoS 0) and on PUBACK (QoS 1); retained flag reaches the broker', async () => {
  const t = make();
  await connected(t);
  await t.publish(`${P}/status`, '{"online":true}', { qos: 0, retain: true });
  await t.publish(`${P}/firmware/response`, Buffer.from('{"version":"0.1.0"}'), { qos: 1 });
  const pubs = broker.publishes(GW);
  assert.deepEqual(pubs.map((p) => [p.topic, p.qos, p.retain]), [[`${P}/status`, 0, true], [`${P}/firmware/response`, 1, false]]);
});

test('messages arrive as Buffers with their retain flag', async () => {
  const cloud = await broker.cloud();
  await cloud.publish(`${P}/config/push`, '{"unchanged":true}', { qos: 1, retain: true });
  const t = make();
  const got = [];
  t.on('message', (topic, payload, info) => got.push({ topic, payload, info }));
  await connected(t);
  await t.subscribe([`${P}/config/push`, `${P}/cmd`], 1);
  await cloud.publish(`${P}/cmd`, '{"command":"restart"}', { qos: 1 });
  await waitFor(() => got.length === 2, 'two messages');
  assert.ok(Buffer.isBuffer(got[0].payload));
  assert.deepEqual(got.map((m) => [m.topic, m.payload.toString(), m.info.retain]), [
    [`${P}/config/push`, '{"unchanged":true}', true],
    [`${P}/cmd`, '{"command":"restart"}', false],
  ]);
});

test('publish and subscribe REJECT while disconnected — nothing is queued', async () => {
  const t = make();
  await assert.rejects(t.publish(`${P}/status`, 'x'), (e) => e.code === 'ENOTCONNECTED');
  await assert.rejects(t.subscribe([`${P}/cmd`]), (e) => e.code === 'ENOTCONNECTED');
  assert.equal(t.connected, false);
});

test('a forced disconnect produces NO flush burst on reconnect', async () => {
  const t = make();
  let closes = 0;
  t.on('close', () => { closes++; });
  await connected(t);
  await t.publish(`${P}/devices/66f1a2b3c4d5e6f708192a3b/data`, '{"ts":1,"values":{"v":1}}');
  const sent = () => broker.publishes(GW).filter((p) => !p.isWill).length;
  const before = sent();
  broker.kick(GW);
  await waitFor(() => closes === 1, 'close');
  assert.equal(t.connected, false);
  const offline = [];
  for (let i = 0; i < 20; i++) offline.push(t.publish(`${P}/devices/66f1a2b3c4d5e6f708192a3b/data`, `{"ts":${i},"values":{"v":${i}}}`, { qos: i % 2 }).then(() => 'sent', () => 'rejected'));
  assert.deepEqual([...new Set(await Promise.all(offline))], ['rejected']);
  await connected(t);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent(), before, 'the reconnect replayed nothing');
});

test('an ungraceful drop fires the retained Last Will; a graceful end does not', async () => {
  const cloud = await broker.cloud();
  const t = make();
  await connected(t);
  await t.end(false); // socket destroyed, no DISCONNECT
  await waitFor(() => broker.publishes(GW).some((p) => p.isWill), 'the will');
  const will = broker.publishes(GW).find((p) => p.isWill);
  assert.deepEqual([will.topic, will.payload, will.qos, will.retain], [`${P}/status`, '{"online":false}', 1, true]);
  await waitFor(() => cloud.received.some((m) => m.topic === `${P}/status`), 'will delivered');
  // Retained: a late subscriber still sees it.
  const late = await broker.cloud();
  await waitFor(() => late.received.some((m) => m.topic === `${P}/status` && m.retain && m.payload === '{"online":false}'), 'retained will');

  const t2 = make();
  await connected(t2, opts({ clientId: `${GW}-2` }));
  await t2.end(true);
  await waitFor(() => broker.events.some((e) => e.type === 'disconnect' && e.clientId === `${GW}-2`), 'disconnect');
  assert.equal(broker.events.find((e) => e.type === 'disconnect' && e.clientId === `${GW}-2`).graceful, true);
  assert.equal(broker.publishes(`${GW}-2`).some((p) => p.isWill), false);
});

test('bad credentials: connack-refused(5), then close; no error event for it', async () => {
  const t = make();
  const seen = [];
  t.on('connack-refused', (code) => seen.push(['refused', code]));
  t.on('error', (e) => seen.push(['error', e.message]));
  t.on('close', () => seen.push(['close']));
  t.connect(opts({ password: 'wrong' }));
  await waitFor(() => seen.some((s) => s[0] === 'close'), 'close');
  assert.deepEqual(seen, [['refused', 5], ['close']]);
  const t4 = make();
  const codes = [];
  t4.on('connack-refused', (c) => codes.push(c));
  t4.connect(opts({ username: 'locked', password: 'x', clientId: 'locked-1' }));
  await waitFor(() => codes.length === 1, 'refused 4');
  assert.deepEqual(codes, [4]);
});

test('an unreachable broker: error then close, never connect', async () => {
  const t = make();
  const seen = [];
  t.on('error', () => seen.push('error'));
  t.on('close', () => seen.push('close'));
  t.on('connect', () => seen.push('connect'));
  t.connect(opts({ url: 'mqtt://127.0.0.1:1' }));
  await waitFor(() => seen.includes('close'), 'close');
  assert.equal(seen.includes('connect'), false);
});

test('connect() again replaces the old client; only the new one reports events', async () => {
  const t = make();
  let connects = 0;
  let closes = 0;
  t.on('connect', () => { connects++; });
  t.on('close', () => { closes++; });
  t.connect(opts());
  t.connect(opts());
  await waitFor(() => connects === 1 && t.connected, 'connect');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(connects, 1);
  assert.equal(closes, 0);
});

test('a QoS 1 publish still waiting for its PUBACK rejects when the link drops', async () => {
  const t = make();
  await connected(t);
  // Hold PUBACKs: aedes acks QoS 1 inside authorizePublish's callback.
  const orig = broker.aedes.authorizePublish;
  broker.aedes.authorizePublish = () => {};
  const p = t.publish(`${P}/status`, '{"online":false}', { qos: 1, retain: true });
  await new Promise((r) => setTimeout(r, 30));
  broker.kick(GW);
  await assert.rejects(p);
  broker.aedes.authorizePublish = orig;
});
