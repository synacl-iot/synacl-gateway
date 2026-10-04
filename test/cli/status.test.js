import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT } from '../../src/cli/args.js';
import { createStatusCommand } from '../../src/cli/status.js';
import { openState } from '../../src/core/state.js';
import { GATEWAY, OWNER, PASSWORD, makeIo, sampleConfig, tmpHome } from '../_support/cli/helpers.js';

const NOW = Date.parse('2026-09-26T12:00:00Z');
// A start record no live process can match: a lock whose pid a restart handed to another process.
const FOREIGN_START = process.platform === 'linux'
  ? { kind: 'linux', boot: null, ticks: '1' }
  : { kind: 'ps', lstart: 'Thu Jan 1 00:00:00 1970' };

// The gateway takes its lock just before it records startedAt, so by default the lock is a
// moment older than RUNTIME.startedAt.
function setup(t, { runtime, lockPid, lockStartedAt = NOW - 7200e3 - 50, lockExtra = {} } = {}) {
  const home = tmpHome(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify(sampleConfig()));
  const st = openState({ home, tenant: OWNER, gateway: GATEWAY });
  mkdirSync(st.dir, { recursive: true });
  if (runtime) writeFileSync(join(st.dir, 'runtime.json'), JSON.stringify(runtime));
  if (lockPid) writeFileSync(join(st.dir, 'run.lock'), JSON.stringify({ pid: lockPid, startedAt: lockStartedAt, hostname: hostname(), ...lockExtra }));
  return { home, lockFile: join(st.dir, 'run.lock'), io: makeIo({ home }), status: createStatusCommand({ now: () => NOW }) };
}

const RUNTIME = {
  pid: 1, version: '0.1.0', state: 'online', startedAt: NOW - 7200e3, updatedAt: NOW - 5e3, connected: true,
  connectedSince: NOW - 3600e3, lastHeartbeatAt: NOW - 20e3, configHash: 3420619844, configSynced: true,
  devices: [
    { id: '64b7a1000000000000000002', protocol: 'host', intervalMs: 10000, lastDataTs: NOW - 4e3, reachable: true, paused: false },
    { id: '64b7a1000000000000000003', protocol: 'modbus-tcp', intervalMs: 5000, lastDataTs: null, reachable: false, reason: 'modbus/timeout', paused: false },
  ],
  buffer: { records: 12, bytes: 2048, dropped: 0, writeErrors: 0 },
};

test('running: process, MQTT, config sync, buffer and a device table', async (t) => {
  const { io, status } = setup(t, { runtime: RUNTIME, lockPid: process.ppid });
  assert.equal(await status([], io), EXIT.OK);
  const out = io.out();
  assert.match(out, /Process\s+running \(pid \d+, up 2h 0m, version 0\.1\.0\)/);
  assert.match(out, /MQTT\s+connected for 1h 0m/);
  assert.match(out, /Config\s+hash 3420619844, in sync with the platform/);
  assert.match(out, /Buffer\s+12 readings waiting \(2\.0 KiB\)/);
  assert.match(out, /64b7a1000000000000000003\s+modbus-tcp\s+5s\s+never\s+unreachable: modbus\/timeout/);
  assert.ok(!io.all().includes(PASSWORD));
});

test('stopped cleanly vs crashed vs never started', async (t) => {
  let s = setup(t, { runtime: { ...RUNTIME, state: 'stopped', connected: false, updatedAt: NOW - 600e3 } });
  await s.status([], s.io);
  assert.match(s.io.out(), /not running — stopped 10m 0s ago/);

  s = setup(t, { runtime: { ...RUNTIME, updatedAt: NOW - 90e3 } }); // no live lock, state still 'online'
  await s.status([], s.io);
  assert.match(s.io.out(), /not running — last seen 1m 30s ago \(it did not shut down cleanly\)/);

  s = setup(t);
  await s.status([], s.io);
  assert.match(s.io.out(), /no record of a previous run/);
  assert.match(s.io.out(), /sent here automatically/);
});

test('a lock whose pid now belongs to another process (container restart, reboot): not running, stale lock file reported and kept', { skip: process.platform === 'win32' && 'no process start time on Windows' }, async (t) => {
  // After `docker restart` the new pid namespace hands the old gateway's pid to whatever starts
  // first — kill(pid, 0) succeeds, and status used to print the dead run's runtime.json as live.
  const { io, status, lockFile } = setup(t, {
    runtime: { ...RUNTIME, updatedAt: NOW - 90e3 }, lockPid: process.ppid, lockExtra: { processStart: FOREIGN_START },
  });
  assert.equal(await status([], io), EXIT.OK);
  const out = io.out();
  assert.match(out, /Process\s+not running \(stale lock file: pid \d+ is now a different process\) — last seen 1m 30s ago \(it did not shut down cleanly\)/);
  assert.doesNotMatch(out, /MQTT|Heartbeat|running \(pid/);
  assert.match(out, /values above are from the last run/);
  assert.ok(existsSync(lockFile), 'status is read-only: `run` takes a stale lock over, status never deletes it');

  const j = setup(t, { runtime: RUNTIME, lockPid: process.ppid, lockExtra: { processStart: FOREIGN_START } });
  await j.status(['--json'], j.io);
  const doc = JSON.parse(j.io.out());
  assert.equal(doc.running, false);
  assert.equal(doc.pid, null);
  assert.deepEqual(doc.staleLock, { pid: process.ppid, hostname: hostname(), reason: 'pid-reused' });
  assert.equal(doc.runtimeCurrent, false);
});

test('a lock left by a process that exited: not running (stale lock file)', async (t) => {
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const { io, status } = setup(t, { runtime: { ...RUNTIME, updatedAt: NOW - 90e3 }, lockPid: dead });
  await status([], io);
  assert.match(io.out(), new RegExp(`not running \\(stale lock file: pid ${dead} has exited\\) — last seen 1m 30s ago`));
});

test('running, but runtime.json is still the previous run\'s: "starting up", not the old uptime and connection', async (t) => {
  // The restarted gateway took the lock 3 s ago and has not written its first snapshot yet.
  const { io, status } = setup(t, { runtime: RUNTIME, lockPid: process.ppid, lockStartedAt: NOW - 3e3 });
  assert.equal(await status([], io), EXIT.OK);
  const out = io.out();
  assert.match(out, /Process\s+running \(pid \d+, starting up\)/);
  assert.doesNotMatch(out, /up 2h|MQTT|Heartbeat|version 0\.1\.0/);
  assert.match(out, /values above are from the last run/);

  const j = setup(t, { runtime: RUNTIME, lockPid: process.ppid, lockStartedAt: NOW - 3e3 });
  await j.status(['--json'], j.io);
  const doc = JSON.parse(j.io.out());
  assert.equal(doc.running, true);
  assert.equal(doc.runtimeCurrent, false);
  assert.equal(doc.staleLock, null);
});

test('--json is one document with whitelisted fields and no credentials', async (t) => {
  const { io, status } = setup(t, { runtime: { ...RUNTIME, secretField: 'x' }, lockPid: process.ppid });
  assert.equal(await status(['--json'], io), EXIT.OK);
  const doc = JSON.parse(io.out());
  assert.equal(doc.running, true);
  assert.equal(doc.runtimeCurrent, true);
  assert.equal(doc.staleLock, null);
  assert.equal(doc.gateway, GATEWAY);
  assert.equal(doc.runtime.configHash, 3420619844);
  assert.equal(doc.runtime.secretField, undefined);
  assert.ok(!io.out().includes(PASSWORD));
  assert.ok(!('password' in doc) && !('username' in doc));
});

test('no config → exit 2', async (t) => {
  const io = makeIo({ home: tmpHome(t) });
  assert.equal(await createStatusCommand()([], io), EXIT.USAGE);
  assert.match(io.err(), /no configuration/);
});
