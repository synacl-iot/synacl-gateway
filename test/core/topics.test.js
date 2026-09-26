import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTopics, topicTable, SUBSCRIPTION_IDS } from '../../src/core/topics.js';

const TENANT = '64b7a1000000000000000004';
const GW = 'gw_3f2a9c1e7b41';
const P = `tenants/${TENANT}/sources/gateway/${GW}`;
const DEV = '66f1a2b3c4d5e6f708192a3b';

test('prefix follows topics.json', () => {
  const t = createTopics({ tenant: TENANT, gateway: GW });
  assert.equal(t.prefix, P);
  assert.equal(topicTable.prefix.replace('{tenantId}', TENANT).replace('{chipId}', GW), P);
});

test('the seven subscriptions are exactly the gateway-scoped downlinks of topics.json', () => {
  const t = createTopics({ tenant: TENANT, gateway: GW });
  const subs = t.subscriptions();
  assert.deepEqual(subs, [
    `${P}/cmd`, `${P}/devices/+/cmd`, `${P}/config/push`, `${P}/firmware/request`,
    `${P}/macros/push`, `${P}/macros/run`, `${P}/macros/abort`,
  ]);
  const down = topicTable.topics.filter((r) => r.scope === 'gateway' && r.direction === 'down').map((r) => r.id).sort();
  assert.deepEqual([...SUBSCRIPTION_IDS].sort(), down);
});

test('up() resolves ids, scope-less ids and suffixes to the same topic', () => {
  const t = createTopics({ tenant: TENANT, gateway: GW });
  assert.equal(t.up('gateway.status'), `${P}/status`);
  assert.equal(t.up('status'), `${P}/status`);
  assert.equal(t.up('gateway.config-request'), `${P}/config/request`);
  assert.equal(t.up('config-request'), `${P}/config/request`);
  assert.equal(t.up('config/request'), `${P}/config/request`);
  assert.equal(t.up('data/backfill'), `${P}/data/backfill`);
  assert.equal(t.up('macro/run/status'), `${P}/macro/run/status`);
  assert.equal(t.up('gateway.device-data', DEV), `${P}/devices/${DEV}/data`);
  assert.equal(t.up('devices/{deviceId}/status', DEV), `${P}/devices/${DEV}/status`);
  assert.equal(t.up('gateway.device-cmd-ack', DEV), `${P}/devices/${DEV}/cmd/ack`);
});

test('every gateway-scoped uplink in topics.json can be built', () => {
  const t = createTopics({ tenant: TENANT, gateway: GW });
  for (const row of topicTable.topics.filter((r) => r.scope === 'gateway' && r.direction === 'up')) {
    const topic = t.up(row.id, DEV);
    assert.equal(topic, `${P}/${row.suffix.replace('{deviceId}', DEV)}`);
    assert.equal(t.meta(row.id), row);
  }
});

test('up() refuses downlinks, unknown names and unsafe device ids', () => {
  const t = createTopics({ tenant: TENANT, gateway: GW });
  assert.throws(() => t.up('gateway.config-push'), /downlink/);
  assert.throws(() => t.up('nope'), /unknown topic/);
  assert.throws(() => t.up('gateway.device-data'), /device id/);
  for (const bad of ['a/b', 'a+b', 'a#b', '']) assert.throws(() => t.up('gateway.device-data', bad), /device id/);
  // build() reaches down topics (the conformance cloud publishes them).
  assert.equal(t.build('gateway.device-cmd', DEV), `${P}/devices/${DEV}/cmd`);
});

test('parseDown() maps every subscription topic to its topics.json id', () => {
  const t = createTopics({ tenant: TENANT, gateway: GW });
  assert.deepEqual(t.parseDown(`${P}/cmd`), { kind: 'gateway.cmd' });
  assert.deepEqual(t.parseDown(`${P}/config/push`), { kind: 'gateway.config-push' });
  assert.deepEqual(t.parseDown(`${P}/firmware/request`), { kind: 'gateway.firmware-request' });
  assert.deepEqual(t.parseDown(`${P}/macros/push`), { kind: 'gateway.macros-push' });
  assert.deepEqual(t.parseDown(`${P}/macros/run`), { kind: 'gateway.macros-run' });
  assert.deepEqual(t.parseDown(`${P}/macros/abort`), { kind: 'gateway.macros-abort' });
  assert.deepEqual(t.parseDown(`${P}/devices/${DEV}/cmd`), { kind: 'gateway.device-cmd', deviceId: DEV });
});

test('parseDown() rejects foreign, uplink and malformed topics', () => {
  const t = createTopics({ tenant: TENANT, gateway: GW });
  const other = `tenants/${TENANT}/sources/gateway/other_gw`;
  for (const topic of [
    `${other}/cmd`, `${P}/status`, `${P}/devices/${DEV}/data`, `${P}/devices//cmd`, `${P}/devices/a/b/cmd`,
    `${P}/cmd/extra`, `${P}`, `${P}/`, 'cmd', '',
  ]) {
    assert.equal(t.parseDown(topic), null, topic);
  }
});

test('identity is validated', () => {
  assert.throws(() => createTopics({ tenant: 'x', gateway: GW }), /tenant/);
  for (const g of ['a/b', 'a+b', 'a#b', 'ab', 'has space', '-lead']) {
    assert.throws(() => createTopics({ tenant: TENANT, gateway: g }), /gateway id/, g);
  }
  assert.doesNotThrow(() => createTopics({ tenant: TENANT, gateway: 'AA:BB:CC:01' }));
});
