// MemoryBroker + MemoryTransport — an in-process MQTT 3.1.1 broker for conformance runs.
//
// MemoryTransport implements the Transport contract (src/core/types.js) exactly like the real
// MQTT transport, so the gateway core cannot tell the difference. The broker reproduces the
// behaviours of the platform's broker that a gateway has to cope with:
//   - retained messages, replayed on subscribe with the retain flag set;
//   - the Last Will, published when a client vanishes (drop, network loss, session takeover)
//     but NOT after a graceful DISCONNECT;
//   - an ACL: a refused subscription is granted 128 in the SUBACK (the only in-band sign),
//     a refused publish is silently discarded (the publisher is never told);
//   - one live session per client id (a second connect takes the first one over);
//   - per-connection ordered delivery with configurable latency and jitter.
// Every uplink is logged with its publish and arrival times; the "cloud" attaches as a peer
// that sees each one as it arrives. Nothing is ever queued for a disconnected client — that is
// the property the burst detector checks.

/** @typedef {import('../core/types.js').Clock} Clock */
/** @typedef {import('../core/types.js').TransportConnectOptions} TransportConnectOptions */

/** MQTT topic filter match with `+` and `#`; `$`-topics are not matched by leading wildcards. */
export function topicMatches(filter, topic) {
  if (filter === topic) return true;
  const f = filter.split('/');
  const t = topic.split('/');
  if (t[0].startsWith('$') && (f[0] === '+' || f[0] === '#')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** Deterministic PRNG (mulberry32) so jittered runs are reproducible. */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The largest number of logged uplinks matching `pred` whose ARRIVAL times fall inside any
 * window of `windowMs`. A gateway that queued while offline shows up here as a spike.
 * @param {{arrivedAt: number}[]} log
 */
export function maxInWindow(log, windowMs, pred = () => true) {
  const times = log.filter(pred).map((m) => m.arrivedAt).sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi] - times[lo] >= windowMs) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

class Emitter {
  constructor() { this._l = new Map(); }
  on(ev, fn) { if (!this._l.has(ev)) this._l.set(ev, new Set()); this._l.get(ev).add(fn); }
  off(ev, fn) { this._l.get(ev)?.delete(fn); }
  emit(ev, ...args) {
    for (const fn of [...(this._l.get(ev) || [])]) {
      try { fn(...args); } catch (err) { this._onListenerError?.(err); }
    }
  }
  listenerCount(ev) { return this._l.get(ev)?.size || 0; }
}

/**
 * @param {{
 *   clock: Clock,
 *   latencyMs?: number, jitterMs?: number, seed?: number,
 *   users?: Object<string, string>|null,
 *   acl?: {subscribe?: (ctx: {clientId: string, username: string}, filter: string) => boolean,
 *          publish?: (ctx: {clientId: string, username: string}, topic: string) => boolean} | null,
 *   connectFailMs?: number, lwtDelayMs?: number,
 * }} opts
 */
export function createMemoryBroker(opts) {
  const { clock } = opts;
  const rng = createRng(opts.seed ?? 1);
  const cfg = {
    latencyMs: opts.latencyMs ?? 5,
    jitterMs: opts.jitterMs ?? 0,
    users: opts.users ?? null,
    acl: opts.acl ?? null,
    connectFailMs: opts.connectFailMs ?? 1000,
    lwtDelayMs: opts.lwtDelayMs ?? 0,
  };
  let networkUp = true;
  let refuseCode = null;
  /** @type {Map<string, MemoryTransport>} live sessions by client id */
  const sessions = new Map();
  const retained = new Map();
  const peers = new Set();
  const log = [];          // every uplink that reached the broker (incl. last wills)
  const denied = [];       // publishes the ACL discarded
  const listenerErrors = [];
  const stats = { connects: 0, refusedConnects: 0, offlinePublishAttempts: 0, takeovers: 0, wills: 0 };

  const delay = () => cfg.latencyMs + (cfg.jitterMs > 0 ? Math.floor(rng() * (cfg.jitterMs + 1)) : 0);

  function aclAllows(kind, ctx, topicOrFilter) {
    const fn = cfg.acl && cfg.acl[kind];
    return fn ? !!fn(ctx, topicOrFilter) : true;
  }

  /** Deliver an uplink to the broker: retained store, log, peers. */
  function acceptUplink(msg) {
    if (msg.retain) {
      if (msg.payload.length === 0) retained.delete(msg.topic);
      else retained.set(msg.topic, { payload: msg.payload, qos: msg.qos });
    }
    log.push(msg);
    for (const peer of peers) {
      try { peer(msg); } catch (err) { listenerErrors.push(err); }
    }
    // Other connected clients subscribed to the topic receive it too (rare in conformance).
    for (const s of sessions.values()) {
      if (s._clientId !== msg.clientId) s._deliverIfSubscribed(msg.topic, msg.payload, false);
    }
  }

  function publishWill(session, reason) {
    const will = session._opts && session._opts.will;
    if (!will) return;
    const ctx = { clientId: session._clientId, username: session._opts.username };
    const payload = Buffer.from(will.payload);
    const at = clock.now();
    stats.wills++;
    clock.setTimeout(() => {
      if (!aclAllows('publish', ctx, will.topic)) {
        denied.push({ topic: will.topic, clientId: ctx.clientId, payload, at: clock.now(), lwt: true });
        return;
      }
      acceptUplink({ topic: will.topic, payload, qos: will.qos ?? 1, retain: !!will.retain, clientId: ctx.clientId,
        publishedAt: at, arrivedAt: clock.now(), lwt: true, reason });
    }, cfg.lwtDelayMs);
  }

  const broker = {
    clock,
    config: cfg,
    retained,
    log,
    denied,
    stats,
    listenerErrors,
    get networkUp() { return networkUp; },

    /** A new client. `connect()` on it follows the Transport contract. */
    createTransport() { return new MemoryTransport(broker); },

    /** Attach a peer that sees every uplink as it arrives. Returns a detach function. */
    attachPeer(fn) { peers.add(fn); return () => peers.delete(fn); },

    /** Publish from the cloud side (QoS 1, never retained unless asked). */
    publish(topic, payload, { retain = false } = {}) {
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
      if (retain) retained.set(topic, { payload: buf, qos: 1 });
      let delivered = 0;
      for (const s of sessions.values()) if (s._deliverIfSubscribed(topic, buf, false)) delivered++;
      return delivered;
    },

    /** Take the whole network down (every client drops, connects fail) or bring it back. */
    setNetwork(up) {
      networkUp = !!up;
      if (!networkUp) for (const s of [...sessions.values()]) s._lost('network');
    },
    /** Refuse the next connects with this CONNACK code (4 bad credentials, 5 not authorised); null clears. */
    refuseConnects(code) { refuseCode = code; },
    setAcl(acl) { cfg.acl = acl; },
    setLatency(latencyMs, jitterMs = cfg.jitterMs) { cfg.latencyMs = latencyMs; cfg.jitterMs = jitterMs; },
    /** Ungraceful loss of one client's connection (the broker notices and publishes its will). */
    drop(clientId) { sessions.get(clientId)?._lost('dropped'); },
    session(clientId) { return sessions.get(clientId) || null; },
    clientIds() { return [...sessions.keys()]; },
    maxInWindow: (windowMs, pred) => maxInWindow(log, windowMs, pred),

    // ── internals used by MemoryTransport ──
    _delay: delay,
    _aclAllows: aclAllows,
    _acceptUplink: acceptUplink,
    _publishWill: publishWill,
    _open(session) {
      const opts = session._opts;
      if (!networkUp) return { fail: 'network' };
      const code = refuseCode ?? (cfg.users && cfg.users[opts.username] !== opts.password ? 4 : null);
      if (code != null) { stats.refusedConnects++; return { refused: code }; }
      const prev = sessions.get(opts.clientId);
      if (prev && prev !== session) { stats.takeovers++; prev._lost('takeover'); }
      sessions.set(opts.clientId, session);
      stats.connects++;
      return { ok: true };
    },
    _close(session) {
      if (sessions.get(session._clientId) === session) sessions.delete(session._clientId);
    },
  };
  return broker;
}

/** One client connection. Implements the Transport contract. */
export class MemoryTransport extends Emitter {
  constructor(broker) {
    super();
    this._broker = broker;
    this._clock = broker.clock;
    this._connected = false;
    this._opts = null;
    this._clientId = null;
    this._subs = new Map();      // filter -> granted qos
    this._gen = 0;               // connection generation; stale callbacks compare against it
    this._upAt = 0;              // last scheduled uplink arrival (keeps TCP ordering under jitter)
    this._downAt = 0;
    this._pendingAcks = new Set();
    this.stats = { publishes: 0, rejectedWhileDisconnected: 0, subscribes: 0, connects: 0, ends: 0 };
    /** Every connect() call's options and time, and every subscribe() call — for assertions. */
    this.connectCalls = [];
    this.subscribeCalls = [];
    this.endCalls = [];
    this._onListenerError = (err) => broker.listenerErrors.push(err);
  }

  get connected() { return this._connected; }

  /** @param {TransportConnectOptions} opts */
  connect(opts) {
    if (this._connected) return;
    this._opts = { ...opts };
    this._clientId = opts.clientId;
    this.connectCalls.push({ at: this._clock.now(), opts: { ...opts, password: opts.password ? '<set>' : opts.password } });
    const gen = ++this._gen;
    const b = this._broker;
    this.stats.connects++;
    // The CONNECT/CONNACK round trip takes one network delay each way.
    this._clock.setTimeout(() => {
      if (gen !== this._gen) return;
      const res = b._open(this);
      if (res.fail) {
        // No route to the broker: the connect attempt errors out after a while.
        this._clock.setTimeout(() => {
          if (gen !== this._gen) return;
          this.emit('error', Object.assign(new Error('connect ECONNREFUSED (network down)'), { code: 'ECONNREFUSED' }));
          this.emit('close');
        }, Math.max(0, b.config.connectFailMs - 2 * b.config.latencyMs));
        return;
      }
      this._clock.setTimeout(() => {
        if (gen !== this._gen) return;
        if (res.refused != null) {
          this.emit('connack-refused', res.refused);
          this.emit('close');
          return;
        }
        this._connected = true;
        this._subs.clear();          // clean session: nothing survives a reconnect
        this._upAt = 0;
        this._downAt = 0;
        this.emit('connect');
      }, b.config.latencyMs);
    }, b.config.latencyMs);
  }

  publish(topic, payload, opts = {}) {
    if (!this._connected) {
      // The property under test: nothing is buffered for later.
      this.stats.rejectedWhileDisconnected++;
      this._broker.stats.offlinePublishAttempts++;
      return Promise.reject(Object.assign(new Error('not connected'), { code: 'ENOTCONNECTED' }));
    }
    const qos = opts.qos === 1 ? 1 : 0;
    const retain = !!opts.retain;
    const buf = Buffer.isBuffer(payload) ? Buffer.from(payload) : Buffer.from(String(payload));
    const b = this._broker;
    const gen = this._gen;
    const publishedAt = this._clock.now();
    const arriveAt = Math.max(this._upAt, publishedAt + b._delay());
    this._upAt = arriveAt;
    this.stats.publishes++;
    const ctx = { clientId: this._clientId, username: this._opts.username };
    // Bytes already written reach the broker even if the connection dies right after.
    this._clock.setTimeout(() => {
      if (!b._aclAllows('publish', ctx, topic)) {
        b.denied.push({ topic, clientId: ctx.clientId, payload: buf, at: this._clock.now() });
        return;
      }
      b._acceptUplink({ topic, payload: buf, qos, retain, clientId: ctx.clientId, publishedAt, arrivedAt: this._clock.now(), lwt: false });
    }, arriveAt - publishedAt);
    if (qos === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const pending = { reject };
      this._pendingAcks.add(pending);
      // PUBACK comes back one network delay after arrival. A denied QoS 1 publish is still
      // acknowledged — that is how the broker keeps the refusal silent.
      this._clock.setTimeout(() => {
        this._pendingAcks.delete(pending);
        if (gen !== this._gen || !this._connected) reject(new Error('connection closed before PUBACK'));
        else resolve();
      }, arriveAt - publishedAt + b.config.latencyMs);
    });
  }

  subscribe(filters, qos = 0) {
    if (!this._connected) return Promise.reject(new Error('not connected'));
    const list = Array.isArray(filters) ? filters : [filters];
    const b = this._broker;
    const gen = this._gen;
    const ctx = { clientId: this._clientId, username: this._opts.username };
    this.stats.subscribes++;
    this.subscribeCalls.push({ at: this._clock.now(), filters: [...list], qos });
    return new Promise((resolve, reject) => {
      this._clock.setTimeout(() => {
        if (gen !== this._gen || !this._connected) { reject(new Error('connection closed before SUBACK')); return; }
        const granted = list.map((f) => {
          if (!b._aclAllows('subscribe', ctx, f)) return 128;
          const g = Math.min(qos === 1 ? 1 : 0, 1);
          this._subs.set(f, g);
          return g;
        });
        resolve(granted);
        // Retained messages matching a new subscription follow the SUBACK.
        for (const [topic, r] of b.retained) {
          if (list.some((f, i) => granted[i] !== 128 && topicMatches(f, topic))) this._deliver(topic, r.payload, true);
        }
      }, 2 * b.config.latencyMs);
    });
  }

  end(graceful = true) {
    this.stats.ends++;
    this.endCalls.push({ at: this._clock.now(), graceful: !!graceful, connected: this._connected });
    if (!this._connected) {
      // Abort an in-flight connect attempt.
      this._gen++;
      return Promise.resolve();
    }
    if (graceful) this._shutdown('graceful');
    else this._lost('end-ungraceful');
    return Promise.resolve();
  }

  /** Test control: this connection vanishes without a DISCONNECT (the broker sends the will). */
  drop() { this._lost('dropped'); }

  // ── internals ──
  _shutdown(reason) {
    this._gen++;
    this._connected = false;
    this._broker._close(this);
    for (const p of this._pendingAcks) p.reject(new Error(`connection closed (${reason})`));
    this._pendingAcks.clear();
    this._clock.setTimeout(() => this.emit('close'), 0);
  }

  _lost(reason) {
    if (!this._connected) return;
    this._shutdown(reason);
    this._broker._publishWill(this, reason);
  }

  _deliverIfSubscribed(topic, payload, retain) {
    if (!this._connected) return false;
    for (const f of this._subs.keys()) {
      if (topicMatches(f, topic)) { this._deliver(topic, payload, retain); return true; }
    }
    return false;
  }

  _deliver(topic, payload, retain) {
    const gen = this._gen;
    const now = this._clock.now();
    const at = Math.max(this._downAt, now + this._broker._delay());
    this._downAt = at;
    this._clock.setTimeout(() => {
      if (gen !== this._gen || !this._connected) return; // clean session: lost with the connection
      this.emit('message', topic, Buffer.from(payload), { retain: !!retain });
    }, at - now);
  }
}
