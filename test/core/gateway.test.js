// The gateway lifecycle over a real socket: an in-process aedes broker with per-gateway ACL
// hooks, the cloud as an ordinary MQTT client, the real core modules, a deterministic host
// driver, and a manual clock for every gateway timer (network I/O stays real).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGateway } from '../../src/core/gateway.js';
import { createValidators } from '../../src/core/schemas.js';
import { fnv1a32 } from '../../src/core/fnv.js';
import { LockHeldError } from '../../src/core/state.js';
import { version as pkgVersion } from '../../src/index.js';
import { startBroker, waitFor } from '../_support/core-sync/broker.js';
import { createFakeClock, createScriptedPlatform, createMemoryLogger, flush } from '../_support/core-sync/helpers.js';
import { GW, PREFIX, DEV, fakeHostDriver, hostConfigBytes, gatewayConfig, tempHome } from '../_support/core-sync/fixtures.js';

const validators = createValidators();
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()().catch(() => {});
});

async function setup({ users, configOver = {}, bytes = hostConfigBytes(), answer = true, home = tempHome() } = {}) {
  const clock = createFakeClock(Date.UTC(2026, 0, 1));
  const broker = await startBroker({
    users: users ?? { '123456': { password: 'gw-secret-pw', prefix: PREFIX }, backend: { password: 'backend-pw' } },
    now: () => clock.now(),
  });
  const log = createMemoryLogger();
  const driver = fakeHostDriver();
  const config = gatewayConfig(broker.url, configOver);
  const cloud = await broker.cloud();
  const platform = createScriptedPlatform(bytes);
  if (answer) {
    cloud.client.on('message', (topic, payload) => {
      if (topic !== `${PREFIX}/config/request`) return;
      const reply = platform.answer(JSON.parse(payload.toString()));
      if (reply) cloud.client.publish(`${PREFIX}/config/push`, reply, { qos: 1 });
    });
  }
  const gw = createGateway({ config, home, clock, log, drivers: [driver.def], random: () => 0.5 });
  const t = {
    broker, clock, log, driver, config, cloud, platform, gw, home,
    /** Client publishes from the gateway (its Last Will excluded), by topic suffix. */
    pubs: (suffix) => broker.publishes(GW).filter((p) => !p.isWill && (!suffix || p.topic === `${PREFIX}/${suffix}`)),
    dataPubs: () => broker.publishes(GW).filter((p) => /\/devices\/[^/]+\/data$/.test(p.topic)),
    connects: () => broker.events.filter((e) => (e.type === 'connect' || e.type === 'refused') && e.clientId === GW),
    /** Advance the manual clock in steps, giving real I/O a chance between them. */
    async step(ms, stepMs = 1000) {
      for (let done = 0; done < ms; done += stepMs) {
        await clock.advance(Math.min(stepMs, ms - done));
        await new Promise((r) => setTimeout(r, 2));
      }
    },
  };
  cleanups.push(async () => {
    await gw.stop();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  });
  return t;
}

/** start → online → config applied → synced. */
async function startSynced(t) {
  await t.gw.start();
  await waitFor(() => t.pubs('firmware/response').length >= 1, 'capability report');
  await t.step(2000);
  await waitFor(() => t.gw.status().configSynced, 'config synced');
}

test('connect sequence: 7 subscriptions → retained heartbeat without ts → capabilities → config/request ≥ 1 s later', { timeout: 20000 }, async () => {
  const t = await setup();
  await t.gw.start();
  await waitFor(() => t.pubs('firmware/response').length === 1, 'capability report');

  const c = t.broker.events.find((e) => e.type === 'connect' && e.clientId === GW);
  assert.deepEqual(c.will, { topic: `${PREFIX}/status`, payload: '{"online":false}', qos: 1, retain: true });
  assert.equal(c.clean, true);
  assert.equal(c.version, 4);
  assert.equal(c.keepalive, 60);

  const subs = t.broker.events.filter((e) => e.type === 'subscribe' && e.clientId === GW);
  assert.deepEqual(subs.map((s) => s.topic).sort(), [
    'cmd', 'config/push', 'devices/+/cmd', 'firmware/request', 'macros/abort', 'macros/push', 'macros/run',
  ].map((s) => `${PREFIX}/${s}`).sort());
  assert.ok(subs.every((s) => s.qos === 1 && !s.denied));

  const first = t.pubs().map((p) => p.topic.slice(PREFIX.length + 1));
  assert.deepEqual(first, ['status', 'firmware/response']);
  const [hb, caps] = t.pubs();
  const hbBody = JSON.parse(hb.payload);
  assert.equal(hbBody.online, true);
  assert.equal('ts' in hbBody, false, 'the platform stamps the heartbeat itself');
  assert.equal(hbBody.fw, pkgVersion);
  assert.equal(hb.retain, true);
  assert.equal(hb.qos, 0);
  assert.ok(validators.validate('source-status', hbBody).ok);
  const capsBody = JSON.parse(caps.payload);
  assert.ok(validators.validate('firmware-response', capsBody).ok);
  assert.equal(capsBody.version, pkgVersion);
  assert.ok(capsBody.protocols.includes('host'));
  assert.equal(caps.qos, 0);

  await t.step(1000);
  assert.equal(t.pubs('config/request').length, 0, 'not within the first second after the capabilities');
  await t.step(1000);
  await waitFor(() => t.pubs('config/request').length >= 1, 'config/request');
  assert.deepEqual(JSON.parse(t.pubs('config/request')[0].payload), { hash: 0 });
});

test('config apply: exact bytes stored, devices started, re-request with the new hash, unchanged → synced', { timeout: 20000 }, async () => {
  const t = await setup();
  await startSynced(t);
  const bytes = hostConfigBytes();
  const reqs = t.pubs('config/request').map((p) => JSON.parse(p.payload));
  assert.deepEqual(reqs, [{ hash: 0 }, { hash: fnv1a32(bytes) }]);
  const st = t.gw.status();
  assert.equal(st.configHash, fnv1a32(bytes));
  assert.equal(st.configSynced, true);
  assert.equal(st.state, 'online');
  assert.equal(st.connected, true);
  assert.deepEqual(st.devices.map((d) => d.id), [DEV]);
  assert.ok(readFileSync(join(t.gw.state.dir, 'config.raw')).equals(bytes));
  const runtime = JSON.parse(readFileSync(join(t.gw.state.dir, 'runtime.json'), 'utf8'));
  assert.equal(runtime.pid, process.pid);
  assert.equal(runtime.version, pkgVersion);
  assert.equal(typeof runtime.updatedAt, 'number');

  await t.step(12000);
  await waitFor(() => t.dataPubs().length >= 2, 'live data');
  for (const p of t.dataPubs()) {
    assert.equal(p.topic, `${PREFIX}/devices/${DEV}/data`);
    const body = JSON.parse(p.payload);
    assert.ok(validators.validate('data', body).ok);
    assert.deepEqual(body.values, { cpu_load: 12.5 });
  }
});

test('a forced disconnect: Last Will retained, readings buffer, NO flush burst on reconnect, paced replay after 10 s', { timeout: 30000 }, async () => {
  const t = await setup();
  await startSynced(t);
  await t.step(11000);
  await waitFor(() => t.dataPubs().length >= 1, 'live data');
  const live0 = t.dataPubs().length;

  // The broker refuses the gateway for a while, so the outage lasts in gateway time.
  const authenticate = t.broker.aedes.authenticate;
  let refusing = true;
  let refused = 0;
  t.broker.aedes.authenticate = (client, u, p, cb) => {
    if (refusing && client.id === GW) { refused++; const e = new Error('unavailable'); e.returnCode = 3; cb(e, false); return; }
    authenticate(client, u, p, cb);
  };
  t.broker.kick(GW);
  await waitFor(() => t.broker.publishes(GW).some((p) => p.isWill), 'the Last Will');
  const will = t.broker.publishes(GW).find((p) => p.isWill);
  assert.deepEqual([will.payload, will.qos, will.retain], ['{"online":false}', 1, true]);
  await waitFor(() => t.gw.status().state !== 'online', 'offline');

  await t.step(30000);
  assert.equal(t.dataPubs().length, live0, 'nothing is published live while offline');
  const buffered = t.gw.status().buffer.records;
  assert.ok(buffered >= 5, `buffered ${buffered}`);
  assert.ok(refused >= 3, `the gateway kept retrying (${refused})`);

  refusing = false;
  for (let i = 0; i < 120 && t.gw.status().state !== 'online'; i++) await t.step(1000);
  await waitFor(() => t.pubs('firmware/response').length === 2, 'back online');
  const back = t.connects().filter((e) => e.type === 'connect').at(-1).at;
  const STEP = 250; // broker-side stamps can lag the gateway's clock by up to one step
  await t.step(20000, STEP);
  await waitFor(() => t.gw.status().buffer.records === 0, 'buffer drained');

  // No burst: after the reconnect, live data keeps its interval (5 s, judged by the readings'
  // own timestamps, which is what the platform checks) — nothing from the outage is flushed
  // live — and the replay starts only once the link has held for 10 s.
  const liveAfter = t.dataPubs().filter((p) => p.at >= back).map((p) => JSON.parse(p.payload).ts);
  assert.ok(liveAfter.length >= 3, `live data resumed (${liveAfter.length})`);
  for (let i = 1; i < liveAfter.length; i++) assert.ok(liveAfter[i] - liveAfter[i - 1] >= 5000, `live gap ${liveAfter[i] - liveAfter[i - 1]} ms`);
  const replay = t.pubs('data/backfill');
  assert.ok(replay.length >= 1, 'replayed');
  assert.ok(replay[0].at - back >= 10000 - STEP, `replay began ${replay[0].at - back} ms after the reconnect`);
  for (let i = 1; i < replay.length; i++) assert.ok(replay[i].at - replay[i - 1].at >= 1000 - STEP, 'one batch per second');
  const records = t.pubs('data/backfill').flatMap((p) => {
    const body = JSON.parse(p.payload);
    assert.ok(validators.validate('data-backfill', body).ok);
    assert.ok(Buffer.byteLength(p.payload) <= 3500);
    return body.batch;
  });
  assert.ok(records.length >= buffered);
  const ts = records.map((r) => r.ts);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'oldest first');
  assert.ok(records.every((r) => r.deviceId === DEV));
});

test('a refused subscription (SUBACK 0x80) → ACL_DENIED: nothing published, disconnect, one retry per 5 minutes', { timeout: 20000 }, async () => {
  const t = await setup({
    users: { '123456': { password: 'gw-secret-pw', prefix: PREFIX, denySubscribe: ['macros/run'] }, backend: { password: 'backend-pw' } },
  });
  await t.gw.start();
  await waitFor(() => t.broker.events.some((e) => e.type === 'disconnect' && e.clientId === GW), 'disconnect');
  assert.equal(t.pubs().length, 0, 'no heartbeat, no capabilities');
  assert.equal(t.broker.publishes(GW).some((p) => p.isWill), false, 'a clean disconnect, no Last Will');
  assert.ok(t.log.lines.some((l) => l.level === 'error' && l.msg.includes('ACL_DENIED') && l.msg.includes(`${PREFIX}/macros/run`)));
  assert.equal(t.connects().length, 1);
  await t.step(299_000, 10_000);
  assert.equal(t.connects().length, 1, 'no retry before 5 minutes');
  await t.step(2000);
  await waitFor(() => t.connects().length === 2, 'the 5-minute retry');
});

test('graceful stop: retained {"online":false} at QoS 1 BEFORE the DISCONNECT, no Last Will, lock released', { timeout: 20000 }, async () => {
  const t = await setup();
  await startSynced(t);
  const dir = t.gw.state.dir;
  await t.gw.stop();
  const tail = t.broker.events.filter((e) => e.clientId === GW).slice(-2);
  assert.equal(tail[0].type, 'publish');
  assert.equal(tail[0].topic, `${PREFIX}/status`);
  assert.equal(tail[0].payload, '{"online":false}');
  assert.equal(tail[0].qos, 1);
  assert.equal(tail[0].retain, true);
  assert.equal(tail[0].isWill, false);
  assert.deepEqual([tail[1].type, tail[1].graceful], ['disconnect', true]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.broker.publishes(GW).some((p) => p.isWill), false);
  assert.equal(existsSync(join(dir, 'run.lock')), false);
  const runtime = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
  assert.equal(runtime.state, 'stopped');
  assert.equal(runtime.connected, false);
  assert.equal(t.gw.status().state, 'stopped');
  assert.equal(t.driver.stats.closed, 1, 'device handles closed');
  assert.equal(t.clock.pending(), 0, 'every gateway timer was cleared');
});

test('in-process restart: offline status, reconnect, the stored config runs before the platform answers', { timeout: 20000 }, async () => {
  const t = await setup();
  await startSynced(t);
  const hash = fnv1a32(hostConfigBytes());
  await t.gw.restart();
  await waitFor(() => t.pubs('firmware/response').length === 2, 'second connect');
  assert.equal(t.pubs('status').filter((p) => p.payload === '{"online":false}').length, 1);
  assert.deepEqual(t.gw.status().devices.map((d) => d.id), [DEV], 'devices running from the stored config');
  assert.equal(t.driver.stats.opened, 2);
  await t.step(2000);
  await waitFor(() => t.pubs('config/request').length === 3, 'request after restart');
  assert.deepEqual(JSON.parse(t.pubs('config/request')[2].payload), { hash });
  await waitFor(() => t.gw.status().configSynced, 'synced');
  assert.equal(t.driver.stats.opened, 2, 'unchanged → not re-applied');
});

test('a stored config starts reading (into the buffer) before the broker is reachable', { timeout: 20000 }, async () => {
  const home = tempHome();
  const t1 = await setup({ home });
  await startSynced(t1);
  await t1.gw.stop();
  // Second life: broker unreachable.
  const clock = createFakeClock(Date.UTC(2026, 0, 2));
  const driver = fakeHostDriver();
  const gw = createGateway({ config: gatewayConfig('mqtt://127.0.0.1:1'), home, clock, log: createMemoryLogger(), drivers: [driver.def], random: () => 0.5 });
  cleanups.push(() => gw.stop());
  await gw.start();
  assert.equal(driver.stats.opened, 1);
  assert.equal(gw.status().configHash, fnv1a32(hostConfigBytes()));
  for (let i = 0; i < 20; i++) { await clock.advance(1000); await new Promise((r) => setTimeout(r, 2)); }
  assert.ok(driver.stats.reads >= 3);
  assert.ok(gw.status().buffer.records >= 3, 'offline readings are buffered');
});

test('takeover: three drops within 5 s of CONNACK → a warning about another instance', { timeout: 20000 }, async () => {
  const t = await setup();
  await t.gw.start();
  for (let i = 1; i <= 3; i++) {
    await waitFor(() => t.pubs('firmware/response').length === i, `connection ${i}`);
    t.broker.kick(GW);
    await waitFor(() => t.gw.status().state !== 'online', `drop ${i}`);
    if (i < 3) await t.step(2 ** (i - 1) * 1000, 500);
  }
  await waitFor(() => t.log.lines.some((l) => /session takeover/.test(l.msg)), 'takeover warning');
});

test('rejected credentials: a clear message, and the backoff grows to a 5-minute cap', { timeout: 30000 }, async () => {
  const t = await setup({ configOver: { password: 'wrong' } });
  await t.gw.start();
  const delays = [];
  for (let i = 0; i < 11; i++) {
    await waitFor(() => t.log.lines.filter((l) => l.msg === 'reconnecting').length === i + 1, `retry ${i}`);
    const d = t.log.lines.filter((l) => l.msg === 'reconnecting').at(-1).fields.inMs;
    delays.push(d);
    await t.step(d, Math.max(1000, d / 4));
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]);
  assert.ok(t.log.lines.some((l) => l.level === 'error' && /re-run `synacl-gateway init`/.test(l.msg)));
  assert.equal(t.log.text().includes('wrong'), false, 'the password never reaches the log');
});

test('network backoff: 1 s doubling to a 60 s cap', { timeout: 20000 }, async () => {
  const clock = createFakeClock();
  const log = createMemoryLogger();
  const home = tempHome();
  const gw = createGateway({ config: gatewayConfig('mqtt://127.0.0.1:1'), home, clock, log, drivers: [fakeHostDriver().def], random: () => 0.5 });
  cleanups.push(async () => { await gw.stop(); rmSync(home, { recursive: true, force: true }); });
  await gw.start();
  const delays = [];
  for (let i = 0; i < 9; i++) {
    await waitFor(() => log.lines.filter((l) => l.msg === 'reconnecting').length === i + 1, `retry ${i}`);
    const d = log.lines.filter((l) => l.msg === 'reconnecting').at(-1).fields.inMs;
    delays.push(d);
    await clock.advance(d);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test('jitter stays within ±20 %', { timeout: 20000 }, async () => {
  for (const r of [0, 1 - 1e-9]) {
    const clock = createFakeClock();
    const log = createMemoryLogger();
    const home = tempHome();
    const gw = createGateway({ config: gatewayConfig('mqtt://127.0.0.1:1'), home, clock, log, drivers: [fakeHostDriver().def], random: () => r });
    await gw.start();
    await waitFor(() => log.lines.some((l) => l.msg === 'reconnecting'), 'retry');
    const d = log.lines.find((l) => l.msg === 'reconnecting').fields.inMs;
    assert.equal(d, r === 0 ? 800 : 1200);
    await gw.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a second instance with the same identity is refused with LockHeldError', { timeout: 20000 }, async () => {
  const t = await setup();
  await t.gw.start();
  const other = createGateway({ config: t.config, home: t.home, clock: t.clock, log: createMemoryLogger(), drivers: [fakeHostDriver().def] });
  await assert.rejects(other.start(), (e) => e instanceof LockHeldError && e.code === 'ELOCKED');
});

test('retained commands are ignored (a retained restart would loop forever)', { timeout: 20000 }, async () => {
  const t = await setup();
  await t.cloud.publish(`${PREFIX}/cmd`, '{"command":"restart"}', { qos: 1, retain: true });
  await startSynced(t);
  await t.step(3000);
  await flush();
  assert.equal(t.pubs('status').filter((p) => p.payload === '{"online":false}').length, 0);
  assert.ok(t.log.lines.some((l) => /retained command/.test(l.msg)));
});

test('the platform restart command restarts in-process', { timeout: 20000 }, async () => {
  const t = await setup();
  await startSynced(t);
  await t.cloud.publish(`${PREFIX}/cmd`, '{"command":"restart"}', { qos: 1 });
  await waitFor(() => t.pubs('firmware/response').length === 2, 'reconnected after restart');
  assert.equal(t.pubs('status').filter((p) => p.payload === '{"online":false}').length, 1);
});

test('reset/config: stored config and overrides are dropped; the next request asks with hash 0', { timeout: 20000 }, async () => {
  const t = await setup();
  await startSynced(t);
  await t.cloud.publish(`${PREFIX}/cmd`, '{"command":"reset/config"}', { qos: 1 });
  await waitFor(() => t.pubs('firmware/response').length === 2, 'reconnected after reset');
  await t.step(2000);
  await waitFor(() => t.pubs('config/request').length >= 3, 'request after reset');
  assert.deepEqual(JSON.parse(t.pubs('config/request')[2].payload), { hash: 0 });
});

test('reload(): same identity re-requests; a changed credential restarts', { timeout: 20000 }, async () => {
  const t = await setup();
  await startSynced(t);
  assert.equal(await t.gw.reload({ ...t.config, log: { level: 'info', format: 'text' } }), 'requested');
  await waitFor(() => t.pubs('config/request').length === 3, 're-request');
  assert.equal(await t.gw.reload({ ...t.config }), 'requested');
  assert.equal(await t.gw.reload({ ...t.config, configCap: 4096 }), 'restarted');
  await waitFor(() => t.pubs('firmware/response').length === 2, 'reconnected');
  await t.step(2000);
  await waitFor(() => t.pubs('config/request').some((p) => JSON.parse(p.payload).cap === 4096), 'cap now sent');
});

test('the broker password is redacted from every log line', { timeout: 20000 }, async () => {
  const t = await setup();
  await startSynced(t);
  await t.gw.stop();
  assert.equal(t.log.text().includes('gw-secret-pw'), false);
});
