// In-process servers the driver tests talk to over real sockets: an aedes MQTT broker and a
// modbus-serial ServerTCP backed by plain register maps.
import { createServer } from 'node:net';
import { once } from 'node:events';
import Aedes from 'aedes';
import ModbusRTU from 'modbus-serial';
import { freePort } from './helpers.js';

/**
 * Start an aedes broker on a random local port.
 * @param {{authenticate?: (client: any, username: string, password: Buffer, cb: Function) => void}} [opts]
 */
export async function startBroker(opts = {}) {
  const aedes = new Aedes(opts.authenticate ? { authenticate: opts.authenticate } : {});
  const server = createServer(aedes.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  let closed = false;
  return {
    aedes,
    port,
    url: `mqtt://127.0.0.1:${port}`,
    /** Publish as the broker itself (retain stores it like a client's retained publish). */
    publish: (topic, payload, { retain = false } = {}) =>
      new Promise((resolve, reject) =>
        aedes.publish({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain, dup: false }, (err) => (err ? reject(err) : resolve())),
      ),
    clients: () => aedes.connectedClients,
    close: () =>
      new Promise((resolve) => {
        if (closed) return resolve();
        closed = true;
        aedes.close(() => server.close(() => resolve()));
      }),
  };
}

/**
 * Start a Modbus TCP server on a free local port, serving the given register maps.
 * Address → value; coils/discretes are booleans. `exceptions` makes an address answer with
 * Modbus exception 2 (illegal data address).
 * @param {{holding?: Object<number, number>, input?: Object<number, number>, coils?: Object<number, boolean>,
 *   discrete?: Object<number, boolean>, exceptions?: {holding?: number[], input?: number[]}, unitID?: number,
 *   delayMs?: number, port?: number}} [opts]
 */
export async function startModbusServer({ holding = {}, input = {}, coils = {}, discrete = {}, exceptions = {}, unitID = 1, delayMs = 0, port: fixedPort } = {}) {
  const port = fixedPort ?? (await freePort());
  const writes = [];
  const units = [];
  const connections = { count: 0 };
  let inFlight = 0;
  let maxInFlight = 0;

  const answer = (map, table, addr, unit) => {
    units.push(unit);
    if ((exceptions[table] ?? []).includes(addr)) {
      const err = new Error('illegal data address');
      /** @type {any} */ (err).modbusErrorCode = 2;
      throw err;
    }
    const v = map[addr] ?? 0;
    if (!delayMs) return v;
    // Async answers let the test see whether two requests were ever in flight together.
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => setTimeout(() => { inFlight--; resolve(v); }, delayMs));
  };

  const vector = {
    getHoldingRegister: (addr, unit) => answer(holding, 'holding', addr, unit),
    getInputRegister: (addr, unit) => answer(input, 'input', addr, unit),
    getCoil: (addr, unit) => Boolean(answer(coils, 'coils', addr, unit)),
    getDiscreteInput: (addr, unit) => Boolean(answer(discrete, 'discrete', addr, unit)),
    setRegister: (addr, value, unit) => {
      holding[addr] = value;
      writes.push({ fc: 6, addr, value, unit });
    },
    setCoil: (addr, value, unit) => {
      coils[addr] = value;
      writes.push({ fc: 5, addr, value, unit });
    },
  };
  const server = new ModbusRTU.ServerTCP(vector, { host: '127.0.0.1', port, unitID, debug: false });
  server.on('socketError', () => {});
  server.on('serverError', () => {});
  /** @type {any} */ (server)._server.on('connection', () => connections.count++);
  await once(server, 'initialized');
  return {
    port,
    writes,
    units,
    connections,
    holding,
    coils,
    maxInFlight: () => maxInFlight,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A TCP server that accepts connections and never answers — a hung device. */
export async function startBlackHole() {
  const sockets = new Set();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('data', () => {});
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
