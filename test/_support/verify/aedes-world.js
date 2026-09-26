// A real MQTT world for end-to-end tests: an in-process aedes broker on a random port whose
// hooks behave like the platform's broker, and the scripted platform attached to it as an
// ordinary MQTT client.
//
// Like the platform's broker: a credential may only subscribe and publish under its own gateway
// prefix; a refused subscription is granted 128 in the SUBACK; a refused publish is dropped
// silently (the publisher is not disconnected and nobody receives it).
import { createServer } from 'node:net';
import Aedes from 'aedes';
import mqtt from 'mqtt';

export const BACKEND_USER = 'backend';

/** Resolve with `promise`, or with undefined after `ms` (never rejects, never hangs). */
export function withTimeout(promise, ms) {
  let t;
  return Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((resolve) => { t = setTimeout(resolve, ms); })]).finally(() => clearTimeout(t));
}

/** Resolve on `event`, reject after `ms`. */
export function once(emitter, event, ms, what = event) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: no '${event}' within ${ms} ms`)), ms);
    emitter.once(event, (...args) => { clearTimeout(t); resolve(args); });
  });
}
export const BACKEND_PASS = 'backend-secret-e2e';

/**
 * @param {{users: Object<string, {password: string, prefix: string}>}} opts
 */
export async function startAedes({ users }) {
  const published = [];   // every publish the broker handled: {topic, payload, retain, qos, clientId, lwt, at}
  const subscribes = [];  // {clientId, topic, granted}
  const denied = [];      // publishes dropped by the ACL
  let refuseConnects = false;
  const who = (client) => client && client.__user;

  const aedes = new Aedes({
    maxClientsIdLength: 128,
    heartbeatInterval: 60_000,
    authenticate(client, username, password, cb) {
      if (refuseConnects) return cb(Object.assign(new Error('server unavailable'), { returnCode: 3 }), false);
      const pw = password ? password.toString() : '';
      if (username === BACKEND_USER && pw === BACKEND_PASS) { client.__user = { backend: true }; return cb(null, true); }
      const u = users[username];
      if (!u || u.password !== pw) return cb(Object.assign(new Error('bad credentials'), { returnCode: 4 }), false);
      client.__user = { prefix: u.prefix };
      return cb(null, true);
    },
    authorizeSubscribe(client, sub, cb) {
      const u = who(client);
      const ok = u && (u.backend || sub.topic.startsWith(`${u.prefix}/`));
      subscribes.push({ clientId: client.id, topic: sub.topic, granted: ok ? sub.qos : 128 });
      cb(null, ok ? sub : null);
    },
    authorizePublish(client, packet, cb) {
      const u = who(client);
      if (u && !u.backend && !packet.topic.startsWith(`${u.prefix}/`)) {
        denied.push({ clientId: client.id, topic: packet.topic });
        // Silent drop: move it where no subscription can see it, instead of disconnecting.
        packet.topic = `$denied/${packet.topic}`;
      }
      cb(null);
    },
  });
  aedes.on('publish', (packet, client) => {
    if (!client || packet.topic.startsWith('$')) return;
    // A client whose connection is already closing can only be publishing its will.
    published.push({ topic: packet.topic, payload: Buffer.from(packet.payload), retain: !!packet.retain, qos: packet.qos, clientId: client.id, lwt: !!client.closed, at: Date.now() });
  });
  const server = createServer(aedes.handle);
  const sockets = new Set();
  server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    aedes,
    port,
    url: `mqtt://127.0.0.1:${port}`,
    published,
    subscribes,
    denied,
    set refuseConnects(v) { refuseConnects = !!v; },
    /** The live connection of a client id (aedes keeps one per id). */
    client: (id) => aedes.clients[id] || null,
    /** Kill a client's TCP connection without a DISCONNECT (the broker publishes its will). */
    destroy(id) { const c = aedes.clients[id]; if (c) c.conn.destroy(); return !!c; },
    /** Tear everything down; bounded, so a wedged connection can never keep the test process alive. */
    async close() {
      for (const sock of sockets) sock.destroy();
      await withTimeout(new Promise((resolve) => aedes.close(resolve)), 3_000);
      await withTimeout(new Promise((resolve) => server.close(() => resolve())), 3_000);
    },
  };
}

/**
 * The broker-side interface createScriptedCloud expects (attachPeer / publish), backed by a real
 * MQTT client. Retain flags and "was this a will" come from the broker's own record, because
 * MQTT 3.1.1 does not forward the publisher's retain flag to live subscribers.
 */
export async function connectCloud(world) {
  const CLOUD_ID = 'scripted-cloud';
  const client = mqtt.connect(world.url, { clientId: CLOUD_ID, username: BACKEND_USER, password: BACKEND_PASS, protocolVersion: 4, reconnectPeriod: 0, clean: true });
  await once(client, 'connect', 5_000, 'scripted cloud connect');
  await client.subscribeAsync('tenants/+/sources/gateway/+/#', { qos: 1 });
  const peers = new Set();
  const pending = [];
  let timer = null;
  const findMeta = (m) => {
    for (const r of world.published) {
      if (!r.used && r.topic === m.topic && r.payload.equals(m.payload)) { r.used = true; return r; }
    }
    return null;
  };
  // The broker records a publish a moment after it has written it to subscribers, so a message
  // can arrive before its record: hold it (in order) until the record shows up.
  const pump = () => {
    timer = null;
    while (pending.length) {
      const m = pending[0];
      const meta = findMeta(m);
      if (!meta && Date.now() - m.arrivedAt < 500) { timer = setTimeout(pump, 5); return; }
      pending.shift();
      if (meta && meta.clientId === CLOUD_ID) continue;   // our own downlinks, echoed by the wildcard
      const msg = {
        topic: m.topic, payload: m.payload, qos: meta ? meta.qos : 0, retain: meta ? meta.retain : false,
        clientId: meta ? meta.clientId : null, publishedAt: meta ? meta.at : m.arrivedAt, arrivedAt: m.arrivedAt, lwt: meta ? meta.lwt : false,
      };
      for (const p of peers) p(msg);
    }
  };
  client.on('message', (topic, payload) => {
    pending.push({ topic, payload: Buffer.from(payload), arrivedAt: Date.now() });
    if (!timer) pump();
  });
  return {
    client,
    attachPeer(fn) { peers.add(fn); return () => peers.delete(fn); },
    publish(topic, payload) { client.publish(topic, payload, { qos: 1 }); return 1; },
    close: () => { clearTimeout(timer); return withTimeout(client.endAsync(), 2_000); },
  };
}

export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `pred` every 50 ms for up to `ms`; resolves to whether it became true. */
export async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(50);
  }
  return !!pred();
}
