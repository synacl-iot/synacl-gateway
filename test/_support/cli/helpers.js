// Shared fixtures for test/cli/*: a fake CliIO that records output, throwaway home dirs, an
// in-process MQTT broker, and stubs for the core modules the commands call.

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** A made-up identity in the shapes the platform issues (24 hex, 24 base62). */
export const OWNER = 'a1b2c3d4e5f6a7b8c9d0e1f2';
export const PASSWORD = 'Zx8vQm2Lk9Rt4Yb7Nc1Sd6Fg';
export const GATEWAY = 'gw_3f2a9c1e7b41';

/** Exactly what Gateways → Connection Info prints, minus the leading `npx synacl-gateway`. */
export const ONE_LINER = Object.freeze([
  'init', '--broker', 'mqtts://mqtt.synacl.com:8883', '--tenant', OWNER, '--gateway', GATEWAY, '--user', '123456', '--pass', PASSWORD,
]);

export function capture({ isTTY = false } = {}) {
  const chunks = [];
  const s = new Writable({ write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } });
  s.isTTY = isTTY;
  s.text = () => chunks.join('');
  return s;
}

/**
 * @param {{home: string, env?: Object, stdin?: NodeJS.ReadableStream}} opts
 */
export function makeIo({ home, env = {}, stdin } = {}) {
  const stdout = capture();
  const stderr = capture();
  return {
    stdout,
    stderr,
    stdin: stdin ?? new PassThrough(),
    env: { ...env },
    home,
    out: () => stdout.text(),
    err: () => stderr.text(),
    all: () => stdout.text() + stderr.text(),
  };
}

/** A temp dir removed after the test. */
export function tmpHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synacl-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A FileConfig with the fixture identity. */
export function sampleConfig(over = {}) {
  return {
    schema: 1,
    broker: 'mqtts://mqtt.synacl.com:8883',
    tenant: OWNER,
    gateway: GATEWAY,
    username: '123456',
    password: PASSWORD,
    api: 'https://api.synacl.com',
    tls: { caFile: null, rejectUnauthorized: true },
    drivers: [],
    driverDir: null,
    configCap: null,
    minIntervalMs: 1000,
    backfill: { maxBytes: 67108864, maxAgeHours: 168, batchIntervalMs: 1000 },
    host: { diskPath: '/' },
    bridge: { rejectUnauthorized: true },
    log: { level: 'info', format: 'auto' },
    createdAt: '2026-09-26T00:00:00.000Z',
    ...over,
  };
}

/**
 * aedes on a random localhost port.
 * @param {{authenticate?: Function, authorizeSubscribe?: Function}} [hooks]
 */
export async function startBroker(hooks = {}) {
  const Aedes = require('aedes');
  const broker = new Aedes({ maxClientsIdLength: 128, ...hooks });
  const sockets = new Set();
  const published = [];
  broker.on('publish', (packet, client) => { if (client) published.push(packet.topic); });
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    broker.handle(sock);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `mqtt://127.0.0.1:${port}`,
    port,
    broker,
    published,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r()));
      await new Promise((r) => broker.close(() => r()));
    },
  };
}

/** A port nothing listens on (bound, read, released). */
export async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** Records createGateway() calls and lets a test decide how start/stop/reload behave. */
export function stubGateway({ startError = null, stopHangs = false, reloadResult = 'requested', reloadError = null } = {}) {
  const calls = { created: [], start: 0, stop: 0, reload: [] };
  const factory = (opts) => {
    calls.created.push(opts);
    return {
      async start() { calls.start += 1; if (startError) throw startError; },
      stop() { calls.stop += 1; return stopHangs ? new Promise(() => {}) : Promise.resolve(); },
      async restart() {},
      async reload(config) { calls.reload.push(config); if (reloadError) throw reloadError; return reloadResult; },
      status() { return {}; },
    };
  };
  return { factory, calls };
}

/** A Clock whose timers never fire on their own (the 6-hour skew probe must not hold tests open). */
export function stubClock() {
  const timers = [];
  return {
    timers,
    now: () => Date.now(),
    setTimeout: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const h = { fn, ms, interval: true }; timers.push(h); return h; },
    clearInterval: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  };
}

export function signals() {
  return new EventEmitter();
}

/** Polls until `fn()` is truthy (for handlers that run on a later tick). */
export async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** One macrotask: lets promise continuations (e.g. "start() resolved") run. */
export function tick() {
  return new Promise((r) => setImmediate(r));
}
