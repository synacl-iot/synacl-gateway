// C13 — Modbus and actuator writes: the right op reaches the driver, every write is acknowledged,
// and anything the gateway cannot do is refused with an error ack instead of silence.
import { configPayload, device, deviceId } from '../fixtures.js';
import { short } from '../harness.js';

export const id = 'C13';
export const title = 'Modbus writes (register_type wins, then fc) ack ok; multi-register, unsupported protocol, actuator on host, unknown device → error ack';
export const level = 'optional';

const BUS = deviceId(2);
const HOST = deviceId(3);
const GHOST = deviceId(9);
const uuid = (n) => `6f1c2d3e-0000-4000-8000-${String(n).padStart(12, '0')}`;

export default async function run(h) {
  const payload = configPayload([
    device(BUS, { tickDuration: 10_000, tags: [{ name: 'setpoint', mbAddress: 10 }] }),
    device(HOST, { protocol: 'host', conn: { sampleIntervalMs: 10_000 }, tags: [{ name: 'load', metric: 'cpu.load' }] }),
  ]);
  const env = await h.env({ cloudConfig: payload });
  const { tenant, gatewayId } = env;
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced');
  await env.advance(5_000);

  const send = async (dev, body) => {
    env.cloud.sendDeviceCmd(tenant, gatewayId, dev, body);
    await env.advance(3_000);
    return env.cloud.ackFor(tenant, gatewayId, body.correlationId);
  };
  const lastWrite = () => env.controls.writes[env.controls.writes.length - 1];
  const isErr = (a) => a && a.body.status === 'error' && typeof a.body.error === 'string' && a.body.error.length > 0;

  const w1 = await send(BUS, { correlationId: uuid(1), fc: 6, address: 10, value: 1234, register_type: 'holding' });
  const op1 = lastWrite();
  h.check('holding-ok', w1 && w1.body.status === 'ok' && w1.body.value === 1234, `a holding-register write is acknowledged ok with the written value (got ${short(w1 && w1.body) || 'no ack'})`);
  h.check('holding-op', op1 && op1.op.kind === 'modbus' && op1.op.registerType === 'holding' && op1.op.address === 10 && op1.op.value === 1234, `the driver receives {kind:'modbus', registerType:'holding', address:10, value:1234} (got ${short(op1 && op1.op)})`);

  const w2 = await send(BUS, { correlationId: uuid(2), fc: 5, address: 3, value: 1, register_type: 'coil' });
  h.check('coil-ok', w2 && w2.body.status === 'ok' && lastWrite().op.registerType === 'coil', `a coil write reaches the driver as a coil (got ${short(lastWrite().op)})`);

  const w3 = await send(BUS, { correlationId: uuid(3), fc: 5, address: 7, value: 99, register_type: 'holding' });
  h.check('register-type-wins', w3 && w3.body.status === 'ok' && lastWrite().op.registerType === 'holding' && lastWrite().op.address === 7, `register_type decides the table, not fc (got ${short(lastWrite().op)})`);

  const n = env.controls.writes.length;
  const w4 = await send(BUS, { correlationId: uuid(4), fc: 16, address: 20, value: [1, 2, 3], register_type: 'holding' });
  h.check('multi-refused', isErr(w4) && env.controls.writes.length === n, `a multi-register write is refused with an error ack and never reaches the driver (got ${short(w4 && w4.body) || 'no ack'})`);

  const w5 = await send(HOST, { correlationId: uuid(5), fc: 6, address: 1, value: 5, register_type: 'holding' });
  h.check('no-driver-write', isErr(w5), `a Modbus write to a device whose driver cannot write gets an error ack (got ${short(w5 && w5.body) || 'no ack'})`);

  const w6 = await send(HOST, { correlationId: uuid(6), value: 1 });
  h.check('actuator-host', isErr(w6), `an actuator write on a host device gets an error ack (got ${short(w6 && w6.body) || 'no ack'})`);

  const w7 = await send(BUS, { correlationId: uuid(7), command: 'move', steps: 10, dir: 1 });
  h.check('stepper-refused', isErr(w7), `a stepper move the gateway cannot perform gets an error ack (got ${short(w7 && w7.body) || 'no ack'})`);

  const w8 = await send(GHOST, { correlationId: uuid(8), fc: 6, address: 1, value: 5, register_type: 'holding' });
  h.check('unknown-device', isErr(w8) && w8.deviceId === GHOST, `a command for a device not in the config is answered with an error ack on that device's topic (got ${short(w8 && w8.body) || 'no ack'})`);

  const acks = env.cloud.up('gateway.device-cmd-ack');
  h.check('ack-shape', acks.length === 8 && acks.every((a) => a.valid), `exactly one schema-valid ack per command (got ${acks.length})`);
}
