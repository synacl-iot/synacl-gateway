import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/cli/args.js';
import { createMetricsCommand } from '../../src/cli/metrics.js';
import { makeIo, sampleConfig, signals, tmpHome } from '../_support/cli/helpers.js';

const ROWS = [
  { metric: 'cpu.temp', label: 'CPU temperature', unit: '°C', source: 'cpuTemperature()', available: false, reason: 'no sensor' },
  { metric: 'cpu.load', label: 'CPU load', unit: '%', source: 'currentLoad()', available: true, value: 12.5 },
];

function fakeHost() {
  const calls = { describe: [], samplers: [] };
  return {
    calls,
    describeHostMetrics: async (opts) => { calls.describe.push(opts); return ROWS; },
    createHostSampler: (opts) => { const s = { opts, primed: false, async prime() { s.primed = true; } }; calls.samplers.push(s); return s; },
  };
}

test('one-shot: a table with value, unit, source, and the reason when unavailable', async (t) => {
  const home = tmpHome(t);
  const host = fakeHost();
  const io = makeIo({ home });
  assert.equal(await createMetricsCommand({ host })([], io), EXIT.OK);
  assert.match(io.out(), /cpu\.load\s+12\.5\s+%\s+currentLoad\(\)/);
  assert.match(io.out(), /cpu\.temp\s+—\s+°C\s+cpuTemperature\(\) — no sensor/);
  assert.deepEqual(host.calls.describe[0], { diskPath: '/', settleMs: 1000 });
});

test('--json; host.diskPath from config.json, SYNACL_HOST_DISK_PATH wins', async (t) => {
  const home = tmpHome(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify(sampleConfig({ host: { diskPath: '/srv' } })));
  let host = fakeHost();
  let io = makeIo({ home });
  await createMetricsCommand({ host, now: () => 1 })(['--json'], io);
  assert.deepEqual(JSON.parse(io.out()), { ts: 1, diskPath: '/srv', metrics: ROWS });
  host = fakeHost();
  io = makeIo({ home, env: { SYNACL_HOST_DISK_PATH: '/data' } });
  await createMetricsCommand({ host })(['--json'], io);
  assert.equal(host.calls.describe[0].diskPath, '/data');
});

test('--watch primes one sampler, prints each tick, stops on SIGINT', async (t) => {
  const home = tmpHome(t);
  const host = fakeHost();
  const sig = signals();
  let ticks = 0;
  const sleep = async () => { ticks += 1; if (ticks === 3) sig.emit('SIGINT'); };
  const io = makeIo({ home });
  assert.equal(await createMetricsCommand({ host, signals: sig, sleep, now: () => 0 })(['--watch', '2', '--json'], io), EXIT.OK);
  assert.equal(host.calls.samplers.length, 1);
  assert.equal(host.calls.samplers[0].primed, true);
  assert.equal(host.calls.describe.length, 2);
  assert.ok(host.calls.describe.every((o) => o.sampler === host.calls.samplers[0]));
  assert.equal(io.out().trim().split('\n').length, 2, 'one JSON document per line');
  assert.equal(sig.listenerCount('SIGINT'), 0);
});

test('--watch must be 1..3600 seconds', async (t) => {
  const io = makeIo({ home: tmpHome(t) });
  for (const v of ['0', 'abc', '4000']) assert.equal(await createMetricsCommand({ host: fakeHost() })(['--watch', v], io), EXIT.USAGE);
});
