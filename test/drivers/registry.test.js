// Driver registry: built-ins, packages from the drivers directory, overrides, refusal of other
// API versions, and the contract guard around every instance.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDriverRegistry, BUILTIN_DRIVERS } from '../../src/drivers/index.js';
import { defineDriver } from '../../src/drivers/api.js';
import { createCaptureLog, makeDevice, realClock, waitFor } from '../_support/drivers/helpers.js';
import { startBroker } from '../_support/drivers/servers.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
let tmp;
let home;
let driverDir;

const pkg = (dir, json, files) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
};
const plainDriverSource = (name, protocol, apiVersion = 1) => `
export default {
  apiVersion: ${apiVersion}, name: ${JSON.stringify(name)}, protocols: [${JSON.stringify(protocol)}],
  capabilities: { sensorModels: { i2c: ['BME280'] } },
  create(ctx) {
    return {
      async open(device) { return device.id; },
      async read(h, tags) { return { values: { [tags[0].name]: 7 }, reachable: true }; },
      async close() {},
    };
  },
};
`;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'synacl-drivers-'));
  home = join(tmp, 'home');
  driverDir = join(home, 'drivers');
  const nm = join(driverDir, 'node_modules');
  pkg(driverDir, { private: true }, {});
  pkg(join(nm, 'synacl-driver-plain'), { name: 'synacl-driver-plain', type: 'module', main: 'index.js' }, { 'index.js': plainDriverSource('plain', 'plain') });
  // ESM-only: exports offers only the "import" condition, which a require-based resolve can't see.
  pkg(join(nm, 'synacl-driver-esm-only'), { name: 'synacl-driver-esm-only', type: 'module', exports: { '.': { import: './main.js' } } }, { 'main.js': plainDriverSource('esm-only', 'esm') });
  // The shipped example, installed the way a user would, able to import 'synacl-gateway/driver'.
  const ex = join(nm, 'synacl-driver-example');
  cpSync(join(repoRoot, 'examples/drivers/synacl-driver-example'), ex, { recursive: true, filter: (src) => !src.includes('node_modules') });
  symlinkSync(repoRoot, join(nm, 'synacl-gateway'), 'junction');
  writeFileSync(join(tmp, 'v2-driver.mjs'), plainDriverSource('from-the-future', 'future', 2));
  // Node < 22 loads a .js file outside a "type": "module" package as CommonJS.
  writeFileSync(join(tmp, 'esm-in-cjs.js'), plainDriverSource('confused', 'confused'));
  // A driver whose synacl-gateway peer is missing (installed with peers omitted).
  const lonely = join(tmp, 'lonely');
  pkg(lonely, { name: 'lonely', type: 'module', main: 'index.js' }, { 'index.js': "import { defineDriver } from 'synacl-gateway/driver';\nexport default defineDriver({});\n" });
  writeFileSync(join(tmp, 'overrides-host.mjs'), plainDriverSource('my-host', 'host'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const registry = (config = {}, extra = []) => {
  const log = createCaptureLog();
  return createDriverRegistry({ config: { gateway: 'gw-test-1', ...config }, home, log, clock: realClock, signal: new AbortController().signal, extra }).then((r) => ({ r, log }));
};

test('built-ins: host, mqtt-bridge, modbus-tcp; merged capabilities', async () => {
  const { r, log } = await registry();
  assert.deepEqual(r.protocols(), ['host', 'mqtt-bridge', 'modbus-tcp']);
  assert.deepEqual(r.capabilities(), { modbusFormats: true, sensorModels: {} });
  assert.equal(r.forProtocol('rs485'), null);
  for (const p of r.protocols()) {
    const inst = r.forProtocol(p);
    assert.equal(typeof inst.open, 'function');
    assert.equal(typeof inst.read, 'function');
    assert.equal(typeof inst.close, 'function');
  }
  assert.equal(typeof r.forProtocol('modbus-tcp').write, 'function');
  assert.equal(typeof r.forProtocol('mqtt-bridge').status, 'function');
  assert.equal(r.forProtocol('host').write, undefined, 'optional methods stay absent');
  assert.equal(r.forProtocol('host').status, undefined);
  assert.deepEqual(r.drivers().map((d) => d.name), ['host', 'mqtt-bridge', 'modbus-tcp']);
  assert.equal(log.lines.filter((l) => l.level !== 'debug').length, 0);
  assert.equal(BUILTIN_DRIVERS.length, 3);
});

test('packages from the drivers directory load after the built-ins (incl. ESM-only and the shipped example)', async () => {
  const { r, log } = await registry({ drivers: ['synacl-driver-plain', 'synacl-driver-esm-only', 'synacl-driver-example'] });
  assert.equal(log.lines.filter((l) => l.level === 'error').length, 0, log.text());
  assert.deepEqual(r.protocols(), ['host', 'mqtt-bridge', 'modbus-tcp', 'plain', 'esm', 'http']);
  assert.deepEqual(r.capabilities(), { modbusFormats: true, sensorModels: { i2c: ['BME280'] } });
  const inst = r.forProtocol('plain');
  const h = await inst.open(makeDevice({ protocol: 'plain', tags: [{ name: 't' }] }));
  assert.deepEqual(await inst.read(h, [{ name: 't' }], { reason: 'interval' }), { values: { t: 7 }, reachable: true });
  assert.equal(r.drivers().find((d) => d.name === 'synacl-driver-example').source, 'synacl-driver-example');
});

test('a path entry loads too; a later driver for a protocol wins, with a warning', async () => {
  const { r, log } = await registry({ drivers: [join(tmp, 'overrides-host.mjs')] });
  const warns = log.lines.filter((l) => l.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0].msg, /"my-host".*replaces "host".*"host"/);
  const inst = r.forProtocol('host');
  const h = await inst.open(makeDevice({ protocol: 'host', tags: [{ name: 'x' }] }));
  assert.deepEqual((await inst.read(h, [{ name: 'x' }], { reason: 'interval' })).values, { x: 7 });
  assert.deepEqual(r.drivers().map((d) => d.name), ['mqtt-bridge', 'modbus-tcp', 'my-host']);
});

test('apiVersion other than 1 is refused; a missing package is reported with the install hint', async () => {
  const { r, log } = await registry({ drivers: [join(tmp, 'v2-driver.mjs'), 'synacl-driver-not-installed', '', join(tmp, 'lonely')] });
  assert.equal(r.protocols().includes('future'), false);
  const errs = r.loadErrors();
  assert.equal(errs.length, 4);
  assert.match(errs[0].error, /refused: apiVersion must be 1 \(got 2\)/);
  assert.match(errs[1].error, /npm i --prefix .*drivers synacl-driver-not-installed/);
  assert.match(errs[3].error, /imports synacl-gateway, which is not installed next to it/);
  assert.equal(log.lines.filter((l) => l.level === 'error').length, 4);
  assert.deepEqual(r.protocols(), ['host', 'mqtt-bridge', 'modbus-tcp'], 'the gateway still runs with what loaded');
});

test('an ES-module .js driver outside a "type": "module" package loads, or says how to fix it', async () => {
  const { r } = await registry({ drivers: [join(tmp, 'esm-in-cjs.js')] });
  // Node 22+ detects ES-module syntax by itself; older Node loads the file as CommonJS.
  if (!r.protocols().includes('confused')) {
    assert.match(r.loadErrors()[0].error, /is an ES module: name it \.mjs or add "type": "module"/);
  }
});

test('ctx: gateway id, per-driver data dir, the config section as options, a scoped logger', async () => {
  let seen;
  const probe = defineDriver({
    apiVersion: 1,
    name: 'probe',
    protocols: ['probe'],
    create(ctx) {
      seen = ctx;
      return { async open() { return 1; }, async read() { return { values: {}, reachable: true }; }, async close() {} };
    },
  });
  const { r } = await registry({ host: { diskPath: '/data' }, driverOptions: { probe: { a: 1 } } }, [probe]);
  assert.equal(seen, undefined, 'instances are created on first use');
  r.forProtocol('probe');
  assert.equal(seen.gatewayId, 'gw-test-1');
  assert.deepEqual(seen.options, { a: 1 });
  assert.ok(statSync(seen.dataDir).isDirectory());
  assert.equal(seen.dataDir, join(home, 'driver-data', 'probe'));
  assert.equal(typeof seen.log.redact, 'function');
  assert.equal(typeof seen.clock.now, 'function');
  assert.ok(seen.signal instanceof AbortSignal);
});

test('the guard keeps a sloppy driver inside the contract', async () => {
  const closes = [];
  const sloppy = defineDriver({
    apiVersion: 1,
    name: 'sloppy',
    protocols: ['sloppy'],
    create() {
      return {
        async open(device) { return device.tags.length ? undefined : null; }, // same primitive for every device
        async read(h, tags) {
          if (tags[0].name === 'throw') throw new Error('x'.repeat(500));
          return { values: { ok: 1, nan: NaN, inf: Infinity, nul: null, obj: {}, str: 's', bool: false, extra: 5 }, reachable: 'yes', reason: 'r'.repeat(300), errors: { nan: 'bad', junk: 5 } };
        },
        async write() { throw new Error('bus on fire'); },
        status() { throw new Error('status broke'); },
        async close(h) { closes.push(h); },
      };
    },
  });
  const { r } = await registry({}, [sloppy]);
  const inst = r.forProtocol('sloppy');
  const names = ['ok', 'nan', 'inf', 'nul', 'obj', 'str', 'bool'].map((name) => ({ name }));
  const h1 = await inst.open(makeDevice({ protocol: 'sloppy', tags: [{ name: 'a' }] }));
  const h2 = await inst.open(makeDevice({ protocol: 'sloppy', tags: [{ name: 'b' }] }));
  assert.notEqual(h1, h2, 'distinct handles even when the driver returns the same primitive');
  const res = await inst.read(h1, names, { reason: 'interval' });
  assert.deepEqual(res.values, { ok: 1, str: 's', bool: false }, 'non-finite, null, objects and unrequested keys dropped');
  assert.equal(res.reachable, true);
  assert.equal(res.reason.length, 128);
  assert.deepEqual(res.errors, { nan: 'bad' });
  const thrown = await inst.read(h1, [{ name: 'throw' }], { reason: 'interval' });
  assert.equal(thrown.reachable, false);
  assert.equal(thrown.reason.length, 128);
  assert.deepEqual(await inst.write(h1, { kind: 'modbus', registerType: 'coil', address: 0, value: 1 }), { ok: false, error: 'bus on fire' });
  assert.deepEqual(inst.status(h1), { reachable: false, reason: 'status broke' });
  await r.closeAll();
  assert.equal(closes.length, 2);
  await inst.close(h1); // already closed by closeAll: a no-op
  assert.equal(closes.length, 2);
});

test('closeAll releases the built-ins\' pooled connections', async () => {
  const broker = await startBroker();
  try {
    const { r } = await registry();
    const inst = r.forProtocol('mqtt-bridge');
    await inst.open(makeDevice({ protocol: 'mqtt-bridge', conn: { brokerUrl: broker.url }, tags: [{ name: 'v', topic: 't' }] }));
    await waitFor(() => broker.clients() === 1, { what: 'the bridge to connect' });
    await r.closeAll();
    await waitFor(() => broker.clients() === 0, { what: 'closeAll to disconnect it' });
  } finally {
    await broker.close();
  }
});
