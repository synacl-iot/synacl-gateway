// verifyConnection against a real (in-process) broker: the checks init and doctor rely on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyConnection } from '../../src/cli/init.js';
import { createTopics } from '../../src/core/topics.js';
import { GATEWAY, OWNER, PASSWORD, freePort, sampleConfig, startBroker } from '../_support/cli/helpers.js';

const clientId = `${GATEWAY}-init-ab12`;

function recordingBroker(t, hooks = {}) {
  const seen = { connects: [], subscriptions: [] };
  const authenticate = hooks.authenticate ?? ((client, username, password, cb) => {
    seen.connects.push({ clientId: client.id, username, password: String(password), will: client.will ?? null });
    cb(null, username === '123456' && String(password) === PASSWORD);
  });
  const authorizeSubscribe = hooks.authorizeSubscribe ?? ((client, sub, cb) => { seen.subscriptions.push(sub.topic); cb(null, sub); });
  return startBroker({ authenticate, authorizeSubscribe }).then((b) => { t.after(() => b.close()); return { ...b, seen }; });
}

test('good credentials: CONNACK ok, all seven filters granted, no Will, nothing published', async (t) => {
  const b = await recordingBroker(t);
  const res = await verifyConnection({ config: sampleConfig({ broker: b.url }), clientId, timeoutMs: 3000 });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.grants.length, 7);
  assert.deepEqual(b.seen.subscriptions, createTopics({ tenant: OWNER, gateway: GATEWAY }).subscriptions());
  assert.equal(b.seen.connects[0].clientId, clientId);
  assert.equal(b.seen.connects[0].will, null, 'a verify session must never carry the Last Will');
  assert.deepEqual(b.published, []);
});

test('wrong password: stage connack, code 5, a hint to copy the line again', async (t) => {
  const b = await recordingBroker(t);
  const res = await verifyConnection({ config: sampleConfig({ broker: b.url, password: 'WrongPassword00000000000' }), clientId, timeoutMs: 3000 });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'connack');
  assert.equal(res.code, 5);
  assert.match(res.message, /rejected the username\/password/);
  assert.match(res.hint, /Connection Info/);
});

test('ACL mismatch: CONNACK ok but refused subscriptions are named', async (t) => {
  const b = await recordingBroker(t, {
    // Emulate a broker whose ACL is keyed to a different tenant: only `cmd` passes.
    authorizeSubscribe: (client, sub, cb) => cb(null, sub.topic.endsWith('/cmd') && !sub.topic.includes('devices/') ? sub : null),
  });
  const res = await verifyConnection({ config: sampleConfig({ broker: b.url }), clientId, timeoutMs: 3000 });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'suback');
  assert.equal(res.deniedFilters.length, 6);
  assert.equal(res.grants.filter((g) => g === 128).length, 6);
  assert.match(res.message, /refused 6 of 7 subscriptions \(devices\/\+\/cmd, config\/push/);
  assert.match(res.hint, /--tenant and --gateway do not match/);
});

test('nothing listening: stage tcp, ECONNREFUSED', async () => {
  const port = await freePort();
  const res = await verifyConnection({ config: sampleConfig({ broker: `mqtt://127.0.0.1:${port}` }), clientId, timeoutMs: 3000 });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'tcp');
  assert.equal(res.code, 'ECONNREFUSED');
  assert.match(res.message, /refused the connection/);
});

test('TLS against a plain port is reported as a TLS problem', async (t) => {
  const b = await recordingBroker(t);
  const res = await verifyConnection({ config: sampleConfig({ broker: `mqtts://127.0.0.1:${b.port}` }), clientId, timeoutMs: 3000 });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'tls');
  assert.match(res.message, /TLS/);
  assert.ok(!JSON.stringify(res).includes(PASSWORD));
});

test('an unreadable CA file fails at the tls stage without connecting', async () => {
  const res = await verifyConnection({ config: sampleConfig({ tls: { caFile: '/nonexistent/ca.pem', rejectUnauthorized: true } }), clientId, filters: [] });
  assert.equal(res.stage, 'tls');
  assert.match(res.message, /cannot read the CA file/);
});
