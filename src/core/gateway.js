// The gateway lifecycle: BOOT → CONNECTING → ONLINE ⇄ OFFLINE → SHUTDOWN, plus in-process
// RESTART. This module wires every other core module together; it owns no protocol detail that
// a smaller module can own instead.
//
// BOOT      take the per-gateway lock, load state, start the devices of the last applied
//           config immediately (offline readings go to the store-and-forward buffer).
// CONNECT   one MQTT connection, client id = gateway id, Last Will {"online":false} retained
//           QoS 1. Our own backoff: 1 s doubling to 60 s, ±20 % jitter (5 min cap after the
//           broker rejected the credentials).
// ONLINE    subscribe the 7 filters and check the SUBACK → heartbeat → capability report →
//           config/request 2 s later → presence timers → queued alerts → buffer replay once the
//           connection has been stable for 10 s.
// OFFLINE   timers that talk to the platform stop; devices keep reading into the buffer.
// SHUTDOWN  retained {"online":false} at QoS 1 (≤2 s), clean DISCONNECT, close drivers, save
//           state, release the lock.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { realClock } from './clock.js';
import { createTopics } from './topics.js';
import { createValidators } from './schemas.js';
import { openState } from './state.js';
import { createBackfill } from './backfill.js';
import { createConfigSync } from './config-sync.js';
import { normalizeConfig, pruneOverrides } from './config-model.js';
import { createMqttTransport } from './transport.js';

/** @typedef {import('./types.js').FileConfig} FileConfig */
/** @typedef {import('./types.js').Transport} Transport */
/** @typedef {import('./types.js').Clock} Clock */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').DeviceSpec} DeviceSpec */

const PKG_VERSION = createRequire(import.meta.url)('../../package.json').version;

export const KEEPALIVE_S = 60;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60000;
export const AUTH_BACKOFF_MAX_MS = 300000;
export const ACL_RETRY_MS = 300000;
export const JITTER = 0.2;
export const STABLE_BEFORE_DRAIN_MS = 10000;
export const TAKEOVER_WINDOW_MS = 5000;
export const TAKEOVER_DROPS = 3;
export const RUNTIME_EVERY_MS = 10000;
const GOODBYE_TIMEOUT_MS = 2000;
const END_TIMEOUT_MS = 3000;
const SCHEDULER_STOP_TIMEOUT_MS = 10000;
const DRIVER_CLOSE_TIMEOUT_MS = 5000;
const ONLINE_FALSE = '{"online":false}';

/** Where each runtime factory lives. Tests inject any subset through `factories`. */
const FACTORY_MODULES = {
  createPublisher: './publisher.js',
  createThresholds: './thresholds.js',
  createScheduler: './scheduler.js',
  createPresence: './presence.js',
  createDebug: './debug.js',
  createCommands: './commands.js',
  buildCapabilities: './capabilities.js',
  createSim: './sim.js',
  createDriverRegistry: '../drivers/index.js',
};

async function resolveFactories(overrides = {}) {
  const out = { ...overrides };
  await Promise.all(Object.entries(FACTORY_MODULES).map(async ([name, path]) => {
    if (typeof out[name] === 'function') return;
    const mod = await import(path);
    if (typeof mod[name] !== 'function') throw new Error(`${path} does not export ${name}`);
    out[name] = mod[name];
  }));
  return out;
}

const NOOP = () => {};
/** @type {Logger} */
const nullLogger = {
  debug: NOOP, info: NOOP, warn: NOOP, error: NOOP,
  child: () => nullLogger, redact: NOOP, tap: () => NOOP,
};

async function defaultLogger(config, clock) {
  try {
    const { createLogger } = await import('./log.js');
    return createLogger({ level: config.log?.level ?? 'info', format: config.log?.format ?? 'auto', clock });
  } catch {
    return nullLogger;
  }
}

/** Promise that settles with `p`, or rejects after `ms` on the gateway's clock. */
function withTimeout(clock, p, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clock.clearTimeout(t)),
    new Promise((_, reject) => { t = clock.setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]);
}

function brokerHost(url) {
  try { return new URL(url).host; } catch { return '(invalid broker URL)'; }
}

/** Config keys whose change needs a fresh connection / fresh modules, not just a re-request. */
const MATERIAL_KEYS = ['broker', 'tenant', 'gateway', 'username', 'password', 'tls', 'drivers', 'driverDir',
  'configCap', 'minIntervalMs', 'backfill', 'host', 'bridge'];

function materiallyDifferent(a, b) {
  return MATERIAL_KEYS.some((k) => JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null));
}

/**
 * @param {Object} o
 * @param {FileConfig} o.config  Used as given for every in-process restart (never re-read from disk).
 * @param {string} o.home  SYNACL_GATEWAY_HOME.
 * @param {Transport} [o.transport]  Default: MQTT over mqtt.js.
 * @param {Clock} [o.clock]
 * @param {import('./types.js').DriverRegistry | import('./types.js').DriverDefinition[] |
 *   {builtins?: Object[], extra?: Object[]}} [o.drivers]  An array replaces the built-in drivers.
 * @param {Logger} [o.log]
 * @param {Object<string, Function>} [o.factories]  Replace runtime factories (tests).
 * @param {() => number} [o.random]  Jitter source (tests pass a constant).
 * @param {string} [o.version]  Reported firmware version (default: package version).
 */
export function createGateway({ config, home, transport, clock = realClock, drivers, log, factories, random = Math.random, version = PKG_VERSION }) {
  if (!config || typeof config !== 'object') throw new TypeError('createGateway: config is required');
  if (typeof home !== 'string' || home === '') throw new TypeError('createGateway: home is required');

  let cfg = config;
  /** @type {Transport|null} */
  let tr = transport ?? null;
  /** @type {Logger|null} */
  let rootLog = log ?? null;
  /** Everything that belongs to one run (BOOT … SHUTDOWN); null while stopped. */
  let ctx = null;
  let lastRuntime = null;
  let op = Promise.resolve();

  /** Lifecycle operations never interleave: a restart command during a stop waits for it. */
  function serial(fn) {
    const p = op.then(fn, fn);
    op = p.catch(() => {});
    return p;
  }

  // ─── runtime.json ──────────────────────────────────────────────────────────────────────

  function runtimeSnapshot(c) {
    let devices = [];
    try {
      devices = (c.scheduler.snapshot() ?? []).map((d) => ({
        id: d.id,
        protocol: d.protocol,
        intervalMs: d.intervalMs,
        lastDataTs: d.lastDataTs ?? null,
        reachable: d.reachable ?? null,
        reason: d.reason ?? null,
        paused: d.paused ?? false,
      }));
    } catch { /* a snapshot must never take the runtime file down */ }
    return {
      pid: process.pid,
      version,
      startedAt: c.startedAt,
      updatedAt: clock.now(),
      state: c.phase,
      connected: c.phase === 'online' && tr.connected,
      connectedSince: c.phase === 'online' ? c.connectedSince : null,
      lastHeartbeatAt: c.lastHeartbeatAt,
      configHash: c.configSync.currentHash(),
      configSynced: c.configSync.synced(),
      devices,
      buffer: c.backfill.stats(),
    };
  }

  function writeRuntime(c = ctx) {
    if (!c) return;
    const r = runtimeSnapshot(c);
    lastRuntime = r;
    try {
      c.state.writeRuntime(r);
    } catch (err) {
      c.sys.debug('could not write runtime.json', { error: err.message });
    }
  }

  // ─── BOOT ──────────────────────────────────────────────────────────────────────────────

  async function startInternal() {
    if (ctx) return;
    if (!rootLog) rootLog = await defaultLogger(cfg, clock);
    const L = rootLog;
    if (cfg.password) L.redact(cfg.password);
    const sys = L.child?.('system') ?? L;
    const net = L.child?.('network') ?? L;
    if (!tr) tr = createMqttTransport({ log: net });

    const f = await resolveFactories(factories);
    const topics = createTopics({ tenant: cfg.tenant, gateway: cfg.gateway });
    const ca = cfg.tls?.caFile ? readFileSync(cfg.tls.caFile) : undefined;
    const validators = createValidators();
    const state = openState({ home, tenant: cfg.tenant, gateway: cfg.gateway, clock, log: sys });
    state.lock();

    /** @type {any} */
    const c = {
      L, sys, net, f, topics, validators, state, ca,
      phase: 'connecting',
      startedAt: clock.now(),
      stopping: false,
      gen: 0,
      attempts: 0,
      refused: null,
      aclDenied: false,
      quickDrops: 0,
      connackAt: null,
      connectedSince: null,
      lastHeartbeatAt: null,
      devices: /** @type {DeviceSpec[]} */ ([]),
      timers: { reconnect: null, drainStart: null, drain: null, runtime: null },
      abort: new AbortController(),
      listeners: null,
    };
    try {
      await buildModules(c);
    } catch (err) {
      // Undo what was started, so a failed start leaves no timers, handles or lock behind.
      c.configSync?.stop();
      await Promise.resolve(c.scheduler?.stop()).catch(() => {});
      c.presence?.stop();
      c.debug?.stop?.();
      c.abort.abort();
      if (c.ownsRegistry) await Promise.resolve(c.registry?.closeAll()).catch(() => {});
      try { c.backfill?.close(); } catch { /* ignore */ }
      state.unlock();
      throw err;
    }
    ctx = c;
    attach(c);
    c.timers.runtime = clock.setInterval(() => writeRuntime(c), RUNTIME_EVERY_MS);
    writeRuntime(c);
    sys.info('gateway starting', { gateway: cfg.gateway, version, broker: brokerHost(cfg.broker), devices: c.devices.length });
    connectNow(c);
  }

  async function buildModules(c) {
    const { f, L, sys, topics, validators, state } = c;
    const minIntervalMs = cfg.minIntervalMs ?? 1000;

    let registry;
    c.ownsRegistry = !(drivers && typeof drivers.forProtocol === 'function');
    if (!c.ownsRegistry) {
      registry = drivers;
    } else {
      const opts = { config: cfg, home, log: L, clock, signal: c.abort.signal };
      if (Array.isArray(drivers)) opts.builtins = drivers;
      else if (drivers && typeof drivers === 'object') Object.assign(opts, drivers.builtins ? { builtins: drivers.builtins } : {}, drivers.extra ? { extra: drivers.extra } : {});
      registry = await f.createDriverRegistry(opts);
    }
    c.registry = registry;

    c.backfill = createBackfill({ dir: state.backfillDir, clock, log: sys, limits: cfg.backfill ?? {} });
    const publisher = f.createPublisher({ transport: tr, topics, validators, backfill: c.backfill, clock, log: L, strict: false });
    c.publisher = publisher;
    c.thresholds = f.createThresholds({ publisher, clock, log: L });
    c.sim = f.createSim({ clock });
    c.scheduler = f.createScheduler({
      clock, log: L, drivers: registry, publisher, thresholds: c.thresholds, state, minIntervalMs,
      onReachability: (id, s) => c.presence?.transition(id, s),
      sim: c.sim,
    });

    // Presence publishes the heartbeat; watching its successful sends gives runtime.json a
    // truthful lastHeartbeatAt without presence having to know runtime.json exists.
    const statusTopicNames = new Set(['gateway.status', 'status']);
    const watched = {
      ...publisher,
      async gateway(name, body, opts) {
        const ok = await publisher.gateway(name, body, opts);
        if (ok !== false && statusTopicNames.has(name) && body?.online === true) c.lastHeartbeatAt = clock.now();
        return ok;
      },
    };
    c.presence = f.createPresence({
      publisher: watched, clock, version, log: L,
      getDevices: () => c.scheduler.snapshot(),
      getHeartbeatExtras: () => {
        const b = c.backfill.stats();
        return { bufRam: 0, bufFlash: b.records, bufDropped: b.dropped, flashErrors: b.writeErrors, simMode: !!c.sim?.active };
      },
    });
    c.debug = f.createDebug({
      publisher, log: L, clock, version,
      snapshot: () => ({ configHash: c.configSync.currentHash(), connected: tr.connected, devices: c.scheduler.snapshot() }),
    });
    c.caps = f.buildCapabilities({ version, gatewayId: cfg.gateway, drivers: registry, configCap: cfg.configCap ?? null });
    c.commands = f.createCommands({
      scheduler: c.scheduler, debug: c.debug, capabilities: c.caps, publisher, log: L, clock, validators,
      lifecycle: {
        restart: () => api.restart(),
        resetConfig: () => resetConfig(c),
        setSim: (on) => {
          if (on) c.sim.start(); else c.sim.stop();
          c.presence.heartbeatNow().catch(() => {});
        },
      },
    });

    // The config that was running before this start. config-sync is created first (it reports
    // the hash in runtime.json); the devices are applied BEFORE connecting so they read (into
    // the buffer) while the uplink is still coming up.
    const persisted = state.readConfigRaw();
    let bootDoc = null;
    if (persisted) {
      try { bootDoc = JSON.parse(persisted.bytes.toString('utf8')); } catch { /* handled below */ }
      if (!bootDoc || !Array.isArray(bootDoc.devices)) {
        sys.warn('stored configuration is not a device list; discarding it');
        state.clearConfig();
        bootDoc = null;
      }
    }
    c.configSync = createConfigSync({
      transport: tr, topics, state, clock, log: sys, validators,
      configCap: cfg.configCap ?? null,
      initialHash: bootDoc ? persisted.meta.hash : 0,
      onApply: (bytes, doc) => applyDoc(c, doc, { prune: true }),
      onSynced: () => writeRuntime(c),
    });
    if (bootDoc) {
      try {
        await applyDoc(c, bootDoc, { prune: false });
        sys.info('running the stored configuration until the platform confirms it', { hash: persisted.meta.hash, devices: c.devices.length });
      } catch (err) {
        // Still connect: the platform can send a configuration that works.
        sys.error('could not start the stored configuration', { error: err?.message ?? String(err) });
      }
    }
  }

  /** Normalise a full config document and hand it to the scheduler. */
  async function applyDoc(c, doc, { prune }) {
    const receivedAt = clock.now();
    let overrides = c.state.readOverrides();
    if (prune) {
      const r = pruneOverrides(overrides, receivedAt);
      if (r.changed) {
        overrides = r.overrides;
        try { c.state.writeOverrides(overrides); } catch (err) { c.sys.warn('could not save overrides', { error: err.message }); }
      }
    }
    const { devices, errors } = normalizeConfig(doc, {
      overrides, minIntervalMs: cfg.minIntervalMs ?? 1000, receivedAt: prune ? receivedAt : undefined,
    });
    for (const e of errors) c.sys.warn(`configuration: ${e}`);
    c.thresholds.reconcile(c.devices, devices);
    c.devices = devices;
    await c.scheduler.apply(devices);
    writeRuntime(c);
  }

  // ─── CONNECT / ONLINE / OFFLINE ────────────────────────────────────────────────────────

  function attach(c) {
    const l = {
      connect: () => onConnect(c),
      close: () => onClose(c),
      message: (topic, payload, info) => onMessage(c, topic, payload, info),
      'connack-refused': (code) => onRefused(c, code),
      error: (err) => c.net.warn('connection error', { error: err?.message ?? String(err) }),
    };
    for (const [ev, fn] of Object.entries(l)) tr.on(ev, fn);
    c.listeners = l;
  }

  function detach(c) {
    if (!c.listeners) return;
    for (const [ev, fn] of Object.entries(c.listeners)) tr.off(ev, fn);
    c.listeners = null;
  }

  function connectNow(c) {
    if (c.stopping) return;
    c.phase = 'connecting';
    c.refused = null;
    c.connackAt = null;
    tr.connect({
      url: cfg.broker,
      clientId: cfg.gateway,
      username: cfg.username,
      password: cfg.password,
      keepalive: KEEPALIVE_S,
      will: { topic: c.topics.up('gateway.status'), payload: ONLINE_FALSE, qos: 1, retain: true },
      ...(c.ca ? { ca: c.ca } : {}),
      rejectUnauthorized: cfg.tls?.rejectUnauthorized !== false,
    });
  }

  function onRefused(c, code) {
    c.refused = code;
    if (code === 4 || code === 5) {
      c.net.error(`the broker rejected this gateway's credentials (CONNACK ${code}) — re-run \`synacl-gateway init\` with the line from Connection Info`);
    } else {
      c.net.error(`the broker refused the connection (CONNACK ${code})`);
    }
  }

  function onConnect(c) {
    if (c.stopping) return;
    const gen = ++c.gen;
    c.connackAt = clock.now();
    c.refused = null;
    c.net.info('connected', { broker: brokerHost(cfg.broker) });
    onlineEntry(c, gen).catch((err) => c.sys.error('coming online failed', { error: err?.message ?? String(err) }));
  }

  async function onlineEntry(c, gen) {
    const live = () => gen === c.gen && !c.stopping;
    const filters = c.topics.subscriptions();
    let granted;
    try {
      granted = await tr.subscribe(filters, 1);
    } catch (err) {
      if (live()) c.net.warn('subscribe failed', { error: err.message });
      return;
    }
    if (!live()) return;
    const denied = filters.filter((_, i) => !(granted[i] >= 0 && granted[i] <= 2));
    if (denied.length > 0) {
      c.aclDenied = true;
      for (const t of denied) {
        c.net.error(`ACL_DENIED: the broker refused the subscription to ${t} — the tenant/gateway in config.json do not match this credential; retrying in 5 minutes`);
      }
      await tr.end(true);
      return;
    }
    c.aclDenied = false;
    c.phase = 'online';
    c.connectedSince = c.connackAt;

    await c.presence.heartbeatNow().catch((err) => c.net.warn('heartbeat failed', { error: err?.message }));
    if (!live()) return;
    await c.publisher.gateway('gateway.firmware-response', c.caps);
    if (!live()) return;
    c.configSync.onConnected();
    c.presence.start();
    await c.thresholds.flushQueued();
    if (!live()) return;
    const wait = Math.max(0, c.connackAt + STABLE_BEFORE_DRAIN_MS - clock.now());
    c.timers.drainStart = clock.setTimeout(() => {
      c.timers.drainStart = null;
      if (!live()) return;
      drainOnce(c, gen);
      c.timers.drain = clock.setInterval(() => drainOnce(c, gen), Math.max(100, cfg.backfill?.batchIntervalMs ?? 1000));
    }, wait);
    writeRuntime(c);
  }

  /** One buffered batch on data/backfill. Published directly: the cursor may only advance once the socket took it. */
  function drainOnce(c, gen) {
    if (gen !== c.gen || c.stopping || !tr.connected) return;
    const topic = c.topics.up('gateway.data-backfill');
    c.backfill.drainTick(async (batch) => {
      const body = { batch };
      const v = c.validators.validate('data-backfill', body);
      if (!v.ok) {
        c.sys.error('a buffered batch does not match the data-backfill schema; skipping it', { errors: v.errors.slice(0, 3) });
        return;
      }
      await tr.publish(topic, JSON.stringify(body), { qos: 0 });
    }).catch((err) => c.net.debug('buffered batch not sent', { error: err?.message }));
  }

  function clearConnectionTimers(c) {
    if (c.timers.drainStart !== null) { clock.clearTimeout(c.timers.drainStart); c.timers.drainStart = null; }
    if (c.timers.drain !== null) { clock.clearInterval(c.timers.drain); c.timers.drain = null; }
  }

  function onClose(c) {
    if (c.stopping) return;
    c.gen++;
    clearConnectionTimers(c);
    const now = clock.now();
    if (c.connackAt !== null) {
      c.presence.stop();
      c.configSync.onDisconnected();
      const lasted = now - c.connackAt;
      c.net.warn('disconnected', { afterMs: lasted });
      if (lasted < TAKEOVER_WINDOW_MS && !c.aclDenied) {
        c.quickDrops++;
        if (c.quickDrops >= TAKEOVER_DROPS) {
          c.net.warn(`another process with gateway id ${cfg.gateway} is connected (session takeover) — only one instance per gateway can be online; stop the other one`);
          c.quickDrops = 0;
        }
      } else {
        c.quickDrops = 0;
        // A connection that held resets the backoff; one that keeps dropping does not.
        if (!c.aclDenied) c.attempts = 0;
      }
    }
    c.connackAt = null;
    c.connectedSince = null;
    c.phase = 'offline';
    writeRuntime(c);
    scheduleReconnect(c);
  }

  function scheduleReconnect(c) {
    if (c.stopping || c.timers.reconnect !== null) return;
    let delay;
    if (c.aclDenied) {
      delay = ACL_RETRY_MS;
    } else {
      const cap = c.refused === 4 || c.refused === 5 ? AUTH_BACKOFF_MAX_MS : BACKOFF_MAX_MS;
      const base = Math.min(cap, BACKOFF_MIN_MS * 2 ** Math.min(c.attempts, 20));
      delay = Math.max(0, Math.round(base * (1 + JITTER * (2 * random() - 1))));
      c.attempts++;
    }
    c.net.info('reconnecting', { inMs: delay });
    c.timers.reconnect = clock.setTimeout(() => {
      c.timers.reconnect = null;
      connectNow(c);
    }, delay);
  }

  function onMessage(c, topic, payload, info) {
    if (c.stopping) return;
    const d = c.topics.parseDown(topic);
    if (!d) return;
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    if (d.kind === 'gateway.config-push') {
      c.configSync.onMessage(buf);
      return;
    }
    // Commands are never retained by the platform. A retained one (left on the broker by some
    // other client) would re-run on every connect — a retained `restart` would loop forever.
    if (info?.retain) {
      c.sys.warn('ignoring a retained command', { topic: d.kind });
      return;
    }
    Promise.resolve()
      .then(() => c.commands.onMessage(d.kind, d.deviceId, buf))
      .catch((err) => c.sys.error('command failed', { kind: d.kind, error: err?.message ?? String(err) }));
  }

  // ─── SHUTDOWN / RESTART ────────────────────────────────────────────────────────────────

  async function stopInternal() {
    const c = ctx;
    if (!c) return;
    c.stopping = true;
    c.gen++;
    for (const [k, t] of Object.entries(c.timers)) {
      if (t === null) continue;
      if (k === 'drain' || k === 'runtime') clock.clearInterval(t); else clock.clearTimeout(t);
      c.timers[k] = null;
    }
    c.configSync.stop();
    const soft = (p, ms, what) => withTimeout(clock, p, ms, what).catch((err) => c.sys.warn(`${what}: ${err?.message ?? err}`));

    await soft(c.scheduler.stop(), SCHEDULER_STOP_TIMEOUT_MS, 'stopping devices');
    c.presence.stop();
    c.debug.stop?.();

    if (tr.connected) {
      // Retained, so the platform shows the gateway offline at once instead of 180 s later.
      const goodbye = typeof c.presence.goodbye === 'function'
        ? c.presence.goodbye()
        : tr.publish(c.topics.up('gateway.status'), ONLINE_FALSE, { qos: 1, retain: true });
      await soft(goodbye, GOODBYE_TIMEOUT_MS, 'publishing offline status');
      await soft(tr.end(true), END_TIMEOUT_MS, 'disconnecting');
    } else {
      await soft(tr.end(false), END_TIMEOUT_MS, 'closing the connection attempt');
    }
    detach(c);
    c.abort.abort();
    if (c.ownsRegistry) await soft(c.registry.closeAll(), DRIVER_CLOSE_TIMEOUT_MS, 'closing drivers');
    c.backfill.close();
    c.phase = 'stopped';
    writeRuntime(c);
    c.state.unlock();
    ctx = null;
    c.sys.info('gateway stopped');
  }

  async function resetConfig(c) {
    c.sys.info('resetting the configuration: the next request asks for everything (hash 0)');
    c.state.clearConfig();
    c.state.writeOverrides({ v: 1, devices: {} });
    await api.restart();
  }

  const api = {
    /** BOOT and the first connect attempt; resolves without waiting for the broker. */
    start: () => serial(startInternal),

    stop: () => serial(stopInternal),

    /** In-process restart with the same config object (platform `restart`, `reset/config`). */
    restart: () => serial(async () => {
      ctx?.sys.info('restarting in-process');
      await stopInternal();
      await startInternal();
    }),

    /**
     * SIGHUP. A new config that changes identity, credentials, TLS, drivers or limits → restart
     * with it; otherwise just ask the platform for the configuration again.
     * @param {FileConfig} [newConfig]
     * @returns {Promise<'requested'|'restarted'>}
     */
    reload: (newConfig) => serial(async () => {
      if (newConfig && materiallyDifferent(cfg, newConfig)) {
        const wasRunning = !!ctx;
        await stopInternal();
        cfg = newConfig;
        if (wasRunning) await startInternal();
        return 'restarted';
      }
      if (newConfig) cfg = newConfig;
      ctx?.configSync.requestNow('reload');
      return 'requested';
    }),

    /** What runtime.json holds (the last written snapshot while stopped). */
    status() {
      if (ctx) return runtimeSnapshot(ctx);
      return lastRuntime ?? { pid: process.pid, version, state: 'stopped', connected: false };
    },

    /** Test hooks: the live config-sync and state of the current run. */
    get configSync() { return ctx?.configSync ?? null; },
    get state() { return ctx?.state ?? null; },
  };
  return api;
}
