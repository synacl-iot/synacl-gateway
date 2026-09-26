#!/usr/bin/env node
// A small Modbus TCP device for trying the modbus-tcp driver by hand:
//
//   node scripts/modbus-sim.js [--port 1502] [--host 127.0.0.1] [--unit 255]
//
// then add a Modbus TCP device at <host>:<port> in the Synacl app with the tags printed at
// start-up. Values move a little every second so charts show life; writes from the app
// (FC05 coil, FC06 holding) are printed as they arrive and change what is read back.
import { parseArgs } from 'node:util';
import ModbusRTU from 'modbus-serial';
import { encodeWords } from '../src/drivers/modbus-codec.js';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '1502' },
    host: { type: 'string', default: '127.0.0.1' },
    unit: { type: 'string', default: '255' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});
if (args.help) {
  process.stdout.write('usage: node scripts/modbus-sim.js [--port 1502] [--host 127.0.0.1] [--unit 255]\n  --unit 255 answers every unit id; any other value answers only that one.\n');
  process.exit(0);
}
const port = Number(args.port);
const unit = Number(args.unit);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1..65535');
if (!Number.isInteger(unit) || unit < 1 || unit > 255) throw new Error('--unit must be 1..255');

const holding = new Map();
const input = new Map();
const coils = new Map([[0, false]]);
const discrete = new Map([[0, false]]);
const put = (map, addr, words) => words.forEach((w, i) => map.set(addr + i, w));

// What each address holds — also printed as a ready-to-use tag list.
const LAYOUT = [
  ['holding', 0, 'u16', 'big', 'counter (+1 per second)'],
  ['holding', 1, 's16', 'big', 'fixed -1234'],
  ['holding', 2, 'u32', 'big', 'fixed 123456'],
  ['holding', 4, 's32', 'big', 'fixed -123456'],
  ['holding', 10, 'f32', 'big', 'voltage ~230.5 (ABCD)'],
  ['holding', 12, 'f32', 'little', 'voltage ~230.5 (CDAB)'],
  ['holding', 20, 'u16', 'big', 'setpoint — writable (FC06), starts at 100'],
  ['input', 0, 'f32', 'big', 'temperature ~21.5 (ABCD)'],
  ['input', 2, 'f32', 'little', 'temperature ~21.5 (CDAB)'],
  ['coil', 0, '', '', 'relay — writable (FC05)'],
  ['discrete', 0, '', '', 'door contact, toggles every 5 s'],
];

let tick = 0;
function update() {
  const t = tick++;
  put(holding, 0, [t & 0xffff]);
  put(holding, 1, [-1234 & 0xffff]);
  put(holding, 2, encodeWords(123456, 'u32', 'big'));
  put(holding, 4, encodeWords(-123456, 's32', 'big'));
  const volts = Math.round((230.5 + Math.sin(t / 10) * 1.5) * 10) / 10;
  put(holding, 10, encodeWords(volts, 'f32', 'big'));
  put(holding, 12, encodeWords(volts, 'f32', 'little'));
  const temp = Math.round((21.5 + Math.sin(t / 30) * 2) * 100) / 100;
  put(input, 0, encodeWords(temp, 'f32', 'big'));
  put(input, 2, encodeWords(temp, 'f32', 'little'));
  if (t % 5 === 0) discrete.set(0, !discrete.get(0));
}
holding.set(20, 100);
update();
setInterval(update, 1000).unref?.();

const illegalAddress = () => Object.assign(new Error('illegal data address'), { modbusErrorCode: 2 });
const get = (map) => (addr) => {
  if (!map.has(addr)) throw illegalAddress();
  return map.get(addr);
};
const stamp = () => new Date().toISOString().slice(11, 19);

const vector = {
  getHoldingRegister: get(holding),
  getInputRegister: get(input),
  getCoil: get(coils),
  getDiscreteInput: get(discrete),
  setRegister(addr, value, unitId) {
    if (addr !== 20) throw illegalAddress();
    holding.set(addr, value);
    process.stdout.write(`${stamp()} [write] FC06 holding ${addr} = ${value} (as s16: ${value >= 0x8000 ? value - 0x10000 : value}) unit ${unitId}\n`);
  },
  setCoil(addr, value, unitId) {
    if (!coils.has(addr)) throw illegalAddress();
    coils.set(addr, Boolean(value));
    process.stdout.write(`${stamp()} [write] FC05 coil ${addr} = ${value ? 'ON' : 'OFF'} unit ${unitId}\n`);
  },
};

const server = new ModbusRTU.ServerTCP(vector, { host: args.host, port, unitID: unit, debug: false });
server.on('serverError', (err) => {
  process.stderr.write(`modbus-sim: ${err.message}\n`);
  process.exit(1);
});
server.on('socketError', (err) => process.stderr.write(`modbus-sim: socket error: ${err.message}\n`));
server.on('initialized', () => {
  process.stdout.write(`modbus-sim listening on ${args.host}:${port} (unit ${unit === 255 ? 'any' : unit}). Addresses are 0-based.\n\n`);
  process.stdout.write('  table     addr  format  order   what\n');
  for (const [table, addr, fmt, order, what] of LAYOUT) {
    process.stdout.write(`  ${table.padEnd(9)} ${String(addr).padEnd(5)} ${fmt.padEnd(7)} ${order.padEnd(7)} ${what}\n`);
  }
  process.stdout.write('\nCtrl-C to stop.\n');
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
