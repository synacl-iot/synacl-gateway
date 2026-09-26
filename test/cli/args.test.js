import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIT, GATEWAY_ID_RE, UsageError, checkBroker, deriveApi, isLocalHost, loadFileConfig, parseCommandArgs,
} from '../../src/cli/args.js';
import { createInitCommand } from '../../src/cli/init.js';
import { GATEWAY, ONE_LINER, OWNER, PASSWORD, makeIo, sampleConfig, tmpHome } from '../_support/cli/helpers.js';

const okVerify = async () => ({ ok: true, stage: 'suback', grants: [1, 1, 1, 1, 1, 1, 1], message: 'ok' });
const init = (deps = {}) => createInitCommand({ verify: okVerify, openState: () => ({ dir: '/x', lockHolder: () => null }), ...deps });

test('the exact one-liner from Connection Info parses and writes the config', async (t) => {
  const home = tmpHome(t);
  const io = makeIo({ home });
  const code = await init()(ONE_LINER.slice(1), io);
  assert.equal(code, EXIT.OK, io.all());
  const { config } = loadFileConfig({ home });
  assert.equal(config.broker, 'mqtts://mqtt.synacl.com:8883');
  assert.equal(config.tenant, OWNER);
  assert.equal(config.gateway, GATEWAY);
  assert.equal(config.username, '123456');
  assert.equal(config.password, PASSWORD);
  assert.equal(config.api, 'https://api.synacl.com');
  assert.ok(!io.all().includes(PASSWORD), 'password printed');
});

test('--flag=value works for every flag, including --pass=', async (t) => {
  const home = tmpHome(t);
  const io = makeIo({ home });
  const argv = ONE_LINER.slice(1).reduce((acc, a, i, all) => (i % 2 === 0 ? [...acc, `${a}=${all[i + 1]}`] : acc), []);
  assert.ok(argv.includes(`--pass=${PASSWORD}`));
  assert.equal(await init()(argv, io), EXIT.OK, io.all());
  assert.equal(loadFileConfig({ home }).config.password, PASSWORD);
  assert.ok(!io.all().includes(PASSWORD));
});

test('an empty broker host (mqtt://:1883) exits 2 with the explanation, before URL parsing', async (t) => {
  const home = tmpHome(t);
  for (const broker of ['mqtt://:1883', 'mqtts://:8883']) {
    const io = makeIo({ home });
    const argv = ONE_LINER.slice(1).map((a) => (a === 'mqtts://mqtt.synacl.com:8883' ? broker : a));
    assert.equal(await init()(argv, io), EXIT.USAGE);
    assert.match(io.err(), /no public MQTT hostname — use --broker mqtts?:\/\/<your-broker-host>:(1883|8883)/);
    assert.ok(!io.all().includes(PASSWORD));
  }
  assert.throws(() => checkBroker('mqtt://:1883'), (e) => e instanceof UsageError && e.code === 'EEMPTYHOST');
  assert.match(
    (() => { try { checkBroker('mqtt://:1883'); } catch (e) { return e.message; } })(),
    /use --broker mqtt:\/\/<your-broker-host>:1883/,
  );
});

test('the gateway id follows the app\'s chip-id rule', async (t) => {
  const home = tmpHome(t);
  for (const id of ['123456789012345', 'gw_3f2a9c1e7b41', 'sim-demo-gw-1', 'a:b.c-d_e']) assert.ok(GATEWAY_ID_RE.test(id), id);
  for (const bad of ['a/b', 'a+b', 'a#b', 'ab', 'has space', '-lead', 'x'.repeat(65)]) {
    const io = makeIo({ home });
    // `=` form, so "-lead" reaches the id check instead of parseArgs' dash-value guard.
    const argv = ONE_LINER.slice(1).filter((a) => a !== GATEWAY && a !== '--gateway').concat(`--gateway=${bad}`);
    assert.equal(await init()(argv, io), EXIT.USAGE, bad);
    assert.match(io.err(), /--gateway must be/);
  }
});

test('tenant must be 24 hex; upper case is accepted and stored lower case', async (t) => {
  const home = tmpHome(t);
  let io = makeIo({ home });
  assert.equal(await init()(ONE_LINER.slice(1).map((a) => (a === OWNER ? 'nothex' : a)), io), EXIT.USAGE);
  assert.match(io.err(), /--tenant/);
  io = makeIo({ home });
  assert.equal(await init()(ONE_LINER.slice(1).map((a) => (a === OWNER ? '64A00000000000000000000F' : a)), io), EXIT.OK);
  assert.equal(loadFileConfig({ home }).config.tenant, '64a00000000000000000000f');
});

test('unknown flags, stray arguments and missing values exit 2 without echoing values', async (t) => {
  const home = tmpHome(t);
  const cases = [
    [...ONE_LINER.slice(1), '--frobnicate'],
    [...ONE_LINER.slice(1), 'stray'],
    ['--broker', 'mqtts://h:8883', '--tenant', OWNER, '--gateway', GATEWAY, '--user', 'u', '--pass'],
    [...ONE_LINER.slice(1), '--no-verify=yes'],
    ['--broker', 'mqtts://h:8883', '--tenant', OWNER, '--gateway', GATEWAY, '--user', 'u'],
  ];
  for (const argv of cases) {
    const io = makeIo({ home });
    assert.equal(await init()(argv, io), EXIT.USAGE, argv.join(' '));
    assert.match(io.err(), /^error: /);
    assert.ok(!io.all().includes(PASSWORD));
    assert.ok(!io.all().includes('stray'));
  }
  // A password that became a stray argument (unquoted space) is not repeated.
  const io = makeIo({ home });
  const split = ['--broker', 'mqtts://h:8883', '--tenant', OWNER, '--gateway', GATEWAY, '--user', 'u', '--pass', 'first', 'SecondHalfOfPassword'];
  assert.equal(await init()(split, io), EXIT.USAGE);
  assert.ok(!io.all().includes('SecondHalfOfPassword'));
});

test('parseCommandArgs names the unknown flag but never a value', () => {
  assert.throws(() => parseCommandArgs(['--nope'], {}), /unknown option --nope/);
  assert.throws(() => parseCommandArgs(['--x', 'Zq9Secret'], { x: { type: 'boolean' } }), (e) => e.exitCode === 2 && !e.message.includes('Zq9Secret'));
  assert.throws(() => parseCommandArgs(['--p', '-abc'], { p: { type: 'string' } }), /--p=<value>/);
  assert.equal(parseCommandArgs(['-h'], {}).values.help, true);
});

test('broker validation: schemes, credentials in the URL, clear-text warning', async (t) => {
  assert.throws(() => checkBroker('http://h:1883'), /must start with mqtt/);
  assert.throws(() => checkBroker('not a url'), /not a valid URL/);
  assert.throws(() => checkBroker('mqtt://u:secretpw@h:1883'), (e) => /must not contain credentials/.test(e.message) && !e.message.includes('secretpw'));
  assert.equal(checkBroker('wss://mqtt.synacl.com/mqtt').tls, true);
  assert.equal(checkBroker('mqtt://localhost:1883').local, true);

  const home = tmpHome(t);
  let io = makeIo({ home });
  await init()(ONE_LINER.slice(1).map((a) => (a.startsWith('mqtts://') ? 'mqtt://broker.example.com:1883' : a)), io);
  assert.match(io.err(), /clear text to broker\.example\.com/);
  io = makeIo({ home });
  await init()(ONE_LINER.slice(1).map((a) => (a.startsWith('mqtts://') ? 'mqtt://192.168.1.20:1883' : a)), io);
  assert.doesNotMatch(io.err(), /clear text/);
});

test('isLocalHost and deriveApi', () => {
  for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', '10.1.2.3', '172.20.0.5', '192.168.0.2', 'mosquitto', 'pi.local', 'fd00::1']) assert.ok(isLocalHost(h), h);
  for (const h of ['mqtt.synacl.com', '8.8.8.8', '172.32.0.1', 'example.org']) assert.ok(!isLocalHost(h), h);
  assert.equal(deriveApi('mqtts://mqtt.synacl.com:8883'), 'https://api.synacl.com');
  assert.equal(deriveApi('wss://mqtt.example.org/mqtt'), 'https://api.example.org');
  assert.equal(deriveApi('mqtt://localhost:1883'), 'http://localhost:8080');
  assert.equal(deriveApi('mqtt://10.0.0.2:1883'), null);
});

test('loadFileConfig: env overrides the file, SYNACL_PASS_FILE, env-only mode, missing config', (t) => {
  const home = tmpHome(t);
  assert.throws(() => loadFileConfig({ home, env: {} }), (e) => e.code === 'ENOCONFIG' && /Connection Info/.test(e.hint));

  const env = { SYNACL_BROKER: 'mqtt://localhost:1883', SYNACL_TENANT: OWNER, SYNACL_GATEWAY: GATEWAY, SYNACL_USER: 'u1', SYNACL_PASS: 'envpass' };
  const envOnly = loadFileConfig({ home, env });
  assert.equal(envOnly.fromFile, false);
  assert.equal(envOnly.config.password, 'envpass');
  assert.equal(envOnly.config.api, 'http://localhost:8080');
  assert.equal(envOnly.config.minIntervalMs, 1000);

  writeFileSync(join(home, 'config.json'), JSON.stringify(sampleConfig({ log: { level: 'debug' } })));
  const secret = join(home, 'secret');
  writeFileSync(secret, 'from-file-secret\n');
  const r = loadFileConfig({ home, env: { SYNACL_PASS_FILE: secret, SYNACL_HOST_DISK_PATH: '/data' } });
  assert.equal(r.config.password, 'from-file-secret');
  assert.equal(r.config.host.diskPath, '/data');
  assert.equal(r.config.log.level, 'debug');
  assert.equal(r.config.log.format, 'auto', 'section defaults filled in');
  assert.deepEqual(r.envKeys, ['SYNACL_PASS_FILE', 'SYNACL_HOST_DISK_PATH']);
  assert.throws(() => loadFileConfig({ home, env: { SYNACL_PASS: 'a', SYNACL_PASS_FILE: secret } }), /not both/);
  assert.throws(() => loadFileConfig({ home, env: { SYNACL_TENANT: 'bad' } }), /SYNACL_TENANT/);
});

test('a config.json that is not JSON is reported without quoting its content', (t) => {
  const home = tmpHome(t);
  writeFileSync(join(home, 'config.json'), `{"password": "${PASSWORD}", oops}`);
  assert.throws(() => loadFileConfig({ home }), (e) => e.code === 'ECONFIGJSON' && !e.message.includes(PASSWORD));
});
