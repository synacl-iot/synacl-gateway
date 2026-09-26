// host driver against stubbed systeminformation / os.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostDriver, describeHostMetrics, createHostSampler, HOST_METRICS } from '../../src/drivers/host.js';
import { createCaptureLog, createFakeClock, makeCtx, makeDevice } from '../_support/drivers/helpers.js';

/** A systeminformation stub; each call counts, and fields can be overridden per test. */
function stubSi(over = {}) {
  const calls = { currentLoad: 0, networkStats: 0, fsSize: 0, cpuTemperature: 0, mem: 0 };
  let net = over.net ?? [{ rx_sec: null, tx_sec: null }, { rx_sec: 1250.004, tx_sec: 500 }];
  const si = {
    calls,
    async cpuTemperature() {
      calls.cpuTemperature++;
      return { main: over.temp === undefined ? 48.456 : over.temp };
    },
    async currentLoad() {
      calls.currentLoad++;
      return { currentLoad: over.load ?? 12.3456 };
    },
    async mem() {
      calls.mem++;
      return over.mem ?? { total: 8_000, available: 2_000, free: 100 };
    },
    async fsSize() {
      calls.fsSize++;
      return over.fs ?? [
        { fs: '/dev/root', mount: '/', size: 1000, used: 400, use: 41.67 },
        { fs: '/dev/sda1', mount: '/data', size: 1000, used: 900, use: 90.12 },
      ];
    },
    async networkInterfaceDefault() {
      return 'eth0';
    },
    async networkStats(iface) {
      calls.networkStats++;
      const s = net.length > 1 ? net.shift() : net[0];
      return [{ iface, ...s }];
    },
  };
  return si;
}

const stubOs = (over = {}) => ({
  platform: () => over.platform ?? 'linux',
  loadavg: () => over.loadavg ?? [0.456, 0.3, 0.2],
  uptime: () => over.uptime ?? 12345.9,
});

const allTags = HOST_METRICS.map((m) => ({ name: m.metric.replace('.', '_'), metric: m.metric }));

async function openHost({ si = stubSi(), os = stubOs(), options = {}, tags = allTags, clock } = {}) {
  const log = createCaptureLog();
  const drv = createHostDriver({ si, os }).create(makeCtx({ log, options, clock }));
  const device = makeDevice({ protocol: 'host', tags });
  const handle = await drv.open(device);
  return { drv, handle, device, log, si };
}

test('every metric, rounded to 2 decimals; bps = bytes × 8; reachable', async () => {
  const { drv, handle, device, si } = await openHost();
  assert.equal(si.calls.currentLoad, 1, 'cpu.load primed at open');
  assert.equal(si.calls.networkStats, 1, 'network primed at open');
  const r = await drv.read(handle, device.tags, { reason: 'interval', signal: new AbortController().signal });
  assert.equal(r.reachable, true);
  assert.deepEqual(r.values, {
    cpu_temp: 48.46,
    cpu_load: 12.35,
    load_1m: 0.46,
    mem_used_pct: 75,
    disk_used_pct: 41.67,
    uptime_s: 12345,
    net_rx_bps: 10000.03,
    net_tx_bps: 4000,
  });
  for (const v of Object.values(r.values)) assert.equal(Number.isFinite(v), true);
  await drv.close(handle);
  await drv.close(handle); // idempotent
});

test('a tag reads only what it asks for; missing metric key falls back to the tag name', async () => {
  const { drv, handle, si } = await openHost({ tags: [{ name: 'uptime_s' }] });
  const r = await drv.read(handle, [{ name: 'uptime_s', metric: '' }], { reason: 'interval' });
  assert.deepEqual(r.values, { uptime_s: 12345 });
  assert.equal(si.calls.fsSize, 0, 'disk not sampled when nobody asked for it');
});

test('unavailable metrics are OMITTED (never 0) and warned once each', async () => {
  const si = stubSi({ temp: null, mem: { total: 0, available: 0 }, net: [{ rx_sec: -1, tx_sec: -1 }] });
  const clock = createFakeClock();
  const { drv, handle, device, log } = await openHost({ si, clock, options: { diskPath: '/nope' } });
  const fsOnlyRoot = [{ mount: '/boot', size: 1, used: 1, use: 100 }];
  si.fsSize = async () => fsOnlyRoot;
  clock.advance(10_000); // past the network warm-up window
  const r1 = await drv.read(handle, device.tags, { reason: 'interval' });
  const r2 = await drv.read(handle, device.tags, { reason: 'interval' });
  for (const r of [r1, r2]) {
    assert.equal(r.reachable, true);
    for (const k of ['cpu_temp', 'mem_used_pct', 'disk_used_pct', 'net_rx_bps', 'net_tx_bps']) {
      assert.equal(k in r.values, false, `${k} omitted`);
      assert.equal(typeof r.errors[k], 'string');
    }
    assert.equal(r.values.cpu_load, 12.35);
  }
  const warns = log.lines.filter((l) => l.level === 'warn');
  assert.equal(warns.length, 5, warns.map((w) => w.msg).join('\n'));
  assert.match(log.text(), /cpu\.temp is unavailable/);
});

test('the first network sample is quietly skipped, then published', async () => {
  const clock = createFakeClock();
  const { drv, handle, log } = await openHost({ clock, si: stubSi({ net: [{ rx_sec: null, tx_sec: null }, { rx_sec: null, tx_sec: null }, { rx_sec: 100, tx_sec: 50 }] }) });
  const tags = [{ name: 'rx', metric: 'net.rx_bps' }, { name: 'tx', metric: 'net.tx_bps' }];
  const r1 = await drv.read(handle, tags, { reason: 'interval' });
  assert.deepEqual(r1.values, {});
  assert.equal(log.lines.filter((l) => l.level === 'warn').length, 0, 'no warning while warming up');
  clock.advance(1000);
  const r2 = await drv.read(handle, tags, { reason: 'interval' });
  assert.deepEqual(r2.values, { rx: 800, tx: 400 });
});

test('load.1m is omitted on Windows', async () => {
  const { drv, handle } = await openHost({ os: stubOs({ platform: 'win32' }), tags: [{ name: 'l', metric: 'load.1m' }] });
  const r = await drv.read(handle, [{ name: 'l', metric: 'load.1m' }], { reason: 'interval' });
  assert.deepEqual(r.values, {});
  assert.match(r.errors.l, /Windows/);
});

test('disk.used_pct follows options.diskPath (exact mount, else the longest containing mount)', async () => {
  for (const [diskPath, want] of [['/data', 90.12], ['/data/synacl', 90.12], ['/home/pi', 41.67], ['/', 41.67]]) {
    const { drv, handle } = await openHost({ options: { diskPath }, tags: [{ name: 'd', metric: 'disk.used_pct' }] });
    const r = await drv.read(handle, [{ name: 'd', metric: 'disk.used_pct' }], { reason: 'interval' });
    assert.equal(r.values.d, want, diskPath);
  }
});

test('unknown metric keys are omitted and warned once', async () => {
  const tags = [{ name: 'bogus', metric: 'gpu.temp' }, { name: 'u', metric: 'uptime_s' }];
  const { drv, handle, log } = await openHost({ tags });
  await drv.read(handle, tags, { reason: 'interval' });
  const r = await drv.read(handle, tags, { reason: 'interval' });
  assert.deepEqual(r.values, { u: 12345 });
  assert.match(r.errors.bogus, /unknown host metric/);
  const warns = log.lines.filter((l) => l.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0].msg, /unknown metric "gpu\.temp"/);
});

test('a failing systeminformation call omits only its metric', async () => {
  const si = stubSi();
  si.fsSize = async () => {
    throw new Error('df exploded');
  };
  const tags = [{ name: 'd', metric: 'disk.used_pct' }, { name: 'u', metric: 'uptime_s' }];
  const { drv, handle } = await openHost({ si, tags });
  const r = await drv.read(handle, tags, { reason: 'interval' });
  assert.deepEqual(r.values, { u: 12345 });
  assert.match(r.errors.d, /df exploded/);
});

test('describeHostMetrics: one row per metric, with sources, for the CLI', async () => {
  // systeminformation answers from cache within 500 ms, so a sample right after prime() has no rate.
  const si = stubSi({ temp: -1, net: [{ rx_sec: null, tx_sec: null }, { rx_sec: null, tx_sec: null }, { rx_sec: 1, tx_sec: 1 }] });
  const rows = await describeHostMetrics({ si, os: stubOs(), diskPath: '/data' });
  assert.deepEqual(rows.map((r) => r.metric), HOST_METRICS.map((m) => m.metric));
  const by = Object.fromEntries(rows.map((r) => [r.metric, r]));
  assert.equal(by['cpu.temp'].available, false);
  assert.equal(typeof by['cpu.temp'].reason, 'string');
  assert.equal(by['disk.used_pct'].value, 90.12);
  assert.equal(by['net.rx_bps'].available, false, 'no second sample yet without settleMs');
  for (const r of rows) assert.equal(typeof r.source, 'string');

  // A primed sampler reused across calls (the --watch path) reports the rates.
  const sampler = createHostSampler({ si: stubSi(), os: stubOs() });
  await sampler.prime();
  const again = await describeHostMetrics({ sampler });
  assert.equal(again.find((r) => r.metric === 'net.tx_bps').value, 4000);
});
