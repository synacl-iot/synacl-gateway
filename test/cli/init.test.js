import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { EXIT, loadFileConfig } from '../../src/cli/args.js';
import { createInitCommand, writeConfigAtomic } from '../../src/cli/init.js';
import { openState } from '../../src/core/state.js';
import { GATEWAY, ONE_LINER, OWNER, PASSWORD, makeIo, sampleConfig, tmpHome } from '../_support/cli/helpers.js';

const posix = process.platform !== 'win32';
const okVerify = async () => ({ ok: true, stage: 'suback', grants: [1, 1, 1, 1, 1, 1, 1], message: 'ok' });
const argsWith = (over) => ONE_LINER.slice(1).map((a, i, all) => (i > 0 && over[all[i - 1]] !== undefined ? over[all[i - 1]] : a));

test('config.json is written 0600 in a 0700 home, with every FileConfig key', { skip: !posix && 'POSIX modes' }, async (t) => {
  const home = join(tmpHome(t), 'nested', '.synacl-gateway');
  const io = makeIo({ home });
  assert.equal(await createInitCommand({ verify: okVerify })(ONE_LINER.slice(1), io), EXIT.OK, io.all());
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  const doc = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(doc), ['schema', 'broker', 'tenant', 'gateway', 'username', 'password', 'api', 'tls', 'drivers', 'driverDir',
    'configCap', 'minIntervalMs', 'backfill', 'host', 'bridge', 'log', 'createdAt']);
  assert.deepEqual(doc.backfill, { maxBytes: 67108864, maxAgeHours: 168, batchIntervalMs: 1000 });
  assert.deepEqual(doc.tls, { caFile: null, rejectUnauthorized: true });
  assert.match(io.out(), /Saved .*config\.json/);
  assert.match(io.out(), /Next: synacl-gateway run/);
});

test('an existing loose home dir is tightened to 0700', { skip: !posix && 'POSIX modes' }, async (t) => {
  const home = tmpHome(t);
  chmodSync(home, 0o755);
  await createInitCommand({ verify: okVerify })(ONE_LINER.slice(1), makeIo({ home }));
  assert.equal(statSync(home).mode & 0o777, 0o700);
});

test('the write is atomic: no temp files are left and the old file is replaced whole', async (t) => {
  const home = tmpHome(t);
  const path = join(home, 'config.json');
  writeConfigAtomic(path, { a: 1 });
  writeConfigAtomic(path, sampleConfig());
  assert.deepEqual(readdirSync(home), ['config.json']);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).password, PASSWORD);
});

test('a failed write leaves the previous config intact and exits 1', { skip: (!posix || process.getuid?.() === 0) && 'needs a non-root POSIX user' }, async (t) => {
  const home = tmpHome(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify(sampleConfig({ username: 'old' })), { mode: 0o600 });
  const io = makeIo({ home });
  chmodSync(home, 0o500);
  try {
    assert.equal(await createInitCommand({ verify: okVerify })(ONE_LINER.slice(1), io), EXIT.RUNTIME);
  } finally {
    chmodSync(home, 0o700);
  }
  assert.match(io.err(), /cannot write .*EACCES/);
  assert.equal(loadFileConfig({ home }).config.username, 'old');
});

test('re-running init keeps hand-tuned settings but replaces identity and TLS', async (t) => {
  const home = tmpHome(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify(sampleConfig({
    password: 'OldPassword0000000000000', drivers: ['synacl-driver-x'], minIntervalMs: 250, log: { level: 'debug', format: 'json' }, custom: 42,
  })));
  const io = makeIo({ home });
  assert.equal(await createInitCommand({ verify: okVerify })(ONE_LINER.slice(1), io), EXIT.OK);
  const { config } = loadFileConfig({ home });
  assert.equal(config.password, PASSWORD);
  assert.deepEqual(config.drivers, ['synacl-driver-x']);
  assert.equal(config.minIntervalMs, 250);
  assert.equal(config.log.level, 'debug');
  assert.equal(config.custom, 42);
  assert.doesNotMatch(io.out(), /replaces gateway/);
});

test('switching identity says where the old gateway\'s state stays', async (t) => {
  const home = tmpHome(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify(sampleConfig({ gateway: 'old-gateway-1' })));
  const io = makeIo({ home });
  assert.equal(await createInitCommand({ verify: okVerify })(ONE_LINER.slice(1), io), EXIT.OK);
  const oldDir = openState({ home, tenant: OWNER, gateway: 'old-gateway-1' }).dir;
  assert.ok(io.out().includes(`This replaces gateway old-gateway-1. Its state and any buffered readings stay in ${oldDir}`), io.out());
  assert.equal(loadFileConfig({ home }).config.gateway, GATEWAY);
});

test('a failed connection check exits 3 with the specific message; the file is still saved', async (t) => {
  const home = tmpHome(t);
  let seen;
  const verify = async (opts) => {
    seen = opts;
    return { ok: false, stage: 'connack', code: 5, message: 'the broker rejected the username/password (CONNACK 5)', hint: 'Copy the line again.' };
  };
  const io = makeIo({ home });
  assert.equal(await createInitCommand({ verify })(ONE_LINER.slice(1), io), EXIT.CONNECT);
  assert.match(io.err(), /rejected the username\/password \(CONNACK 5\)/);
  assert.match(io.err(), /settings were saved/);
  assert.match(seen.clientId, new RegExp(`^${GATEWAY}-init-[0-9a-f]{4}$`), 'never the gateway id itself');
  assert.equal(seen.config.password, PASSWORD);
  assert.ok(!io.all().includes(PASSWORD));
  assert.equal(loadFileConfig({ home }).config.gateway, GATEWAY);
});

test('--no-verify skips the connection', async (t) => {
  const home = tmpHome(t);
  const io = makeIo({ home });
  const verify = async () => { throw new Error('must not connect'); };
  assert.equal(await createInitCommand({ verify })([...ONE_LINER.slice(1), '--no-verify'], io), EXIT.OK);
  assert.match(io.out(), /skipped \(--no-verify\)/);
});

test('a live run.lock skips the check and asks for a restart', async (t) => {
  const home = tmpHome(t);
  const st = openState({ home, tenant: OWNER, gateway: GATEWAY });
  mkdirSync(st.dir, { recursive: true });
  // The parent process is alive and on this host: exactly what a running `run` looks like.
  writeFileSync(join(st.dir, 'run.lock'), JSON.stringify({ pid: process.ppid, startedAt: Date.now(), hostname: hostname() }));
  const io = makeIo({ home });
  const verify = async () => { throw new Error('must not connect while an instance runs'); };
  assert.equal(await createInitCommand({ verify })(ONE_LINER.slice(1), io), EXIT.OK);
  assert.match(io.out(), /already running for this gateway \(pid \d+\)/);
  assert.match(io.out(), /restart the service to pick up the new settings/i);
});

test('--pass-stdin reads the first line from a pipe; --pass and --pass-stdin together is an error', async (t) => {
  const home = tmpHome(t);
  const stdin = new PassThrough();
  const io = makeIo({ home, stdin });
  const argv = ONE_LINER.slice(1, -2).concat('--pass-stdin');
  const p = createInitCommand({ verify: okVerify })(argv, io);
  stdin.end(`${PASSWORD}\n`);
  assert.equal(await p, EXIT.OK, io.all());
  assert.equal(loadFileConfig({ home }).config.password, PASSWORD);
  assert.ok(!io.all().includes(PASSWORD));

  const io2 = makeIo({ home });
  assert.equal(await createInitCommand({ verify: okVerify })([...ONE_LINER.slice(1), '--pass-stdin'], io2), EXIT.USAGE);
  assert.match(io2.err(), /either --pass or --pass-stdin/);

  const io3 = makeIo({ home, stdin: new PassThrough().end() });
  assert.equal(await createInitCommand({ verify: okVerify })(argv, io3), EXIT.USAGE);
  assert.match(io3.err(), /no password entered/);
});

test('a password that is not 24 base62 is accepted with a warning', async (t) => {
  const home = tmpHome(t);
  const io = makeIo({ home });
  assert.equal(await createInitCommand({ verify: okVerify })(argsWith({ '--pass': 'short-pass!' }), io), EXIT.OK);
  assert.match(io.err(), /does not look like one the platform generates/);
  assert.ok(!io.all().includes('short-pass!'));
});

test('TLS flags: --ca is stored as an absolute path, a missing --ca file is a usage error, --insecure-tls warns', async (t) => {
  const home = tmpHome(t);
  const ca = join(home, 'ca.pem');
  writeFileSync(ca, '-----BEGIN CERTIFICATE-----\n');
  let io = makeIo({ home });
  assert.equal(await createInitCommand({ verify: okVerify })([...ONE_LINER.slice(1), '--ca', ca], io), EXIT.OK);
  assert.equal(loadFileConfig({ home }).config.tls.caFile, ca);

  io = makeIo({ home });
  assert.equal(await createInitCommand({ verify: okVerify })([...ONE_LINER.slice(1), '--ca', join(home, 'missing.pem')], io), EXIT.USAGE);
  assert.match(io.err(), /cannot read the --ca file/);

  io = makeIo({ home });
  assert.equal(await createInitCommand({ verify: okVerify })([...ONE_LINER.slice(1), '--insecure-tls'], io), EXIT.OK);
  assert.match(io.err(), /verification is OFF/);
  assert.equal(loadFileConfig({ home }).config.tls.rejectUnauthorized, false);
});

test('--api overrides the derived address; a non-mqtt.* host without --api gets null and a note', async (t) => {
  const home = tmpHome(t);
  let io = makeIo({ home });
  await createInitCommand({ verify: okVerify })([...argsWith({ '--broker': 'mqtts://broker.example.org:8883' })], io);
  assert.equal(loadFileConfig({ home }).config.api, null);
  assert.match(io.out(), /--api https:\/\/api\.<your-domain>/);
  io = makeIo({ home });
  await createInitCommand({ verify: okVerify })([...argsWith({ '--broker': 'mqtts://broker.example.org:8883' }), '--api', 'https://iot.example.org/'], io);
  assert.equal(loadFileConfig({ home }).config.api, 'https://iot.example.org');
  io = makeIo({ home }); // re-init from the app's line (no --api) keeps it for the same broker
  await createInitCommand({ verify: okVerify })([...argsWith({ '--broker': 'mqtts://broker.example.org:8883' })], io);
  assert.equal(loadFileConfig({ home }).config.api, 'https://iot.example.org');
  io = makeIo({ home });
  assert.equal(await createInitCommand({ verify: okVerify })([...ONE_LINER.slice(1), '--api', 'ftp://x'], io), EXIT.USAGE);
});

test('--config writes to another path', async (t) => {
  const home = tmpHome(t);
  const other = join(home, 'elsewhere', 'gw.json');
  assert.equal(await createInitCommand({ verify: okVerify })([...ONE_LINER.slice(1), '--config', other], makeIo({ home })), EXIT.OK);
  assert.equal(loadFileConfig({ home, configPath: other }).config.gateway, GATEWAY);
});

test('from the npx cache the next step suggests a global install', async (t) => {
  const home = tmpHome(t);
  const io = makeIo({ home });
  await createInitCommand({ verify: okVerify, argv1: '/home/pi/.npm/_npx/1a2b/node_modules/.bin/synacl-gateway' })(ONE_LINER.slice(1), io);
  assert.match(io.out(), /npm i -g synacl-gateway, then synacl-gateway service install/);
});

test('--help prints usage and exits 0', async (t) => {
  const io = makeIo({ home: tmpHome(t) });
  assert.equal(await createInitCommand()(['--help'], io), EXIT.OK);
  assert.match(io.out(), /Usage: synacl-gateway init --broker/);
});

test('examples/config.example.json has exactly the keys init writes, and loads', async (t) => {
  const home = tmpHome(t);
  await createInitCommand({ verify: okVerify })(ONE_LINER.slice(1), makeIo({ home }));
  const written = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const examplePath = new URL('../../examples/config.example.json', import.meta.url);
  const example = JSON.parse(readFileSync(examplePath, 'utf8'));
  assert.deepEqual(Object.keys(example), Object.keys(written));
  for (const k of ['tls', 'backfill', 'host', 'bridge', 'log']) assert.deepEqual(Object.keys(example[k]), Object.keys(written[k]), k);
  assert.equal(loadFileConfig({ home, configPath: fileURLToPath(examplePath) }).config.gateway, 'my-gateway-01');
});
