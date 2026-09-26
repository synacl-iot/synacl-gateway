import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../../src/cli/args.js';
import { collectSecrets, main, resolveHome } from '../../src/cli/main.js';
import { redactingStream } from '../../src/cli/output.js';
import { version } from '../../src/index.js';
import { ONE_LINER, PASSWORD, capture, makeIo, tmpHome } from '../_support/cli/helpers.js';

const BIN = fileURLToPath(new URL('../../bin/synacl-gateway.js', import.meta.url));

test('--version prints the package version', async (t) => {
  const io = makeIo({ home: tmpHome(t) });
  assert.equal(await main(['--version'], io), EXIT.OK);
  assert.equal(io.out(), `${version}\n`);
});

test('help, help <cmd>, no command and unknown commands', async (t) => {
  const home = tmpHome(t);
  let io = makeIo({ home });
  assert.equal(await main(['help'], io), EXIT.OK);
  assert.match(io.out(), /Usage: synacl-gateway <command>/);

  io = makeIo({ home });
  assert.equal(await main(['help', 'init'], io), EXIT.OK);
  assert.match(io.out(), /Usage: synacl-gateway init --broker/);

  io = makeIo({ home });
  assert.equal(await main([], io), EXIT.USAGE);
  assert.match(io.err(), /Usage:/);

  io = makeIo({ home });
  assert.equal(await main(['frobnicate'], io), EXIT.USAGE);
  assert.match(io.err(), /unknown command "frobnicate"/);

  io = makeIo({ home });
  assert.equal(await main([PASSWORD], io), EXIT.USAGE);
  assert.ok(!io.all().includes(PASSWORD), 'a password in the command position is not echoed');

  io = makeIo({ home });
  assert.equal(await main(['help', 'nope'], io), EXIT.USAGE);
});

test('dispatch hands argv after the subcommand and the io to the module', async (t) => {
  const home = tmpHome(t);
  const io = makeIo({ home });
  let got;
  const load = async (spec) => ({ default: async (argv, cio) => { got = { spec, argv, cio }; return 4; } });
  assert.equal(await main(['conformance', '--offline', '--json'], io, { load }), 4);
  assert.match(got.spec, /\/src\/cli\/conformance\.js$/);
  assert.deepEqual(got.argv, ['--offline', '--json']);
  assert.equal(got.cio, io);
});

test('a command module missing from the build exits 1 with a message', async (t) => {
  const io = makeIo({ home: tmpHome(t) });
  const load = async (spec) => { const e = new Error(`Cannot find module '${spec}'`); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; };
  assert.equal(await main(['doctor'], io, { load }), EXIT.RUNTIME);
  assert.match(io.err(), /not available in this build/);
});

test('SYNACL_GATEWAY_HOME resolves, default ~/.synacl-gateway', () => {
  assert.match(resolveHome({}), /[\\/]\.synacl-gateway$/);
  assert.equal(resolveHome({ SYNACL_GATEWAY_HOME: '/data' }).replace(/^[A-Z]:/, '').replace(/\\/g, '/'), '/data');
});

test('the redaction net: --pass values and password env vars never reach the streams', () => {
  assert.deepEqual(collectSecrets(['init', '--pass', 'abcdefgh', '--pass=ijklmnop'], { SYNACL_PASS: 'qrstuvwx' }), ['abcdefgh', 'ijklmnop', 'qrstuvwx']);
  const sink = capture({ isTTY: true });
  const s = redactingStream(sink, ['abcdefgh', 'abc']);
  s.write('pw=abcdefgh and abc stays\n');
  assert.equal(sink.text(), 'pw=*** and abc stays\n');
  assert.equal(s.isTTY, true);
});

test('the real bin: --version, an old-style one-liner failure, and no password on any stream', { timeout: 30000 }, (t) => {
  const home = tmpHome(t);
  const env = { ...process.env, SYNACL_GATEWAY_HOME: home };
  const v = spawnSync(process.execPath, [BIN, '--version'], { env, encoding: 'utf8' });
  assert.equal(v.status, 0);
  assert.equal(v.stdout.trim(), version);

  const argv = ONE_LINER.map((a) => (a === 'mqtts://mqtt.synacl.com:8883' ? 'mqtt://:1883' : a));
  const r = spawnSync(process.execPath, [BIN, ...argv], { env, encoding: 'utf8' });
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.stderr, /no public MQTT hostname — use --broker mqtt:\/\/<your-broker-host>:1883/);
  assert.ok(!(r.stdout + r.stderr).includes(PASSWORD));
});
