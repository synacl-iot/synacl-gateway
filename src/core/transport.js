// The MQTT transport (types.js `Transport`) over mqtt.js — the one place client options live.
//
// Three mqtt.js defaults are wrong for this protocol and are overridden here:
//  - queueQoSZero (default true) and the offline queue would replay everything published while
//    disconnected as one burst on reconnect, which the platform counts as rate violations and
//    can suspend devices for. So publish() REJECTS while disconnected, and every connect() uses
//    a brand-new client, so nothing from an earlier session can ever be flushed.
//  - reconnectPeriod (default 1 s) — the gateway core owns backoff and jitter.
//  - resubscribe (default true) — the core subscribes itself on every connect so it can read
//    the SUBACK: a refused filter (0x80) is the only in-band sign of an ACL mismatch.
// Payloads stay Buffers end to end: the config hash is computed over the raw bytes.

import { EventEmitter } from 'node:events';
import mqtt from 'mqtt';

/** @typedef {import('./types.js').Transport} Transport */
/** @typedef {import('./types.js').TransportConnectOptions} TransportConnectOptions */
/** @typedef {import('./types.js').Logger} Logger */

export const CONNECT_TIMEOUT_MS = 30000;
const GRACEFUL_END_TIMEOUT_MS = 2000;

/** mqtt.js options for one connection attempt. Exported so tests can assert them. */
export function clientOptions(opts) {
  /** @type {Object} */
  const o = {
    clientId: opts.clientId,
    username: opts.username,
    password: opts.password,
    protocolVersion: 4,
    clean: true,
    keepalive: opts.keepalive ?? 60,
    connectTimeout: CONNECT_TIMEOUT_MS,
    reconnectPeriod: 0,
    reconnectOnConnackError: false,
    resubscribe: false,
    queueQoSZero: false,
    rejectUnauthorized: opts.rejectUnauthorized !== false,
  };
  if (opts.will) {
    o.will = {
      topic: opts.will.topic,
      payload: Buffer.from(opts.will.payload),
      qos: opts.will.qos,
      retain: opts.will.retain,
    };
  }
  if (opts.ca) o.ca = opts.ca;
  return o;
}

/** mqtt.js reports a refused CONNACK as an error carrying the return code. */
function connackCode(err) {
  return err && typeof err.code === 'number' && err.code > 0 && err.code < 128
    && /^Connection refused/.test(err.message) ? err.code : null;
}

class NotConnectedError extends Error {
  constructor() {
    super('not connected');
    this.code = 'ENOTCONNECTED';
  }
}

/**
 * @param {{log?: Logger, connect?: typeof mqtt.connect}} [deps]  `connect` is injectable for tests.
 * @returns {Transport}
 */
export function createMqttTransport({ log, connect: connectImpl = mqtt.connect } = {}) {
  const events = new EventEmitter();
  /** @type {any} */
  let client = null;
  /** Rejecters of QoS 1 publishes still waiting for their PUBACK on the current client. */
  let pending = new Set();

  function emit(event, ...args) {
    if (event === 'error' && events.listenerCount('error') === 0) {
      log?.debug('mqtt error', { error: args[0]?.message });
      return;
    }
    events.emit(event, ...args);
  }

  function detach(c) {
    c.removeAllListeners();
    // mqtt.js may still emit an error while the socket tears down; never let it go unhandled.
    c.on('error', () => {});
  }

  function failPending(set) {
    for (const reject of set) reject(new NotConnectedError());
    set.clear();
  }

  /** @type {Transport} */
  const transport = {
    get connected() {
      return !!client && client.connected === true && client.disconnecting !== true;
    },

    connect(opts) {
      if (client) {
        const old = client;
        detach(old);
        failPending(pending);
        old.end(true);
      }
      const c = connectImpl(opts.url, clientOptions(opts));
      const mine = new Set();
      client = c;
      pending = mine;
      let closed = false;

      c.on('connect', () => { if (client === c) emit('connect'); });
      c.on('message', (topic, payload, packet) => {
        if (client === c) emit('message', topic, payload, { retain: !!packet?.retain });
      });
      c.on('error', (err) => {
        if (client !== c) return;
        const code = connackCode(err);
        if (code !== null) emit('connack-refused', code);
        else emit('error', err);
      });
      c.on('close', () => {
        if (closed) return;
        closed = true;
        failPending(mine);
        if (client === c) emit('close');
      });
    },

    publish(topic, payload, { qos = 0, retain = false } = {}) {
      if (!transport.connected) return Promise.reject(new NotConnectedError());
      const c = client;
      const set = pending;
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          set.delete(onDrop);
          if (err) reject(err); else resolve();
        };
        const onDrop = (err) => done(err);
        if (qos > 0) set.add(onDrop);
        c.publish(topic, payload, { qos, retain }, (err) => done(err));
      });
    },

    subscribe(filters, qos = 1) {
      if (!transport.connected) return Promise.reject(new NotConnectedError());
      const c = client;
      return new Promise((resolve, reject) => {
        c.subscribe(filters, { qos }, (err, subs, packet) => {
          // A refused filter arrives as an error that still carries the SUBACK; the caller
          // decides what a 0x80 means, so resolve with the granted list either way.
          const granted = packet?.granted ?? err?.packet?.granted;
          if (Array.isArray(granted) && granted.length === filters.length) resolve([...granted]);
          else if (err) reject(err);
          else resolve(subs.map((s) => s.qos));
        });
      });
    },

    end(graceful = false) {
      const c = client;
      if (!c) return Promise.resolve();
      return new Promise((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        if (graceful && c.connected) {
          // A graceful end waits for in-flight QoS 1 acks; never let a dead link hang shutdown.
          const t = setTimeout(() => { c.end(true, finish); }, GRACEFUL_END_TIMEOUT_MS);
          c.end(false, () => { clearTimeout(t); finish(); });
        } else {
          c.end(true, finish);
        }
      });
    },

    on(event, fn) { events.on(event, fn); },
    off(event, fn) { events.off(event, fn); },
  };
  return transport;
}
