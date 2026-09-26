// An in-process aedes broker for transport/gateway tests, with hooks that behave like the
// platform broker's per-gateway ACL: a gateway may only subscribe/publish under its own prefix;
// a refused subscription is granted 0x80; a refused publish is dropped SILENTLY (no disconnect),
// which is exactly why the SUBACK is the only in-band ACL signal.

import { createServer } from 'node:net';
import Aedes from 'aedes';
import mqtt from 'mqtt';

/**
 * @param {Object} opts
 * @param {Object<string, {password: string, prefix?: string, denySubscribe?: string[], connack?: number}>} opts.users
 * @param {() => number} [opts.now]  stamps every recorded event (`at`)
 *   prefix undefined = unrestricted (the "backend"). denySubscribe: suffixes refused with 0x80.
 */
export async function startBroker({ users, now = () => Date.now() }) {
  const aedes = Aedes.createBroker ? Aedes.createBroker() : new Aedes();
  const events = [];
  const push = events.push.bind(events);
  // Every event is stamped with the test's clock (a manual one in gateway tests).
  events.push = (...evs) => push(...evs.map((e) => ({ ...e, at: now() })));
  const byClient = new Map();

  const userOf = (client) => byClient.get(client?.id);
  const allowed = (client, topic) => {
    const u = userOf(client);
    if (!u) return false;
    if (u.prefix === undefined) return true;
    return topic.startsWith(`${u.prefix}/`);
  };

  // preConnect sees the raw CONNECT packet (clean flag, protocol level, will) before auth.
  const connects = new Map();
  aedes.preConnect = (client, packet, cb) => {
    connects.set(client, {
      clean: packet.clean, version: packet.protocolVersion, keepalive: packet.keepalive,
      will: packet.will ? { topic: packet.will.topic, payload: Buffer.from(packet.will.payload).toString(), qos: packet.will.qos, retain: packet.will.retain } : null,
    });
    cb(null, true);
  };

  aedes.authenticate = (client, username, password, cb) => {
    const u = users[username];
    if (!u || u.connack || u.password !== password?.toString()) {
      const err = new Error('bad credentials');
      err.returnCode = u?.connack ?? 5;
      events.push({ type: 'refused', clientId: client.id, username, code: err.returnCode });
      cb(err, false);
      return;
    }
    byClient.set(client.id, u);
    events.push({ type: 'connect', clientId: client.id, username, ...connects.get(client) });
    cb(null, true);
  };

  aedes.authorizeSubscribe = (client, sub, cb) => {
    const u = userOf(client);
    const denied = !allowed(client, sub.topic) || (u?.denySubscribe ?? []).some((s) => sub.topic.endsWith(`/${s}`));
    events.push({ type: 'subscribe', clientId: client.id, topic: sub.topic, qos: sub.qos, denied });
    cb(null, denied ? null : sub);
  };

  aedes.authorizePublish = (client, packet, cb) => {
    const isWill = !!client && packet === client.will;
    const ok = !client || allowed(client, packet.topic);
    events.push({
      type: 'publish', clientId: client?.id ?? null, topic: packet.topic, payload: Buffer.from(packet.payload).toString(),
      qos: packet.qos, retain: !!packet.retain, isWill, denied: !ok,
    });
    if (!ok) {
      // Silent drop: deliver nowhere, keep the connection (a QoS 1 publish still gets its PUBACK).
      packet.topic = `$denied/${packet.topic}`;
      packet.retain = false;
    }
    cb(null);
  };

  aedes.on('clientDisconnect', (client) => {
    events.push({ type: 'disconnect', clientId: client.id, graceful: client._disconnected === true });
  });

  const server = createServer(aedes.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `mqtt://127.0.0.1:${port}`;
  const clients = [];

  return {
    aedes,
    url,
    port,
    events,
    /** Publishes that clients made (not the broker's own deliveries). */
    publishes: (clientId) => events.filter((e) => e.type === 'publish' && (!clientId || e.clientId === clientId)),
    /** Kick a client from the broker side (no DISCONNECT from the client → its will fires). */
    kick(clientId) {
      const c = aedes.clients[clientId];
      if (c) c.close();
      return !!c;
    },
    /** A backend-side client that sees everything under tenants/#. */
    async cloud({ username = 'backend', password = 'backend-pw', clientId = `cloud-${clients.length}` } = {}) {
      const received = [];
      const c = mqtt.connect(url, { clientId, username, password, protocolVersion: 4, reconnectPeriod: 0 });
      clients.push(c);
      c.on('message', (topic, payload, packet) => received.push({ topic, payload: payload.toString(), retain: packet.retain }));
      await new Promise((resolve, reject) => { c.once('connect', resolve); c.once('error', reject); });
      await c.subscribeAsync('tenants/#', { qos: 1 });
      return { client: c, received, publish: (topic, payload, opts = { qos: 1 }) => c.publishAsync(topic, payload, opts) };
    },
    async close() {
      await Promise.all(clients.map((c) => c.endAsync(true).catch(() => {})));
      for (const c of Object.values(aedes.clients)) c.close();
      await new Promise((r) => server.close(r));
      await new Promise((r) => aedes.close(r));
    },
  };
}

/** Poll until `fn()` is truthy (real time), or fail with `what`. */
export async function waitFor(fn, what = 'condition', timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
