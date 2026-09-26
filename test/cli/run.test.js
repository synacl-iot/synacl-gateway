import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/cli/args.js';
import { createRunCommand } from '../../src/cli/run.js';
import { createLogger } from '../../src/core/log.js';
import { GATEWAY, OWNER, PASSWORD, makeIo, sampleConfig, signals, stubClock, stubGateway, tick, tmpHome, until } from '../_support/cli/helpers.js';

// run() ignores SIGHUP until start() has resolved; wait for that, not just for the call.
const started = async (gw) => { await until(() => gw.calls.start === 1); await tick(); };

function setup(t, { config = sampleConfig(), env = {}, gateway = {}, skew = null, platform = 'linux' } = {}) {
  const home = tmpHome(t);
  if (config) writeFileSync(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const io = makeIo({ home, env });
  const gw = stubGateway(gateway);
  const sig = signals();
  const clock = stubClock();
  const loggers = [];
  const run = createRunCommand({
    createGateway: gw.factory,
    createLogger: (opts) => { const l = createLogger({ ...opts, format: 'json' }); loggers.push({ opts, l }); return l; },
    probeSkew: async () => skew,
    clock,
    signals: sig,
    platform,
  });
  return { home, io, gw, sig, clock, run, loggers };
}

test('without a config: exit 2 pointing at Connection Info', async (t) => {
  const { io, run, gw } = setup(t, { config: null });
  assert.equal(await run([], io), EXIT.USAGE);
  assert.match(io.err(), /no configuration at/);
  assert.match(io.err(), /Gateways → Connection Info/);
  assert.equal(gw.calls.created.length, 0);
});

test('a live lock (LockHeldError from start) exits 6', async (t) => {
  const err = Object.assign(new Error('held'), { name: 'LockHeldError', code: 'ELOCKED', holder: { pid: 4242 } });
  const { io, run, sig } = setup(t, { gateway: { startError: err } });
  assert.equal(await run([], io), EXIT.LOCKED);
  assert.match(io.err(), /another synacl-gateway is running for this gateway \(pid 4242\)/);
  assert.equal(sig.listenerCount('SIGTERM'), 0, 'signal handlers removed');
});

test('any other start failure exits 1', async (t) => {
  const { io, run } = setup(t, { gateway: { startError: new Error('boom') } });
  assert.equal(await run([], io), EXIT.RUNTIME);
  assert.match(io.err(), /could not start/);
});

test('SIGTERM stops the gateway and exits 0; the password never reaches the output', async (t) => {
  const { io, run, gw, sig, loggers } = setup(t);
  const p = run([], io);
  await until(() => gw.calls.start === 1);
  assert.equal(gw.calls.created[0].config.password, PASSWORD);
  assert.equal(gw.calls.created[0].home, io.home);
  assert.equal(gw.calls.created[0].log, loggers[0].l);
  // Anything the core logs later is redacted too.
  loggers[0].l.info(`connecting with ${PASSWORD}`, { url: `mqtt://u:${PASSWORD}@h` });
  sig.emit('SIGTERM');
  assert.equal(await p, EXIT.OK);
  assert.equal(gw.calls.stop, 1);
  assert.ok(!io.all().includes(PASSWORD), io.all());
  assert.match(io.out(), /SIGTERM received/);
  assert.equal(sig.listenerCount('SIGTERM') + sig.listenerCount('SIGINT') + sig.listenerCount('SIGHUP'), 0);
});

test('a second signal during a slow shutdown exits 1', async (t) => {
  const { io, run, gw, sig } = setup(t, { gateway: { stopHangs: true } });
  const p = run([], io);
  await until(() => gw.calls.start === 1);
  sig.emit('SIGINT');
  sig.emit('SIGINT');
  assert.equal(await p, EXIT.RUNTIME);
  assert.match(io.err(), /received again/);
});

test('SIGHUP re-reads config.json and hands it to reload(); SIGHUP is not handled on Windows', async (t) => {
  const { io, run, gw, sig, home } = setup(t, { config: sampleConfig({ log: { level: 'info', format: 'json' } }) });
  const p = run([], io);
  await started(gw);
  writeFileSync(join(home, 'config.json'), JSON.stringify(sampleConfig({ password: 'NewPassword0000000000000', log: { level: 'debug' } })));
  sig.emit('SIGHUP');
  await until(() => gw.calls.reload.length === 1);
  assert.equal(gw.calls.reload[0].password, 'NewPassword0000000000000');
  await until(() => /asked the platform for the device configuration again/.test(io.out()));
  sig.emit('SIGTERM');
  assert.equal(await p, EXIT.OK);
  assert.ok(!io.all().includes('NewPassword0000000000000'), 'the new password is redacted as well');

  const w = setup(t, { platform: 'win32' });
  const pw = w.run([], w.io);
  await started(w.gw);
  assert.equal(w.sig.listenerCount('SIGHUP'), 0);
  w.sig.emit('SIGTERM');
  assert.equal(await pw, EXIT.OK);
});

test('SIGHUP with a broken config keeps running on the old settings', async (t) => {
  const { io, run, gw, sig, home } = setup(t);
  const p = run([], io);
  await started(gw);
  writeFileSync(join(home, 'config.json'), '{not json');
  sig.emit('SIGHUP');
  await until(() => /reload skipped/.test(io.err()));
  assert.equal(gw.calls.reload.length, 0);
  sig.emit('SIGTERM');
  assert.equal(await p, EXIT.OK);
});

test('a reload that runs into another instance\'s lock stops with exit 6', async (t) => {
  const err = Object.assign(new Error('held'), { name: 'LockHeldError', code: 'ELOCKED', holder: { pid: 7 } });
  const { io, run, gw, sig } = setup(t, { gateway: { reloadError: err } });
  const p = run([], io);
  await started(gw);
  sig.emit('SIGHUP');
  assert.equal(await p, EXIT.LOCKED);
  assert.equal(gw.calls.stop, 1);
});

test('environment overrides the file (Docker secrets via SYNACL_PASS_FILE)', async (t) => {
  const home0 = tmpHome(t);
  const secret = join(home0, 'pass');
  writeFileSync(secret, 'SecretFromDockerSecret00\n');
  const { io, run, gw, sig } = setup(t, { env: { SYNACL_PASS_FILE: secret, SYNACL_GATEWAY: 'other-gw', SYNACL_HOST_DISK_PATH: '/data' } });
  const p = run([], io);
  await until(() => gw.calls.start === 1);
  const { config } = gw.calls.created[0];
  assert.equal(config.password, 'SecretFromDockerSecret00');
  assert.equal(config.gateway, 'other-gw');
  assert.equal(config.tenant, OWNER);
  assert.equal(config.host.diskPath, '/data');
  sig.emit('SIGTERM');
  assert.equal(await p, EXIT.OK);
  assert.ok(!io.all().includes('SecretFromDockerSecret00'));
});

test('env-only mode needs no config.json', async (t) => {
  const env = { SYNACL_BROKER: 'mqtt://localhost:1883', SYNACL_TENANT: OWNER, SYNACL_GATEWAY: GATEWAY, SYNACL_USER: 'u', SYNACL_PASS: PASSWORD };
  const { io, run, gw, sig } = setup(t, { config: null, env });
  const p = run([], io);
  await until(() => gw.calls.start === 1);
  sig.emit('SIGTERM');
  assert.equal(await p, EXIT.OK);
  assert.match(io.out(), /"config":"environment"/);
});

test('flags pick the log level and format; bad values exit 2', async (t) => {
  const { io, run, gw, sig, loggers } = setup(t);
  const p = run(['--log-level', 'debug', '--log-format', 'text'], io);
  await until(() => gw.calls.start === 1);
  assert.equal(loggers[0].opts.level, 'debug');
  assert.equal(loggers[0].opts.format, 'text');
  sig.emit('SIGTERM');
  await p;
  const bad = setup(t);
  assert.equal(await bad.run(['--log-level', 'loud'], bad.io), EXIT.USAGE);
  assert.equal(await bad.run(['--log-format', 'xml'], bad.io), EXIT.USAGE);
  assert.equal(await bad.run(['--pass', 'x'], bad.io), EXIT.USAGE);
});

test('clock skew above 2 s is a warning; the 6-hour re-check is armed and cleared', async (t) => {
  const { io, run, gw, sig, clock } = setup(t, { skew: 5300 });
  const p = run([], io);
  await until(() => gw.calls.start === 1);
  await until(() => /system clock is 5\.3 s ahead of the platform/.test(io.err()));
  assert.equal(clock.timers.filter((h) => h.interval && h.ms === 6 * 3600 * 1000).length, 1);
  sig.emit('SIGTERM');
  assert.equal(await p, EXIT.OK);
  assert.equal(clock.timers.length, 0);
});

test('a group/world-readable config.json is warned about', { skip: process.platform === 'win32' && 'POSIX modes' }, async (t) => {
  const { io, run, gw, sig, home } = setup(t);
  const { chmodSync } = await import('node:fs');
  chmodSync(join(home, 'config.json'), 0o644);
  const p = run([], io);
  await until(() => gw.calls.start === 1);
  sig.emit('SIGTERM');
  await p;
  assert.match(io.err(), /readable by other users \(mode 644\)/);
});
