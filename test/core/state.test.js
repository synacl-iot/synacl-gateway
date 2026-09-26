import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openState, stateDirFor, atomicWrite, LockHeldError, isPidAlive } from '../../src/core/state.js';
import { fnv1a32 } from '../../src/core/fnv.js';

const TENANT = '64b7a1000000000000000004';
const GW = 'gw_3f2a9c1e7b41';
const posix = process.platform !== 'win32';
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const home = () => { const d = mkdtempSync(join(tmpdir(), 'sgw-state-')); dirs.push(d); return d; };
const mode = (p) => statSync(p).mode & 0o777;
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

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

test('lock: run.lock holds pid, startedAt, hostname; unlock removes it', () => {
  const s = openState({ home: home(), tenant: TENANT, gateway: GW, clock: { now: () => 1234 } });
  s.lock();
  const body = JSON.parse(readFileSync(join(s.dir, 'run.lock'), 'utf8'));
  assert.deepEqual(body, { pid: process.pid, startedAt: 1234, hostname: hostname() });
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
