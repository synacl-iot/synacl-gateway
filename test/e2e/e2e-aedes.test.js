// End to end over a real socket: the whole gateway (core + transport + scripted drivers) against
// an in-process aedes broker whose hooks behave like the platform's broker, and the scripted platform as an MQTT client.
// Real time, so the scenarios here are the ones only a real broker can prove: the Last Will,
// retained state, no burst flushed after a forced disconnect, and SUBACK denial.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqtt from 'mqtt';
import { createGateway } from '../../src/core/gateway.js';
import { createScriptedCloud } from '../../src/conformance/scripted-cloud.js';
import { createDriverControls, createScriptedDrivers } from '../../src/conformance/scripted-drivers.js';
import { createMemoryLogger, linesContaining } from '../../src/conformance/memory-log.js';
import { fileConfig } from '../../src/conformance/harness.js';
import { configPayload, device, deviceId } from '../../src/conformance/fixtures.js';
import { connectCloud, once, realClock, sleep, startAedes, waitFor, withTimeout } from '../_support/verify/aedes-world.js';

const TENANT = '64b7a10000000000000000e1';
const GW = 'gw_e2e_01';
const USER = '700001';
const PASS = 'e2e-broker-secret-Zq81';
const PREFIX = `tenants/${TENANT}/sources/gateway/${GW}`;
const DEV = deviceId(0x77);

let world;
let cloudLink;
let cloud;
const homes = [];
const running = [];

before(async () => {
  world = await startAedes({ users: { [USER]: { password: PASS, prefix: PREFIX } } });
  cloudLink = await connectCloud(world);
  cloud = createScriptedCloud({ broker: cloudLink, clock: realClock, plan: 's2' });
  cloud.register({ tenant: TENANT, gateway: GW, config: configPayload([device(DEV, { tickDuration: 1_000, tags: [{ name: 'flow' }, { name: 'level' }] })]) });
});

after(async () => {
  // A failed assertion can leave a gateway running; stop it before the broker goes away.
  if (world) world.refuseConnects = false;
  for (const gw of running) await withTimeout(gw.stop(), 5_000);
  cloud?.detach();
  await cloudLink?.close();
  await world?.close();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function newGateway(overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'synacl-e2e-'));
  homes.push(home);
  const log = createMemoryLogger();
  const controls = createDriverControls({ readLatencyMs: 10 });
  const config = fileConfig(realClock, { broker: world.url, tenant: TENANT, gateway: GW, username: USER, password: PASS, log: { level: 'debug', format: 'json' }, ...overrides });
  const gw = createGateway({ config, home, clock: realClock, drivers: createScriptedDrivers(controls), log });
  running.push(gw);
  return { gw, log, controls, config };
}

// Real time: every test is bounded so a regression fails fast instead of hanging the suite.
describe('gateway ⇄ aedes (platform-like ACL) ⇄ scripted platform', { timeout: 120_000 }, () => {
  let g;

  test('connects, subscribes (7 granted), syncs its config and publishes data', async () => {
    g = newGateway();
    await g.gw.start();
    assert.ok(await waitFor(() => cloud.configCurrent(TENANT, GW) === true, 15_000), 'config synced');
    assert.ok(await waitFor(() => cloud.up('gateway.device-data', DEV).length >= 3, 8_000), 'data flows');
    const subs = world.subscribes.filter((s) => s.clientId === GW);
    assert.equal(subs.length, 7);
    assert.ok(subs.every((s) => s.granted === 1));
    assert.equal(cloud.rate.violations(), 0);
    assert.deepEqual(cloud.problems, [], 'every uplink valid, right topic and retain flag');
  });

  test('its presence is retained: a late subscriber sees {"online":true}', async () => {
    const c = mqtt.connect(world.url, { clientId: 'late-reader', username: 'backend', password: 'backend-secret-e2e', protocolVersion: 4, reconnectPeriod: 0 });
    try {
      await once(c, 'connect', 5_000, 'reader connect');
      const got = once(c, 'message', 5_000, 'retained status');
      await c.subscribeAsync(`${PREFIX}/status`);
      const [, payload, packet] = await got;
      const m = { body: JSON.parse(payload), retain: packet.retain };
      assert.equal(m.retain, true);
      assert.equal(m.body.online, true);
    } finally {
      await withTimeout(c.endAsync(), 2_000);
    }
  });

  test('a forced disconnect publishes the will; the reconnect flushes no burst; the gap is replayed on data/backfill', async () => {
    const t0 = Date.now();
    world.refuseConnects = true;
    const unblock = setTimeout(() => { world.refuseConnects = false; }, 10_000);   // never strand the suite
    assert.ok(world.destroy(GW), 'gateway connection found');
    assert.ok(await waitFor(() => cloud.up('gateway.status').some((u) => u.arrivedAt >= t0 && u.lwt && u.raw.toString() === '{"online":false}'), 3_000), 'will {"online":false} delivered');
    assert.equal(cloud.gatewayOnline(TENANT, GW), false);
    await sleep(3_500);                       // offline: readings go to the buffer
    const outageEnd = Date.now();
    world.refuseConnects = false;
    clearTimeout(unblock);
    assert.ok(await waitFor(() => cloud.gatewayOnline(TENANT, GW), 15_000), 'reconnected');
    const back = Date.now();
    await sleep(1_500);
    const liveAfter = cloud.up('gateway.device-data', DEV).filter((u) => u.arrivedAt >= back - 1_000 && u.arrivedAt <= back + 1_500);
    assert.ok(liveAfter.length <= 3, `no burst on reconnect (${liveAfter.length} live messages in 2.5 s at a 1 s interval)`);
    const replayedLive = cloud.up('gateway.device-data', DEV).filter((u) => u.body && u.body.ts > t0 + 500 && u.body.ts < outageEnd - 500);
    assert.equal(replayedLive.length, 0, 'readings taken offline never go out on the live topic');
    assert.ok(await waitFor(() => cloud.up('gateway.data-backfill').length > 0, 20_000), 'buffer replayed on data/backfill');
    const records = cloud.up('gateway.data-backfill').flatMap((u) => u.body.batch);
    assert.ok(records.some((r) => r.ts > t0 && r.ts < outageEnd), 'the outage is covered by replayed records');
    assert.equal(cloud.rate.violations(), 0);
    assert.deepEqual(cloud.problems, []);
  });

  test('a graceful stop says goodbye itself and leaves no will', async () => {
    const t0 = Date.now();
    await g.gw.stop();
    await sleep(300);
    const mine = world.published.filter((p) => p.clientId === GW && p.at >= t0);
    const bye = mine.find((p) => p.topic === `${PREFIX}/status`);
    assert.ok(bye, 'goodbye published');
    assert.equal(bye.payload.toString(), '{"online":false}');
    assert.equal(bye.retain, true);
    assert.equal(bye.lwt, false);
    assert.equal(mine.filter((p) => p.lwt).length, 0, 'no will after a graceful disconnect');
    assert.equal(linesContaining(g.log, [PASS]).length, 0, 'the broker password never reached a log line');
  });

  test('refused subscriptions (identity/credential mismatch): the gateway stops and publishes nothing', async () => {
    const other = newGateway({ tenant: '64b7a10000000000000000e2' });
    const t0 = Date.now();
    await other.gw.start();
    assert.ok(await waitFor(() => world.subscribes.filter((s) => s.clientId === GW && s.granted === 128).length >= 7, 8_000), 'SUBACK 128 for the foreign prefix');
    assert.ok(await waitFor(() => !world.client(GW), 5_000), 'the gateway ended the session');
    await sleep(500);
    const sent = world.published.filter((p) => p.clientId === GW && p.at >= t0);
    const denied = world.denied.filter((d) => d.clientId === GW);
    assert.equal(sent.length + denied.length, 0, `nothing published (${sent.map((p) => p.topic).join(', ')})`);
    assert.ok(other.log.lines.some((l) => (l.level === 'error' || l.level === 'warn') && /denied|refused|match/i.test(l.msg)), 'the log explains it');
    await other.gw.stop();
  });
});
