// modbus-tcp driver against modbus-serial's ServerTCP over real local sockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createModbusTcpDriver } from '../../src/drivers/modbus-tcp.js';
import { encodeWords } from '../../src/drivers/modbus-codec.js';
import { createCaptureLog, freePort, makeCtx, makeDevice, realClock } from '../_support/drivers/helpers.js';
import { startModbusServer, startBlackHole } from '../_support/drivers/servers.js';

const regs = (addr, words) => Object.fromEntries(words.map((w, i) => [addr + i, w]));

/** @type {Awaited<ReturnType<typeof startModbusServer>>} */
let srv;
before(async () => {
  srv = await startModbusServer({
    holding: {
      0: 0xfffe,
      ...regs(10, [0x0001, 0x0002]), // u32 big → 65538
      ...regs(12, [0x0002, 0x0001]), // u32 little → 65538
      ...regs(20, [0xffff, 0xfffe]), // s32 big → -2
      ...regs(22, [0xfffe, 0xffff]), // s32 little → -2
      ...regs(30, [0x4366, 0x8000]), // f32 big → 230.5
      ...regs(32, [0x8000, 0x4366]), // f32 little → 230.5
      ...regs(40, [0x7fc0, 0x0000]), // f32 NaN
      ...regs(50, encodeWords(-12.25, 'f32', 'big')),
    },
    input: { 5: 1234, ...regs(6, [0x4366, 0x8000]) },
    coils: { 3: true, 4: false },
    discrete: { 7: true },
    exceptions: { holding: [100] },
  });
});
after(() => srv.close());

function driver({ log = createCaptureLog(), timeoutMs, clock = realClock } = {}) {
  return createModbusTcpDriver(timeoutMs ? { timeoutMs } : {}).create(makeCtx({ log, clock }));
}
const dev = (tags, conn = {}) => makeDevice({ protocol: 'modbus-tcp', conn: { ip: '127.0.0.1', port: srv.port, modbusId: 1, tickDuration: 10000, ...conn }, tags });

test('all four tables and every format, both word orders; raw values', async () => {
  const drv = driver();
  const device = dev([
    { name: 'u16', mbAddress: 0 },
    { name: 's16', mbAddress: 0, mbFormat: 's16' },
    { name: 'u32b', mbAddress: 10, mbFormat: 'u32' },
    { name: 'u32l', mbAddress: 12, mbFormat: 'u32', mbWordOrder: 'little' },
    { name: 's32b', mbAddress: 20, mbFormat: 's32' },
    { name: 's32l', mbAddress: 22, mbFormat: 's32', mbWordOrder: 'little' },
    { name: 'f32b', mbAddress: 30, mbFormat: 'f32' },
    { name: 'f32l', mbAddress: 32, mbFormat: 'f32', mbWordOrder: 'little' },
    { name: 'neg', mbAddress: 50, mbFormat: 'f32', scaleFactor: 10, offset: 5 },
    { name: 'ir', mbAddress: 5, registerType: 'input' },
    { name: 'irf', mbAddress: 6, registerType: 'input', mbFormat: 'f32' },
    { name: 'coilOn', mbAddress: 3, registerType: 'coil' },
    { name: 'coilOff', mbAddress: 4, registerType: 'coil' },
    { name: 'di', mbAddress: 7, registerType: 'discrete' },
  ]);
  const h = await drv.open(device);
  const r = await drv.read(h, device.tags, { reason: 'interval', signal: new AbortController().signal });
  assert.equal(r.reachable, true);
  assert.equal(r.reason, undefined);
  assert.deepEqual(r.values, {
    u16: 65534, s16: -2, u32b: 65538, u32l: 65538, s32b: -2, s32l: -2, f32b: 230.5, f32l: 230.5,
    neg: -12.25, // raw: scale/offset are the platform's job
    ir: 1234, irf: 230.5, coilOn: 1, coilOff: 0, di: 1,
  });
  await drv.close(h);
});

test('a NaN float is omitted (never published), the rest of the device still reads', async () => {
  const drv = driver();
  const device = dev([{ name: 'nan', mbAddress: 40, mbFormat: 'f32' }, { name: 'ok', mbAddress: 0 }]);
  const h = await drv.open(device);
  const r = await drv.read(h, device.tags, { reason: 'interval' });
  assert.deepEqual(r.values, { ok: 65534 });
  assert.equal('nan' in r.values, false);
  assert.match(r.errors.nan, /not a finite number/);
  assert.equal(r.reachable, true);
  await drv.close(h);
});

test('an exception is reported as "modbus exception 2 (illegal data address) at hr100"', async () => {
  const drv = driver();
  const device = dev([{ name: 'gone', mbAddress: 100 }]);
  const h = await drv.open(device);
  const r = await drv.read(h, device.tags, { reason: 'interval' });
  assert.equal(r.reachable, false);
  assert.equal(r.reason, 'modbus exception 2 (illegal data address) at hr100');
  assert.deepEqual(r.values, {});
  // One good tag makes the device reachable again.
  const r2 = await drv.read(h, [...device.tags, { ...device.tags[0], name: 'ok', mbAddress: 0 }], { reason: 'interval' });
  assert.equal(r2.reachable, true);
  assert.equal(r2.values.ok, 65534);
  await drv.close(h);
});

test('requests carry the configured unit id', async () => {
  const any = await startModbusServer({ unitID: 255, holding: { 0: 9 } }); // 255 = answer every unit id
  try {
    const drv = driver();
    const device = makeDevice({ protocol: 'modbus-tcp', conn: { ip: '127.0.0.1', port: any.port, modbusId: 7 }, tags: [{ name: 'v' }] });
    const h = await drv.open(device);
    const r = await drv.read(h, device.tags, { reason: 'interval' });
    assert.deepEqual(r.values, { v: 9 });
    assert.deepEqual([...new Set(any.units)], [7]);
    await drv.close(h);
  } finally {
    await any.close();
  }
});

test('writes: FC05 coil and FC06 holding land on the device; bad values are refused', async () => {
  const drv = driver();
  const h = await drv.open(dev([{ name: 'x' }]));
  srv.writes.length = 0;
  assert.deepEqual(await drv.write(h, { kind: 'modbus', registerType: 'coil', address: 4, value: 1 }), { ok: true, value: 1 });
  assert.deepEqual(await drv.write(h, { kind: 'modbus', registerType: 'coil', address: 4, value: 0 }), { ok: true, value: 0 });
  assert.deepEqual(await drv.write(h, { kind: 'modbus', registerType: 'holding', address: 60, value: 1234 }), { ok: true, value: 1234 });
  assert.deepEqual(await drv.write(h, { kind: 'modbus', registerType: 'holding', address: 61, value: -2 }), { ok: true, value: -2 });
  assert.deepEqual(srv.writes, [
    { fc: 5, addr: 4, value: true, unit: 1 },
    { fc: 5, addr: 4, value: false, unit: 1 },
    { fc: 6, addr: 60, value: 1234, unit: 1 },
    { fc: 6, addr: 61, value: 65534, unit: 1 }, // two's complement on the wire
  ]);
  // Read back what was written.
  const back = await drv.read(h, [dev([{ name: 'w', mbAddress: 60 }]).tags[0], dev([{ name: 'c', mbAddress: 4, registerType: 'coil' }]).tags[0]], { reason: 'once' });
  assert.deepEqual(back.values, { w: 1234, c: 0 });

  for (const [op, re] of [
    [{ kind: 'modbus', registerType: 'holding', address: 1, value: 70000 }, /-32768 to 65535/],
    [{ kind: 'modbus', registerType: 'holding', address: 1, value: 1.5 }, /integer/],
    [{ kind: 'modbus', registerType: 'input', address: 1, value: 1 }, /read-only/],
    [{ kind: 'modbus', registerType: 'holding', address: 70000, value: 1 }, /outside/],
    [{ kind: 'actuator', value: 1 }, /^actuator writes are not supported for protocol "modbus-tcp"$/],
  ]) {
    const res = await drv.write(h, op);
    assert.equal(res.ok, false);
    assert.match(res.error, re);
  }
  assert.equal(srv.writes.length, 4, 'refused writes never reach the bus');
  await drv.close(h);
});

test('a device that never answers → modbus/timeout, with one retry and the rest skipped', async () => {
  const hole = await startBlackHole();
  try {
    const log = createCaptureLog();
    const drv = driver({ log, timeoutMs: 150 });
    const device = makeDevice({ protocol: 'modbus-tcp', conn: { ip: '127.0.0.1', port: hole.port }, tags: [{ name: 'a' }, { name: 'b', mbAddress: 1 }] });
    const h = await drv.open(device);
    const t0 = Date.now();
    const r = await drv.read(h, device.tags, { reason: 'interval' });
    const took = Date.now() - t0;
    assert.equal(r.reachable, false);
    assert.equal(r.reason, 'modbus/timeout');
    assert.deepEqual(r.values, {});
    assert.equal(r.errors.a, 'modbus/timeout');
    assert.match(r.errors.b, /skipped/);
    assert.ok(took >= 280 && took < 2000, `one tag × 2 attempts × 150 ms, then skip (took ${took} ms)`);
    // Logged once for the state, not once per read.
    await drv.read(h, device.tags, { reason: 'interval' });
    assert.equal(log.lines.filter((l) => l.level === 'warn').length, 1);
    await drv.close(h);
  } finally {
    await hole.close();
  }
});

test('a refused port → "TCP connect failed to ip:port (ECONNREFUSED)"', async () => {
  const port = await freePort();
  const drv = driver();
  const device = makeDevice({ protocol: 'modbus-tcp', conn: { ip: '127.0.0.1', port }, tags: [{ name: 'a' }, { name: 'b' }] });
  const h = await drv.open(device);
  const r = await drv.read(h, device.tags, { reason: 'interval' });
  assert.equal(r.reachable, false);
  assert.equal(r.reason, `TCP connect failed to 127.0.0.1:${port} (ECONNREFUSED)`);
  assert.equal(r.errors.a, r.reason);
  assert.equal(r.errors.b, r.reason);
  const w = await drv.write(h, { kind: 'modbus', registerType: 'coil', address: 0, value: 1 });
  assert.equal(w.ok, false);
  assert.match(w.error, /ECONNREFUSED/);
  await drv.close(h);
});

test('two devices on one ip:port share one connection and never overlap on the wire', async () => {
  const bridge = await startModbusServer({ unitID: 255, holding: { 0: 11, 1: 12, 2: 13 }, delayMs: 15 });
  try {
    const drv = driver();
    const conn = { ip: '127.0.0.1', port: bridge.port };
    const d1 = makeDevice({ protocol: 'modbus-tcp', conn: { ...conn, modbusId: 1 }, tags: [{ name: 'a', mbAddress: 0 }, { name: 'b', mbAddress: 1 }] });
    const d2 = makeDevice({ protocol: 'modbus-tcp', conn: { ...conn, modbusId: 2 }, tags: [{ name: 'c', mbAddress: 2 }, { name: 'a', mbAddress: 0 }] });
    const [h1, h2] = await Promise.all([drv.open(d1), drv.open(d2)]);
    const [r1, r2] = await Promise.all([drv.read(h1, d1.tags, { reason: 'interval' }), drv.read(h2, d2.tags, { reason: 'interval' })]);
    assert.deepEqual(r1.values, { a: 11, b: 12 });
    assert.deepEqual(r2.values, { c: 13, a: 11 });
    assert.equal(bridge.maxInFlight(), 1, 'one transaction at a time');
    assert.equal(bridge.connections.count, 1, 'one TCP connection for both devices');
    assert.deepEqual([...new Set(bridge.units)].sort(), [1, 2]);
    // Closing one device keeps the connection for the other.
    await drv.close(h1);
    const again = await drv.read(h2, d2.tags, { reason: 'interval' });
    assert.equal(again.reachable, true);
    assert.equal(bridge.connections.count, 1);
    await drv.close(h2);
    await drv.close(h2);
  } finally {
    await bridge.close();
  }
});

test('the connection is re-established after the device drops it', async () => {
  let s = await startModbusServer({ holding: { 0: 5 } });
  const port = s.port;
  const drv = driver({ timeoutMs: 300 });
  const device = makeDevice({ protocol: 'modbus-tcp', conn: { ip: '127.0.0.1', port }, tags: [{ name: 'v' }] });
  const h = await drv.open(device);
  try {
    assert.deepEqual((await drv.read(h, device.tags, { reason: 'interval' })).values, { v: 5 });
    await s.close();
    const down = await drv.read(h, device.tags, { reason: 'interval' });
    assert.equal(down.reachable, false);
    assert.match(down.reason, /modbus\/timeout|ECONNREFUSED/);
    s = await startModbusServer({ holding: { 0: 6 }, port });
    const back = await drv.read(h, device.tags, { reason: 'interval' });
    assert.equal(back.reachable, true);
    assert.deepEqual(back.values, { v: 6 });
  } finally {
    await drv.close(h);
    await s.close();
  }
});

test('open() refuses a device with no usable address', async () => {
  const drv = driver();
  await assert.rejects(drv.open(makeDevice({ protocol: 'modbus-tcp', conn: {}, tags: [] })), (e) => e.reason === 'no valid device IP configured');
  await assert.rejects(drv.open(makeDevice({ protocol: 'modbus-tcp', conn: { ip: '10.0.0.1', port: 99999 }, tags: [] })), /not a TCP port/);
  await assert.rejects(drv.open(makeDevice({ protocol: 'modbus-tcp', conn: { ip: '10.0.0.1', modbusId: 300 }, tags: [] })), /unit id/);
});

test('an aborted read returns promptly without touching the bus', async () => {
  const drv = driver();
  const device = dev([{ name: 'a' }]);
  const h = await drv.open(device);
  const ac = new AbortController();
  ac.abort();
  const r = await drv.read(h, device.tags, { reason: 'interval', signal: ac.signal });
  assert.deepEqual(r.values, {});
  assert.equal(r.errors.a, 'read cancelled');
  await drv.close(h);
});
