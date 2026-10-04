import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openState, stateDirFor, atomicWrite, LockHeldError, isPidAlive } from '../../src/core/state.js';
import { processStart } from '../../src/core/process-start.js';
import { fnv1a32 } from '../../src/core/fnv.js';

const TENANT = '64b7a1000000000000000004';
const GW = 'gw_3f2a9c1e7b41';
const posix = process.platform !== 'win32';
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const home = () => { const d = mkdtempSync(join(tmpdir(), 'sgw-state-')); dirs.push(d); return d; };
const mode = (p) => statSync(p).mode & 0o777;
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const STATE_JS = fileURLToPath(new URL('../../src/core/state.js', import.meta.url));
// Windows has no start time the lock can record; there the pid check is all there is.
const startsKnown = process.platform !== 'win32';
// A start record no live process can match (10 ms after boot; 1970): what a lock looks like
// once a container restart or a reboot has handed its pid to a different process.
const FOREIGN_START = process.platform === 'linux'
  ? { kind: 'linux', boot: null, ticks: '1' }
  : { kind: 'ps', lstart: 'Thu Jan 1 00:00:00 1970' };

test('the state dir is keyed to the identity and sanitised', () => {
  const h = home();
  const d = stateDirFor({ home: h, tenant: TENANT, gateway: 'AA:BB:CC/01' });
  const digest = createHash('sha256').update(`${TENANT}/AA:BB:CC/01`).digest('hex').slice(0, 8);
  assert.equal(d, join(h, 'state', `AA_BB_CC_01-${digest}`));
  assert.equal(openState({ home: h, tenant: TENANT, gateway: GW }).dir, stateDirFor({ home: h, tenant: TENANT, gateway: GW }));
});

test('opening and reading create nothing (read-only callers leave no trace)', () => {
  const h = home();
  const s = openState({ home: h, tenant: TENANT, gateway: GW });
  assert.equal(s.readConfigRaw(), null);
  assert.equal(s.readConfigMeta(), null);
  assert.equal(s.readRuntime(), null);
  assert.equal(s.lockHolder(), null);
  assert.deepEqual(s.readOverrides(), { v: 1, devices: {} });
  assert.deepEqual(s.readSeq(), { v: 1, devices: {} });
  assert.equal(existsSync(join(h, 'state')), false);
});

test('config bytes round-trip exactly; files 0600, dir 0700', () => {
  const s = openState({ home: home(), tenant: TENANT, gateway: GW });
  const bytes = Buffer.from('{"devices":[],"success":true,"x":"🌡 0.01"}');
  const meta = { hash: fnv1a32(bytes), bytes: bytes.length, receivedAt: 1, appliedAt: 2, via: 'reply' };
  s.writeConfigRaw(bytes, meta);
  const r = s.readConfigRaw();
  assert.ok(r.bytes.equals(bytes));
  assert.deepEqual(r.meta, meta);
  if (posix) {
    assert.equal(mode(s.dir), 0o700);
    for (const f of readdirSync(s.dir)) assert.equal(mode(join(s.dir, f)), 0o600, f);
  }
});

test('a meta/bytes hash mismatch returns null; only the lock holder discards the files', () => {
  const s = openState({ home: home(), tenant: TENANT, gateway: GW });
  s.writeConfigRaw(Buffer.from('{"devices":[],"success":true}'), { hash: 1 });
  assert.equal(s.readConfigRaw(), null);
  assert.ok(existsSync(join(s.dir, 'config.raw')), 'a reader without the lock must not delete');
  assert.deepEqual(s.readConfigMeta(), { hash: 1 });
  s.lock();
  assert.equal(s.readConfigRaw(), null);
  assert.equal(existsSync(join(s.dir, 'config.raw')), false);
  assert.equal(existsSync(join(s.dir, 'config.meta.json')), false);
  s.unlock();
});

test('a half-written pair (bytes without meta) is not trusted', () => {
  const s = openState({ home: home(), tenant: TENANT, gateway: GW });
  s.writeConfigRaw(Buffer.from('{}'), { hash: fnv1a32('{}') });
  rmSync(join(s.dir, 'config.meta.json'));
  assert.equal(s.readConfigRaw(), null);
  s.clearConfig();
  assert.equal(existsSync(join(s.dir, 'config.raw')), false);
});

test('atomic writes leave no temp files and replace content whole', () => {
  const dir = home();
  const f = join(dir, 'x.json');
  atomicWrite(f, 'one');
  atomicWrite(f, Buffer.from('two'));
  assert.equal(readFileSync(f, 'utf8'), 'two');
  assert.deepEqual(readdirSync(dir), ['x.json']);
  if (posix) assert.equal(mode(f), 0o600);
  // A failed rename (the target is a directory) cleans up its temp file.
  const d = join(dir, 'isdir');
  mkdirSync(d);
  assert.throws(() => atomicWrite(d, 'x'));
  assert.deepEqual(readdirSync(dir).sort(), ['isdir', 'x.json']);
});

test('overrides and runtime round-trip; corrupt files read as defaults', () => {
  const s = openState({ home: home(), tenant: TENANT, gateway: GW });
  const o = { v: 1, devices: { a: { intervalMs: 5000, intervalSetAt: 7 } } };
  s.writeOverrides(o);
  assert.deepEqual(s.readOverrides(), o);
  s.writeRuntime({ pid: 1, connected: true });
  assert.deepEqual(s.readRuntime(), { pid: 1, connected: true });
  writeFileSync(join(s.dir, 'overrides.json'), '{nope');
  assert.deepEqual(s.readOverrides(), { v: 1, devices: {} });
  writeFileSync(join(s.dir, 'runtime.json'), '');
  assert.equal(s.readRuntime(), null);
});

test('seq: saved counters come back as saved (the scheduler adds its safety margin); junk entries dropped', () => {
  const s = openState({ home: home(), tenant: TENANT, gateway: GW });
  s.writeSeq({ v: 1, devices: { a: 41, b: -1, c: 1.5, d: 'x' } });
  assert.deepEqual(s.readSeq(), { v: 1, devices: { a: 41 } });
});

test('lock: run.lock holds pid, startedAt, hostname and when this process started; unlock removes it', () => {
  const s = openState({ home: home(), tenant: TENANT, gateway: GW, clock: { now: () => 1234 } });
  s.lock();
  const { processStart: started, ...body } = JSON.parse(readFileSync(join(s.dir, 'run.lock'), 'utf8'));
  assert.deepEqual(body, { pid: process.pid, startedAt: 1234, hostname: hostname() });
  if (startsKnown) assert.deepEqual(started, processStart(process.pid));
  else assert.equal(started, undefined);
  assert.deepEqual(s.lockHolder(), { pid: process.pid, startedAt: 1234, hostname: hostname(), alive: true });
  if (posix) assert.equal(mode(join(s.dir, 'run.lock')), 0o600);
  s.unlock();
  assert.equal(existsSync(join(s.dir, 'run.lock')), false);
});

test('lock: a LIVE holder on this host → LockHeldError with the holder', () => {
  const s = openState({ home: home(), tenant: TENANT, gateway: GW });
  mkdirSync(s.dir, { recursive: true });
  const holder = { pid: process.ppid, startedAt: 5, hostname: hostname() };
  assert.ok(isPidAlive(process.ppid));
  writeFileSync(join(s.dir, 'run.lock'), JSON.stringify(holder));
  assert.throws(() => s.lock(), (err) => {
    assert.ok(err instanceof LockHeldError);
    assert.equal(err.name, 'LockHeldError');
    assert.equal(err.code, 'ELOCKED');
    assert.deepEqual(err.holder, holder);
    assert.equal(err.lockFile, join(s.dir, 'run.lock'));
    return true;
  });
  assert.equal(s.lockHolder().alive, true);
  s.unlock(); // not ours: must not remove it
  assert.ok(existsSync(join(s.dir, 'run.lock')));
});

test('lock: a dead pid, our own pid or another host is stale and taken over', () => {
  for (const holder of [
    { pid: deadPid(), startedAt: 1, hostname: hostname() },
    { pid: process.pid, startedAt: 1, hostname: hostname() },
    { pid: process.ppid, startedAt: 1, hostname: `${hostname()}-elsewhere` },
    { garbage: true },
  ]) {
    const s = openState({ home: home(), tenant: TENANT, gateway: GW });
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, 'run.lock'), JSON.stringify(holder));
    s.lock();
    assert.equal(JSON.parse(readFileSync(join(s.dir, 'run.lock'), 'utf8')).pid, process.pid, JSON.stringify(holder));
    s.unlock();
  }
  assert.equal(isPidAlive(deadPid()), false);
  assert.equal(isPidAlive(-1), false);
});

test('lock: a pid that now belongs to a DIFFERENT process (a container restart, a reboot) is stale and taken over', { skip: !startsKnown && 'no process start time on Windows' }, () => {
  const s = openState({ home: home(), tenant: TENANT, gateway: GW });
  mkdirSync(s.dir, { recursive: true });
  // Same host, and the pid answers kill(pid, 0) — but it is not the process that wrote the lock.
  assert.ok(isPidAlive(process.ppid));
  writeFileSync(join(s.dir, 'run.lock'), JSON.stringify({ pid: process.ppid, startedAt: 5, hostname: hostname(), processStart: FOREIGN_START }));
  const holder = s.lockHolder();
  assert.equal(holder.alive, false);
  assert.equal(holder.stale, 'pid-reused');
  // Before the fix this threw LockHeldError, and a service manager restarted it into the same
  // refusal (exit 6) for as long as the unrelated process lived.
  s.lock();
  assert.equal(JSON.parse(readFileSync(join(s.dir, 'run.lock'), 'utf8')).pid, process.pid);
  s.unlock();
});

test('lock: a live holder in another process is still live — no takeover', async () => {
  const h = home();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { openState } from ${JSON.stringify(pathToFileURL(STATE_JS).href)};
    openState(${JSON.stringify({ home: h, tenant: TENANT, gateway: GW })}).lock();
    process.stdout.write('locked\\n');
    setInterval(() => {}, 1e6);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { if (String(d).includes('locked')) resolve(); });
      child.once('exit', (code) => reject(new Error(`the lock holder exited (${code})`)));
    });
    const s = openState({ home: h, tenant: TENANT, gateway: GW });
    const holder = s.lockHolder();
    assert.equal(holder.pid, child.pid);
    assert.equal(holder.alive, true);
    assert.equal(holder.stale, undefined);
    assert.throws(() => s.lock(), LockHeldError);
  } finally {
    child.kill('SIGKILL');
  }
});

test('lock: no usable start record (a lock from 0.1.0, another platform, junk) → the pid check alone decides', () => {
  for (const extra of [{}, { processStart: { kind: 'from-a-later-version', start: 'x' } }, { processStart: 'junk' }, { processStart: null }]) {
    const s = openState({ home: home(), tenant: TENANT, gateway: GW });
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, 'run.lock'), JSON.stringify({ pid: process.ppid, startedAt: 5, hostname: hostname(), ...extra }));
    assert.equal(s.lockHolder().alive, true, JSON.stringify(extra));
    assert.throws(() => s.lock(), LockHeldError, JSON.stringify(extra));
  }
});

test('lock: a second instance in the same process is refused while the first holds it', () => {
  const h = home();
  const a = openState({ home: h, tenant: TENANT, gateway: GW });
  const b = openState({ home: h, tenant: TENANT, gateway: GW });
  a.lock();
  assert.throws(() => b.lock(), LockHeldError);
  a.unlock();
  b.lock();
  b.unlock();
});

test('identity switch: a different gateway gets a fresh dir; the old one is kept', () => {
  const h = home();
  const a = openState({ home: h, tenant: TENANT, gateway: GW });
  const b = openState({ home: h, tenant: TENANT, gateway: 'gw_other_one' });
  const c = openState({ home: h, tenant: '64b7a1000000000000000005', gateway: GW });
  assert.notEqual(a.dir, b.dir);
  assert.notEqual(a.dir, c.dir, 'same gateway id under another account is another identity');
  const bytes = Buffer.from('{"devices":[],"success":true}');
  a.writeConfigRaw(bytes, { hash: fnv1a32(bytes) });
  a.lock();
  assert.equal(b.readConfigRaw(), null);
  b.lock(); // independent locks
  assert.ok(a.readConfigRaw().bytes.equals(bytes));
  a.unlock();
  b.unlock();
});
