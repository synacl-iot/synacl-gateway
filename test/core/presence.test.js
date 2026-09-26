import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPresence, detectNet } from '../../src/core/presence.js';
import { createPublisher } from '../../src/core/publisher.js';
import {
  createFakeClock, createFakeTransport, createTopics, createValidators, createMemoryLogger, devId, flush,
} from '../_support/core-runtime/fakes.js';

function setup({ devices = [], extras = {} } = {}) {
  const clock = createFakeClock();
  const transport = createFakeTransport(clock);
  const validators = createValidators();
  const publisher = createPublisher({ transport, topics: createTopics(), validators, clock, log: createMemoryLogger(), strict: true });
  const list = { devices };
  const presence = createPresence({
    publisher, clock, version: '0.1.0',
    getDevices: () => list.devices,
    getHeartbeatExtras: () => ({ bufRam: 0, bufFlash: 12, bufDropped: 3, flashErrors: 0, simMode: false, ...extras }),
    netInfo: () => ({ ip: '192.168.1.50', uplink: 'ethernet' }),
  });
  const heartbeats = () => transport.bySuffix('status');
  const statuses = (id) => transport.bySuffix(`devices/${id}/status`);
  return { clock, transport, validators, presence, list, heartbeats, statuses };
}

test('heartbeat: no ts, retained QoS 0, schema-valid, carries ip/fw/uplink/buffer counters/simMode', async () => {
  const s = setup();
  await s.presence.heartbeatNow();
  const [hb] = s.heartbeats();
  assert.equal(hb.retain, true);
  assert.equal(hb.qos, 0);
  assert.ok(!('ts' in hb.body), 'the platform stamps the heartbeat with its own clock');
  assert.deepEqual(hb.body, { online: true, ip: '192.168.1.50', fw: '0.1.0', uplink: 'ethernet', bufRam: 0, bufFlash: 12, bufDropped: 3, flashErrors: 0, simMode: false });
  assert.ok(s.validators.validate('source-status', hb.body).ok);
});

test('heartbeat: unknown extras are dropped, missing counters default to 0, a bad uplink is omitted', () => {
  const clock = createFakeClock();
  const p = createPresence({
    publisher: {}, clock, getDevices: () => [], version: '1.2.3',
    getHeartbeatExtras: () => ({ bogus: 1, simMode: true }),
    netInfo: () => ({ ip: '10.0.0.2', uplink: 'carrier-pigeon' }),
  });
  assert.deepEqual(p.heartbeatBody(), { online: true, ip: '10.0.0.2', fw: '1.2.3', simMode: true, bufRam: 0, bufFlash: 0, bufDropped: 0, flashErrors: 0 });
});

test('heartbeat every 60 s after start(); start() itself does not send one', async () => {
  const s = setup();
  s.presence.start();
  await flush();
  assert.equal(s.heartbeats().length, 0);
  await s.clock.advance(60000 * 5 + 1);
  const at = s.heartbeats().map((m) => m.at);
  assert.equal(at.length, 5);
  assert.ok(at.slice(1).every((t, i) => t - at[i] === 60000));
  s.presence.stop();
  await s.clock.advance(300000);
  assert.equal(s.heartbeats().length, 5);
});

test('device status: every device at least every 30 s, first round staggered', async () => {
  const ids = [devId(1), devId(2), devId(3)];
  const s = setup({ devices: ids.map((id) => ({ id, reachable: true })) });
  const t0 = s.clock.now();
  s.presence.start();
  await s.clock.advance(300000);
  for (const [k, id] of ids.entries()) {
    const at = s.statuses(id).map((m) => m.at);
    assert.equal(at[0] - t0, Math.round(((k + 1) / 4) * 30000));
    assert.ok(at.slice(1).every((t, i) => t - at[i] <= 30000), `device ${k} went quiet for more than 30 s`);
    for (const m of s.statuses(id)) {
      assert.equal(m.retain, true);
      assert.ok(Number.isInteger(m.body.ts));
      assert.ok(s.validators.validate('device-status', m.body).ok);
    }
  }
  s.presence.stop();
});

test('transition: published immediately and the device period restarts from there', async () => {
  const id = devId(1);
  const s = setup({ devices: [{ id, reachable: true }] });
  s.presence.start();
  await s.clock.advance(20000);
  s.list.devices = [{ id, reachable: false, reason: 'timeout' }];
  s.presence.transition(id, { reachable: false, reason: 'timeout' });
  await flush();
  const last = s.statuses(id).at(-1);
  assert.deepEqual({ reachable: last.body.reachable, reason: last.body.reason }, { reachable: false, reason: 'timeout' });
  assert.equal(last.at, s.clock.now());
  const n = s.statuses(id).length;
  await s.clock.advance(29999);
  assert.equal(s.statuses(id).length, n);
  await s.clock.advance(1);
  assert.equal(s.statuses(id).length, n + 1);
  s.presence.stop();
});

test('transition while stopped (offline) publishes nothing', async () => {
  const s = setup({ devices: [{ id: devId(1), reachable: true }] });
  s.presence.transition(devId(1), { reachable: false });
  await flush();
  assert.equal(s.transport.sent.length, 0);
});

test('a paused device reports reachable:true; unknown reachability is not published', async () => {
  const s = setup({ devices: [
    { id: devId(1), reachable: false, reason: 'x', paused: 'manual' },
    { id: devId(2), reachable: null },
  ] });
  s.presence.start();
  await s.clock.advance(60000);
  assert.ok(s.statuses(devId(1)).length >= 2);
  assert.ok(s.statuses(devId(1)).every((m) => m.body.reachable === true && !('reason' in m.body)));
  assert.equal(s.statuses(devId(2)).length, 0);
  s.presence.stop();
});

test('devices added later are picked up; removed devices stop', async () => {
  const s = setup({ devices: [{ id: devId(1), reachable: true }] });
  s.presence.start();
  await s.clock.advance(31000);
  s.list.devices = [{ id: devId(2), reachable: true }];
  await s.clock.advance(60000);
  const n1 = s.statuses(devId(1)).length;
  assert.ok(s.statuses(devId(2)).length >= 2);
  await s.clock.advance(60000);
  assert.equal(s.statuses(devId(1)).length, n1);
  s.presence.stop();
});

test('goodbye: {"online":false} retained at QoS 1', async () => {
  const s = setup();
  await s.presence.goodbye();
  const [m] = s.heartbeats();
  assert.equal(m.text, '{"online":false}');
  assert.equal(m.qos, 1);
  assert.equal(m.retain, true);
});

// ─── detectNet ─────────────────────────────────────────────────────────────────────────

const ROUTES = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0101A8C0\t0003\t0\t0\t202\t00000000\t0\t0\t0
wlan0\t00000000\t0101A8C0\t0003\t0\t0\t303\t00000000\t0\t0\t0
eth0\t0001A8C0\t00000000\t0001\t0\t0\t202\t00FFFFFF\t0\t0\t0`;

const IFACES = () => ({
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.20', family: 'IPv4', internal: false }],
  wlan0: [{ address: '192.168.1.21', family: 'IPv4', internal: false }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
});

test('detectNet (linux): the lowest-metric default route; wired → ethernet', () => {
  const n = detectNet({
    platform: 'linux', interfaces: IFACES, fsRead: () => ROUTES,
    fsExists: (p) => p === '/sys/class/net/eth0/device',
  });
  assert.deepEqual(n, { ip: '192.168.1.20', uplink: 'ethernet', iface: 'eth0' });
});

test('detectNet (linux): a wireless default interface → wifi; a virtual one → no uplink', () => {
  const wifiRoutes = ROUTES.replace('\t202\t00000000', '\t999\t00000000');
  const w = detectNet({ platform: 'linux', interfaces: IFACES, fsRead: () => wifiRoutes, fsExists: (p) => p === '/sys/class/net/wlan0/wireless' });
  assert.deepEqual(w, { ip: '192.168.1.21', uplink: 'wifi', iface: 'wlan0' });
  const v = detectNet({ platform: 'linux', interfaces: IFACES, fsRead: () => ROUTES, fsExists: () => false });
  assert.deepEqual(v, { ip: '192.168.1.20', iface: 'eth0' });
});

test('detectNet (other platforms): first physical-looking IPv4, no uplink', () => {
  const n = detectNet({ platform: 'darwin', interfaces: () => ({ lo0: IFACES().lo, utun3: [{ address: '10.8.0.2', family: 'IPv4', internal: false }], en0: IFACES().wlan0 }) });
  assert.deepEqual(n, { ip: '192.168.1.21', iface: 'en0' });
});
