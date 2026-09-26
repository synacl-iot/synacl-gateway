// The scenario harness: `h.check()` for assertions, and `h.env()` to stand up a complete
// offline world — virtual clock, in-memory broker with an ACL like the platform's, scripted platform,
// scripted drivers, a quiet capturing logger — around the REAL gateway core.
//
// Every environment adds three checks of its own when the scenario ends, because they hold
// for every scenario: every uplink passed strict schema validation (and used the right topic
// and retain flag), the broker password never reached a log line, and no timer callback threw.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVirtualClock, settle } from './virtual-clock.js';
import { createMemoryBroker } from './memory-transport.js';
import { createScriptedCloud, EMPTY_CONFIG } from './scripted-cloud.js';
import { createDriverControls, createScriptedDrivers } from './scripted-drivers.js';
import { createMemoryLogger, linesContaining } from './memory-log.js';
import { gatewayTopics } from './protocol.js';
import { GATEWAY, PASSWORD, TENANT, USERNAME } from './fixtures.js';

export class SkipScenario extends Error {}

/** A broker ACL like the platform's: a gateway credential may only use its own topic prefix. */
export function prefixAcl(tenant, gateway) {
  const prefix = `tenants/${tenant}/sources/gateway/${gateway}/`;
  return {
    subscribe: (_ctx, filter) => filter.startsWith(prefix),
    publish: (_ctx, topic) => topic.startsWith(prefix),
  };
}

/** A complete FileConfig for the conformance identity. */
export function fileConfig(clock, overrides = {}) {
  return {
    schema: 1,
    broker: 'mqtt://broker.conformance.invalid:1883',
    tenant: TENANT,
    gateway: GATEWAY,
    username: USERNAME,
    password: PASSWORD,
    api: null,
    tls: { caFile: null, rejectUnauthorized: true },
    drivers: [],
    driverDir: null,
    configCap: null,
    minIntervalMs: 1000,
    backfill: { maxBytes: 64 * 1024 * 1024, maxAgeHours: 168, batchIntervalMs: 1000 },
    host: { diskPath: '/' },
    bridge: { rejectUnauthorized: true },
    log: { level: 'debug', format: 'json' },
    createdAt: new Date(clock.now()).toISOString(),
    ...overrides,
  };
}

let coreModule = null;
async function loadCore() {
  if (!coreModule) coreModule = import('../core/gateway.js');
  return coreModule;
}

/** Run the virtual clock until `promise` settles (or `maxMs` of virtual time passes). */
export async function drive(clock, promise, maxMs = 120_000, stepMs = 50) {
  let done = false;
  let value;
  let error;
  Promise.resolve(promise).then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  await settle();
  // Real I/O (module loading on first start, file writes) completes in real time, not virtual
  // time. Give it a few real milliseconds first, so it never races the virtual clock.
  for (let i = 0; i < 10 && !done; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  let elapsed = 0;
  while (!done && elapsed < maxMs) {
    await clock.advance(stepMs);
    elapsed += stepMs;
  }
  if (!done) throw new Error(`still pending after ${maxMs} ms of virtual time`);
  if (error) throw error;
  return value;
}

/**
 * @param {{id: string}} scenario
 */
export function createHarness(scenario) {
  const assertions = [];
  const cleanups = [];

  const h = {
    id: scenario.id,
    assertions,

    /**
     * Record one assertion. `message` describes what was expected; on failure put the
     * offending message or value in it — it is what the report prints.
     */
    check(id, ok, message) {
      const text = typeof message === 'function' ? message() : message == null ? '' : String(message);
      assertions.push({ id: id.startsWith(`${scenario.id}.`) ? id : `${scenario.id}.${id}`, ok: !!ok, message: text });
      return !!ok;
    },

    skip(reason) { throw new SkipScenario(reason); },

    onCleanup(fn) { cleanups.push(fn); },

    /**
     * Stand up a world around a real gateway. The gateway is created but not started.
     * @param {{
     *   plan?: string|Object, latencyMs?: number, jitterMs?: number, seed?: number,
     *   readLatencyMs?: number, readJitterMs?: number,
     *   cloudConfig?: string|Object, macros?: Object[]|null, jobConfig?: Object|null,
     *   fileConfig?: Object, drivers?: 'scripted'|'builtin'|Object[],
     *   acl?: Object|null, clock?: ReturnType<typeof createVirtualClock>, home?: string,
     *   finalChecks?: boolean,
     * }} [opts]
     */
    async env(opts = {}) {
      const clock = opts.clock || createVirtualClock();
      const broker = createMemoryBroker({
        clock,
        latencyMs: opts.latencyMs ?? 5,
        jitterMs: opts.jitterMs ?? 0,
        seed: opts.seed ?? 1,
        users: { [USERNAME]: PASSWORD },
        acl: opts.acl === undefined ? prefixAcl(TENANT, GATEWAY) : opts.acl,
      });
      const cloud = createScriptedCloud({ broker, clock, plan: opts.plan ?? 'free' });
      const g = cloud.register({
        tenant: TENANT, gateway: GATEWAY,
        config: opts.cloudConfig ?? EMPTY_CONFIG,
        macros: opts.macros === undefined ? [] : opts.macros,
        jobConfig: opts.jobConfig ?? null,
      });
      const controls = createDriverControls({ readLatencyMs: opts.readLatencyMs ?? 20, readJitterMs: opts.readJitterMs ?? 0 });
      const log = createMemoryLogger({ clock });
      const ownHome = !opts.home;
      const home = opts.home || mkdtempSync(join(tmpdir(), 'synacl-conformance-'));
      const config = fileConfig(clock, opts.fileConfig);
      const drivers = opts.drivers === 'builtin' ? undefined
        : Array.isArray(opts.drivers) ? opts.drivers : createScriptedDrivers(controls);
      const topics = gatewayTopics({ tenant: TENANT, gateway: GATEWAY });

      let gw = null;
      let transport = null;
      let started = false;
      let stale = false;   // the current instance was stopped: the next start() is a new process

      const env = {
        clock, broker, cloud, g, controls, log, home, config, topics,
        tenant: TENANT, gatewayId: GATEWAY,
        get gw() { return gw; },
        get transport() { return transport; },
        get started() { return started; },

        /** Create a fresh gateway process (new transport, same home) without starting it. */
        async create() {
          const { createGateway } = await loadCore();
          transport = broker.createTransport();
          gw = createGateway({ config: env.config, home, transport, clock, drivers, log, random: () => 0.5 });
          stale = false;
          return gw;
        },
        /** Create (a new process after a stop) and start; resolves at boot, before the connection is up. */
        async start() {
          if (!gw || stale) await env.create();
          await drive(clock, gw.start());
          started = true;
          return gw;
        },
        async stop() {
          if (gw && started) {
            started = false;
            stale = true;
            await drive(clock, gw.stop(), 60_000);
          }
        },
        advance: (ms) => clock.advance(ms),
        until: (pred, maxMs, stepMs = 50) => clock.runUntil(pred, maxMs, stepMs),
        drive: (p, maxMs) => drive(clock, p, maxMs),
        now: () => clock.now(),

        // ── convenience queries over what the cloud received ──
        up: (id, deviceId) => cloud.up(id, deviceId),
        live: (id, deviceId) => cloud.up(id, deviceId).filter((u) => !u.lwt),
        data: (deviceId) => cloud.up('gateway.device-data', deviceId),
        configRequests: () => cloud.up('gateway.config-request'),
        synced: () => cloud.configCurrent(TENANT, GATEWAY) === true,
        /** Wait until the platform reports the gateway on its latest config. */
        async waitSynced(maxMs = 60_000) { return clock.runUntil(() => cloud.configCurrent(TENANT, GATEWAY) === true && !cloud.busy(TENANT, GATEWAY), maxMs, 50); },
        /** Run until the gateway is connected and has sent its first config request. */
        async waitOnline(maxMs = 30_000) { return clock.runUntil(() => env.live('gateway.config-request').length > 0, maxMs, 50); },
      };

      cleanups.push(async () => {
        const wasStarted = started;
        try { await env.stop(); } catch (err) { h.check('teardown', false, `gateway stop() failed: ${err && err.message}`); }
        if (wasStarted || gw) {
          if (opts.finalChecks !== false) {
            const bad = cloud.problems;
            h.check('uplinks-valid', bad.length === 0, bad.length
              ? `${bad.length} uplink problem(s); first: [${bad[0].kind}] ${bad[0].topic}: ${bad[0].message}${bad[0].payload ? ` — payload ${bad[0].payload}` : ''}`
              : 'every uplink used a topics.json topic, the right retain flag and passed strict schema validation');
          }
          const leaks = linesContaining(log, [PASSWORD]);
          h.check('no-secret-in-logs', leaks.length === 0, leaks.length ? `broker password appeared in a log line: ${leaks[0].msg.slice(0, 200)}` : 'the broker password never appeared in a log line');
          const errs = [...clock.errors, ...broker.listenerErrors];
          h.check('no-crash', errs.length === 0, errs.length ? `a timer or event handler threw: ${errs[0] && (errs[0].stack || errs[0].message)}` : 'no timer callback or event listener threw');
        }
        cloud.detach();
        if (ownHome) rmSync(home, { recursive: true, force: true });
      });
      return env;
    },

    async _cleanup() {
      for (const fn of cleanups.reverse()) {
        try { await fn(); } catch (err) { h.check('cleanup', false, String(err && err.message)); }
      }
      cleanups.length = 0;
    },
  };
  return h;
}

/** Numbers helpers for scenarios. */
export const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);
export const minOf = (arr) => (arr.length ? Math.min(...arr) : Infinity);
export const maxOf = (arr) => (arr.length ? Math.max(...arr) : -Infinity);
export const short = (v, n = 240) => {
  const s = typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};
