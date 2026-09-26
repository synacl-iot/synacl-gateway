import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCommands } from '../../src/core/commands.js';
import { createScheduler, NOT_IN_CONFIG } from '../../src/core/scheduler.js';
import { createPublisher } from '../../src/core/publisher.js';
import { buildCapabilities } from '../../src/core/capabilities.js';
import {
  createFakeClock, createFakeTransport, createTopics, createValidators, createMemoryLogger, createMemoryState, device, devId, flush,
} from '../_support/core-runtime/fakes.js';
import { createFakeDriver } from '../_support/core-runtime/fake-driver.js';

const examples = fileURLToPath(new URL('../../protocol/v1/examples/', import.meta.url));
const example = (name) => readFileSync(`${examples}${name}.json`);
const D = devId(1);

async function setup({ writable = true, devices = [device(D, { tags: [{ name: 't1' }, { name: 'oil_temp', isIntervalRead: false }] })] } = {}) {
  const clock = createFakeClock();
  const transport = createFakeTransport(clock);
  const validators = createValidators();
  const log = createMemoryLogger();
  const publisher = createPublisher({ transport, topics: createTopics(), validators, clock, log, strict: true });
  const driver = createFakeDriver(clock, { writable });
  const state = createMemoryState();
  const scheduler = createScheduler({ clock, log, drivers: driver.registry, publisher, state, minIntervalMs: 250 });
  await scheduler.apply(devices);
  const calls = [];
  const lifecycle = {
    restart: async () => { calls.push('restart'); },
    resetConfig: async () => { calls.push('resetConfig'); },
    setSim: (on) => { calls.push(`sim:${on}`); },
  };
  const debug = {
    diag: async (c) => { calls.push(`diag:${c}`); },
    startLogs: (cats) => { calls.push(`logs:${cats}`); },
    stopLogs: () => { calls.push('logs:stop'); },
  };
  const caps = buildCapabilities({ version: '0.1.0', gatewayId: 'gw_test01', drivers: driver.registry });
  const cmds = createCommands({ scheduler, lifecycle, debug, capabilities: () => caps, publisher, log, clock, validators });
  const send = (kind, id, body) => cmds.onMessage(kind, id, Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
  const acks = (id = D) => transport.bySuffix(`devices/${id}/cmd/ack`).map((m) => m.body);
  return { clock, transport, validators, log, scheduler, driver, state, calls, send, acks };
}

// ─── device commands ───────────────────────────────────────────────────────────────────

test('device not in this gateway\'s configuration → error ack (only when a correlationId is present)', async () => {
  const s = await setup();
  await s.send('gateway.device-cmd', devId(9), { command: 'read/once', tag: 't1', correlationId: 'c1' });
  await s.send('gateway.device-cmd', devId(9), { command: 'set/interval', interval: 5000 });
  const a = s.acks(devId(9));
  assert.equal(a.length, 1);
  assert.deepEqual({ correlationId: a[0].correlationId, status: a[0].status, error: a[0].error }, { correlationId: 'c1', status: 'error', error: NOT_IN_CONFIG });
  assert.ok(s.validators.validate('cmd-ack', a[0]).ok);
  await s.scheduler.stop();
});

test('read/once (the vendored example): data with only that tag, then the ok ack', async () => {
  const s = await setup({ devices: [device('64b7a1000000000000000002', { tags: [{ name: 'oil_temp', isIntervalRead: false }] })] });
  const body = JSON.parse(example('device-cmd.read-once'));
  await s.send('gateway.device-cmd', '64b7a1000000000000000002', JSON.stringify({ ...body, tag: 'oil_temp' }));
  const out = s.transport.sent.map((m) => m.suffix.split('/').at(-1));
  assert.deepEqual(out, ['data', 'ack']);
  const ack = s.acks('64b7a1000000000000000002')[0];
  assert.equal(ack.status, 'ok');
  assert.equal(ack.correlationId, body.correlationId);
  await s.scheduler.stop();
});

test('read/once without a tag → error ack', async () => {
  const s = await setup();
  await s.send('device-cmd', D, { command: 'read/once', correlationId: 'c' });
  assert.equal(s.acks()[0].error, 'tag is required');
  await s.scheduler.stop();
});

test('set/interval, read/disable, read/enable: applied, never acked', async () => {
  const s = await setup();
  await s.send('device-cmd', D, { command: 'set/interval', interval: 2000, correlationId: 'x' });
  assert.equal(s.scheduler.snapshot()[0].intervalMs, 2000);
  assert.equal(s.state.overrides.devices[D].intervalMs, 2000);
  await s.send('device-cmd', D, JSON.parse(example('device-cmd.read-disable-timed')));
  assert.equal(s.scheduler.snapshot()[0].paused, 'timed');
  await s.send('device-cmd', D, JSON.parse(example('device-cmd.read-enable')));
  assert.equal(s.scheduler.snapshot()[0].paused, null);
  await s.send('device-cmd', D, JSON.parse(example('device-cmd.read-disable-manual')));
  assert.equal(s.scheduler.snapshot()[0].paused, 'manual');
  await s.send('device-cmd', D, { command: 'read/disable', mode: 'restart' });
  assert.equal(s.scheduler.snapshot()[0].paused, 'restart');
  await s.send('device-cmd', D, { command: 'read/disable', mode: 'timed' }); // no duration: ignored
  assert.equal(s.scheduler.snapshot()[0].paused, 'restart');
  assert.equal(s.acks().length, 0);
  await s.scheduler.stop();
});

test('modbus write: register_type wins over fc; fc 5 → coil, 6 → holding; ok ack echoes the value', async () => {
  const s = await setup();
  await s.send('device-cmd', D, { correlationId: 'a', fc: 6, address: 1, value: 1, register_type: 'coil' });
  await s.send('device-cmd', D, { correlationId: 'b', fc: 5, address: 2, value: 0 });
  await s.send('device-cmd', D, { correlationId: 'c', fc: 6, address: 3, value: 1234 });
  assert.deepEqual(s.driver.stats.writes.map((w) => w.op), [
    { kind: 'modbus', registerType: 'coil', address: 1, value: 1 },
    { kind: 'modbus', registerType: 'coil', address: 2, value: 0 },
    { kind: 'modbus', registerType: 'holding', address: 3, value: 1234 },
  ]);
  const a = s.acks();
  assert.deepEqual(a.map((x) => [x.correlationId, x.status, x.error, x.value]), [['a', 'ok', null, 1], ['b', 'ok', null, 0], ['c', 'ok', null, 1234]]);
  for (const x of a) assert.ok(s.validators.validate('cmd-ack', x).ok);
  await s.scheduler.stop();
});

test('modbus write: fc 15/16 or an array value → "multi-register writes not supported"; bad register type/address → error', async () => {
  const s = await setup();
  await s.send('device-cmd', D, JSON.parse(example('device-cmd.modbus-direct-fc16')));
  await s.send('device-cmd', D, { correlationId: 'arr', fc: 6, address: 1, value: [1, 2] });
  await s.send('device-cmd', D, { correlationId: 'fc3', fc: 3, address: 1, value: 1 });
  await s.send('device-cmd', D, { correlationId: 'addr', fc: 6, address: 70000, value: 1 });
  const a = s.acks();
  assert.deepEqual(a.map((x) => x.error), ['multi-register writes not supported', 'multi-register writes not supported', 'unknown register type', 'invalid address']);
  assert.equal(s.driver.stats.writes.length, 0);
  await s.scheduler.stop();
});

test('a driver without write → error ack naming the protocol', async () => {
  const s = await setup({ writable: false });
  await s.send('device-cmd', D, JSON.parse(example('device-cmd.modbus-coil')));
  assert.equal(s.acks()[0].error, 'modbus writes are not supported for protocol "fake"');
  await s.scheduler.stop();
});

test('actuator write and stepper move → error ack naming the protocol', async () => {
  const s = await setup({ writable: false });
  await s.send('device-cmd', D, JSON.parse(example('device-cmd.actuator-set')));
  await s.send('device-cmd', D, JSON.parse(example('device-cmd.actuator-motor')));
  await s.send('device-cmd', D, JSON.parse(example('device-cmd.stepper-move')));
  const a = s.acks();
  assert.equal(a.length, 3);
  for (const x of a) {
    assert.equal(x.error, 'actuator writes are not supported for protocol "fake"');
    assert.ok(s.validators.validate('cmd-ack', x).ok);
  }
  await s.scheduler.stop();
});

test('unknown device commands and unparseable bodies are ignored', async () => {
  const s = await setup();
  await s.send('device-cmd', D, { command: 'self-destruct', correlationId: 'z' });
  await s.send('device-cmd', D, '{not json');
  await s.send('device-cmd', D, '[1,2]');
  await s.send('device-cmd', D, { hello: 'world' });
  assert.equal(s.transport.sent.length, 0);
  await s.scheduler.stop();
});

test('every vendored device-cmd example is handled without throwing, and every ack is schema-valid', async () => {
  const s = await setup();
  for (const f of readdirSync(examples).filter((x) => x.startsWith('device-cmd'))) {
    await s.send('gateway.device-cmd', D, readFileSync(`${examples}${f}`));
  }
  await flush();
  for (const a of s.acks()) assert.ok(s.validators.validate('cmd-ack', a).ok, JSON.stringify(a));
  await s.scheduler.stop();
});

// ─── gateway commands ──────────────────────────────────────────────────────────────────

test('gateway commands dispatch to the lifecycle and debug hooks', async () => {
  const s = await setup();
  await s.send('gateway.cmd', undefined, example('gateway-cmd'));
  await s.send('gateway.cmd', undefined, example('gateway-cmd.reset-config'));
  await s.send('cmd', undefined, example('gateway-cmd.sim-start'));
  await s.send('cmd', undefined, example('gateway-cmd.sim-stop'));
  await s.send('cmd', undefined, example('gateway-cmd.debug-diag'));
  await s.send('cmd', undefined, example('gateway-cmd.debug-logs-start'));
  await s.send('cmd', undefined, example('gateway-cmd.debug-logs-stop'));
  await flush();
  const diagCorr = JSON.parse(example('gateway-cmd.debug-diag')).correlationId;
  const cats = JSON.parse(example('gateway-cmd.debug-logs-start')).cats;
  const first = JSON.parse(example('gateway-cmd')).command;
  assert.equal(first, 'restart');
  assert.deepEqual(s.calls, ['restart', 'resetConfig', 'sim:true', 'sim:false', `diag:${diagCorr}`, `logs:${cats}`, 'logs:stop']);
  await s.scheduler.stop();
});

test('job/config, ble/scan and unknown gateway commands are ignored', async () => {
  const s = await setup();
  await s.send('cmd', undefined, example('gateway-cmd.job-config'));
  await s.send('cmd', undefined, example('gateway-cmd.ble-scan'));
  await s.send('cmd', undefined, { command: 'teleport' });
  await s.send('cmd', undefined, { nothing: true });
  await flush();
  assert.deepEqual(s.calls, []);
  assert.equal(s.transport.sent.length, 0);
  await s.scheduler.stop();
});

// ─── firmware + macros ─────────────────────────────────────────────────────────────────

test('a bare firmware/request re-publishes the capability report; an update request is ignored', async () => {
  const s = await setup();
  await s.send('gateway.firmware-request', undefined, {});
  const [m] = s.transport.bySuffix('firmware/response');
  assert.ok(s.validators.validate('firmware-response', m.body).ok);
  assert.equal(m.body.version, '0.1.0');
  await s.send('gateway.firmware-request', undefined, example('firmware-request'));
  assert.equal(s.transport.bySuffix('firmware/response').length, 1);
  assert.ok(s.log.lines.some((l) => /npm i -g synacl-gateway@/.test(l.msg)));
  await s.scheduler.stop();
});

test('macros/run → macro/run/status phase error so the run does not hang; push and abort are ignored', async () => {
  const s = await setup();
  const run = JSON.parse(example('macros-run'));
  await s.send('gateway.macros-run', undefined, JSON.stringify(run));
  await s.send('gateway.macros-push', undefined, example('macros-push'));
  await s.send('gateway.macros-abort', undefined, example('macros-abort'));
  const st = s.transport.bySuffix('macro/run/status');
  assert.equal(s.transport.sent.length, 1);
  assert.equal(st[0].body.runId, run.runId);
  assert.equal(st[0].body.macroId, run.macroId);
  assert.equal(st[0].body.phase, 'error');
  assert.equal(st[0].body.severity, 'error');
  assert.match(st[0].body.message, /^unknown macro/);
  assert.ok(Number.isInteger(st[0].body.ts));
  assert.ok(s.validators.validate('macro-run-status', st[0].body).ok);
  await s.scheduler.stop();
});

test('a lifecycle hook that throws never escapes onMessage', async () => {
  const s = await setup();
  const cmds = createCommands({
    scheduler: s.scheduler, publisher: { now: () => 0, ack: async () => true, gateway: async () => { throw new Error('x'); } },
    lifecycle: { restart: async () => { throw new Error('boom'); }, resetConfig: async () => {}, setSim: () => { throw new Error('sim'); } },
    debug: { diag: async () => { throw new Error('d'); }, startLogs() {}, stopLogs() {} },
    capabilities: {}, log: s.log,
  });
  await cmds.onMessage('gateway.cmd', undefined, Buffer.from('{"command":"restart"}'));
  await cmds.onMessage('gateway.cmd', undefined, Buffer.from('{"command":"sim/start"}'));
  await cmds.onMessage('gateway.cmd', undefined, Buffer.from('{"command":"debug/diag","correlationId":"c"}'));
  await cmds.onMessage('gateway.macros-run', undefined, Buffer.from('{"runId":"r","macroId":"m","params":{}}'));
  await flush();
  assert.ok(s.log.lines.some((l) => l.level === 'error'));
  await s.scheduler.stop();
});
