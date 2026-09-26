// `mqtt-bridge` driver — maps topics on a broker you already run (Tasmota, zigbee2mqtt, Home
// Assistant, …) onto Synacl devices.
//
// conn: {brokerUrl, username?, password?, clientId?, sampleIntervalMs, staleMs?}
// tag:  {name, topic (filter, + and # allowed), jsonPath (dot path; empty = whole payload)}
//
// Push-style: messages arrive whenever the source publishes; the latest value per tag is kept,
// and each scheduled read publishes the tags that changed since the previous read (nothing new
// → no values → no data message). Reachability is reported through status():
//   bridge/disconnected  the local broker has been unreachable for more than 10 s
//   bridge/no_message    nothing arrived for conn.staleMs (0 = never), default
//                        max(3 × interval, 300 s) — 300 s is Tasmota's default telemetry period,
//                        so a plug on factory settings never flaps.
// Writes (cmdTopic) are reserved for a later release; write() refuses them.

import mqttDefault from 'mqtt';
import { defineDriver, DriverError } from './api.js';
import { topicMatches, filterError } from './topic-match.js';
import { walkPath } from './json-path.js';

/** @typedef {import('../core/types.js').DriverContext} DriverContext */
/** @typedef {import('../core/types.js').DeviceSpec} DeviceSpec */
/** @typedef {import('../core/types.js').TagSpec} TagSpec */
/** @typedef {import('../core/types.js').ReadResult} ReadResult */

const MIN_STALE_MS = 300_000;
const MAX_STRING = 256;
const SCHEMES = new Set(['mqtt:', 'mqtts:', 'tcp:', 'tls:', 'ssl:', 'ws:', 'wss:']);
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Turn a payload value into something the platform can store and the rule engine can compare.
 * Rules evaluate numbers only, and switches on the reference firmware report 1/0, so booleans
 * and ON/OFF/true/false become 1/0 and numeric strings become numbers. Other strings pass
 * through (≤256 chars); objects, arrays, null and non-finite numbers yield undefined (skip).
 * @param {unknown} v
 * @returns {number|string|undefined}
 */
export function normalizeValue(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s === '') return undefined;
  const lower = s.toLowerCase();
  if (lower === 'on' || lower === 'true') return 1;
  if (lower === 'off' || lower === 'false') return 0;
  if (NUMERIC.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  if (s.length <= MAX_STRING) return s;
  let cut = s.slice(0, MAX_STRING);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never leave half a surrogate pair
  return cut;
}

/**
 * Pick a tag's value out of one message.
 * @param {string} text  The payload as UTF-8 text.
 * @param {{ok: boolean, value?: unknown}} parsed  JSON.parse result of `text`.
 * @param {string} jsonPath
 * @returns {{value: number|string} | {skip: 'object-without-path'|'not-json'|'path-missing'|'unusable'}}
 */
export function extractValue(text, parsed, jsonPath) {
  let candidate;
  if (!jsonPath) {
    if (!parsed.ok) candidate = text; // plain text such as Tasmota's "ON"
    else if (parsed.value !== null && typeof parsed.value === 'object') return { skip: 'object-without-path' };
    else candidate = parsed.value;
  } else {
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') return { skip: 'not-json' };
    candidate = walkPath(parsed.value, jsonPath);
    if (candidate === undefined) return { skip: 'path-missing' };
  }
  const value = normalizeValue(candidate);
  return value === undefined ? { skip: 'unusable' } : { value };
}

const toNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined);

/**
 * Build the mqtt-bridge driver. `mqtt` is injectable for tests; the timing knobs exist so tests
 * need not wait for real reconnect backoff.
 * @param {{mqtt?: {connect: Function}, disconnectGraceMs?: number, reconnectMinMs?: number, reconnectMaxMs?: number}} [deps]
 */
export function createMqttBridgeDriver({ mqtt = mqttDefault, disconnectGraceMs = 10_000, reconnectMinMs = 1_000, reconnectMaxMs = 30_000 } = {}) {
  return defineDriver({
    apiVersion: 1,
    name: 'mqtt-bridge',
    protocols: ['mqtt-bridge'],
    capabilities: {},
    /** @param {DriverContext} ctx */
    create(ctx) {
      const { log, clock } = ctx;
      /** @type {Map<string, ReturnType<typeof createPool>>} */
      const pools = new Map();
      const warned = new Set();
      const warnOnce = (key, msg) => {
        if (warned.has(key)) return;
        warned.add(key);
        log.warn(msg);
      };

      // One connection per distinct (broker, credentials, client id), shared by every device
      // that points at it: a Tasmota fleet on one broker costs one local connection, not one per
      // plug, and duplicate client ids would make the broker kick them off each other.
      function createPool(url, safeUrl, opts) {
        const pool = {
          safeUrl,
          refs: 0,
          connected: false,
          downSince: clock.now(),
          ended: false,
          everConnected: false,
          /** @type {Map<string, Set<object>>} filter → bindings */
          filters: new Map(),
          reconnectTimer: null,
          backoff: reconnectMinMs,
          lastError: '',
          client: null,
        };

        const subscribe = (filter) => {
          pool.client.subscribe(filter, { qos: 0 }, (err, granted) => {
            if (err) {
              // A subscribe cut short by a disconnect is redone on the next connect; not news.
              if (!pool.ended && pool.connected) log.warn(`mqtt-bridge: subscribing to "${filter}" on ${safeUrl} failed: ${err.message}`);
              return;
            }
            if (granted?.[0]?.qos === 128) {
              warnOnce(`refused:${safeUrl}:${filter}`, `mqtt-bridge: ${safeUrl} refused the subscription to "${filter}" (check the broker's ACL for this user)`);
            }
          });
        };

        const scheduleReconnect = () => {
          if (pool.ended || pool.reconnectTimer) return;
          const wait = pool.backoff;
          pool.backoff = Math.min(pool.backoff * 2, reconnectMaxMs);
          pool.reconnectTimer = clock.setTimeout(() => {
            pool.reconnectTimer = null;
            if (!pool.ended) pool.client.reconnect();
          }, wait);
        };

        const route = (topic, payload) => {
          let text;
          let parsed;
          for (const [filter, bindings] of pool.filters) {
            if (!topicMatches(filter, topic)) continue;
            if (text === undefined) {
              text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
              try {
                parsed = { ok: true, value: JSON.parse(text) };
              } catch {
                parsed = { ok: false };
              }
            }
            for (const b of bindings) deliver(b, topic, text, parsed);
          }
        };

        // Reconnection is ours, not mqtt.js's (reconnectPeriod 0): its timer would bypass the
        // injected clock, and the backoff here keeps a dead local broker from being hammered.
        pool.client = mqtt.connect(url, { ...opts, reconnectPeriod: 0, resubscribe: false, clean: true, protocolVersion: 4, queueQoSZero: false });
        pool.client.on('connect', () => {
          pool.connected = true;
          pool.downSince = null;
          pool.backoff = reconnectMinMs;
          pool.lastError = '';
          log.info(`mqtt-bridge: ${pool.everConnected ? 'reconnected' : 'connected'} to ${safeUrl}`);
          pool.everConnected = true;
          // Clean session: subscriptions do not survive a reconnect, so make them every time.
          for (const filter of pool.filters.keys()) subscribe(filter);
        });
        pool.client.on('close', () => {
          if (pool.connected && !pool.ended) log.warn(`mqtt-bridge: lost the connection to ${safeUrl}; reconnecting`);
          pool.connected = false;
          pool.downSince ??= clock.now();
          scheduleReconnect();
        });
        pool.client.on('error', (err) => {
          // Logged once per distinct message so a broker that stays down doesn't flood the log.
          const msg = err?.message ?? String(err);
          if (msg !== pool.lastError && !pool.ended) log.warn(`mqtt-bridge: ${safeUrl}: ${msg}`);
          pool.lastError = msg;
        });
        pool.client.on('message', route);

        pool.addBinding = (b) => {
          let set = pool.filters.get(b.filter);
          if (!set) {
            set = new Set();
            pool.filters.set(b.filter, set);
            if (pool.connected) subscribe(b.filter);
          }
          set.add(b);
        };
        pool.removeBinding = (b) => {
          const set = pool.filters.get(b.filter);
          if (!set) return;
          set.delete(b);
          if (set.size === 0) {
            pool.filters.delete(b.filter);
            if (pool.connected && !pool.ended) pool.client.unsubscribe(b.filter, () => {});
          }
        };
        pool.end = () => {
          if (pool.ended) return;
          pool.ended = true;
          if (pool.reconnectTimer) clock.clearTimeout(pool.reconnectTimer);
          pool.reconnectTimer = null;
          pool.client.end(true);
        };
        return pool;
      }

      function deliver(b, topic, text, parsed) {
        const h = b.handle;
        if (h.closed) return;
        const now = clock.now();
        h.lastMessageAt = now; // any message on the device's topics proves the source is alive
        const r = extractValue(text, parsed, b.tag.jsonPath);
        if ('value' in r) {
          h.latest.set(b.tag.name, { value: r.value, at: now });
          h.fresh.add(b.tag.name);
          return;
        }
        const where = `tag "${b.tag.name}" (device ${h.id}, topic ${topic})`;
        const hints = {
          'object-without-path': `${where}: the payload is a JSON object — set a JSON path to pick a field; skipping it`,
          'not-json': `${where}: a JSON path is set but the payload is not a JSON object; skipping it`,
          'path-missing': `${where}: JSON path "${b.tag.jsonPath}" is not in the payload; skipping it`,
          unusable: `${where}: the value is not a number, boolean or string (object, array or null); skipping it`,
        };
        warnOnce(`${h.id}:${b.tag.name}:${r.skip}`, `mqtt-bridge: ${hints[r.skip]}`);
      }

      /**
       * @param {{closed: boolean, pool: any, staleMs: number, lastMessageAt: number|null, openedAt: number}} h
       * @returns {{reachable: boolean, reason?: string}}
       */
      function statusOf(h) {
        if (h.closed) return { reachable: false, reason: 'bridge/disconnected' };
        const now = clock.now();
        const p = h.pool;
        if (!p.connected && p.downSince !== null && now - p.downSince > disconnectGraceMs) {
          return { reachable: false, reason: 'bridge/disconnected' };
        }
        if (h.staleMs > 0 && now - (h.lastMessageAt ?? h.openedAt) > h.staleMs) {
          return { reachable: false, reason: 'bridge/no_message' };
        }
        return { reachable: true };
      }

      ctx.signal?.addEventListener?.('abort', () => {
        for (const p of pools.values()) p.end();
        pools.clear();
      }, { once: true });

      return {
        /** @param {DeviceSpec} device */
        async open(device) {
          const conn = device.conn ?? {};
          const brokerUrl = typeof conn.brokerUrl === 'string' ? conn.brokerUrl.trim() : '';
          const bad = (why) => new DriverError(`mqtt-bridge device ${device.id}: ${why}`, { reason: `mqtt-bridge: ${why}`.slice(0, 128), code: 'bad-config' });
          if (!brokerUrl) throw bad('conn.brokerUrl is missing');
          let url;
          try {
            url = new URL(brokerUrl);
          } catch {
            throw bad('conn.brokerUrl is not a valid URL');
          }
          if (!SCHEMES.has(url.protocol)) throw bad(`conn.brokerUrl scheme ${url.protocol} is not supported (use mqtt:, mqtts:, ws: or wss:)`);

          // Credentials can come from conn or from the URL's userinfo; both are secrets.
          const username = typeof conn.username === 'string' && conn.username !== '' ? conn.username : undefined;
          const password = typeof conn.password === 'string' && conn.password !== '' ? conn.password : undefined;
          if (password) log.redact(password);
          if (url.password) {
            log.redact(url.password);
            log.redact(decodeURIComponent(url.password));
          }
          const safeUrl = `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
          const explicitId = typeof conn.clientId === 'string' && conn.clientId.trim() !== '' ? conn.clientId.trim() : null;

          const key = JSON.stringify([brokerUrl, username ?? null, password ?? null, explicitId]);
          let pool = pools.get(key);
          if (!pool) {
            const clientId = explicitId ?? `synacl-${ctx.gatewayId}-${String(device.id).slice(-6)}`;
            pool = createPool(brokerUrl, safeUrl, {
              clientId,
              username,
              password,
              keepalive: 30,
              connectTimeout: 10_000,
              // Local TLS is verified unless the operator opted out for this gateway.
              rejectUnauthorized: ctx.options?.rejectUnauthorized !== false,
            });
            pools.set(key, pool);
            log.info(`mqtt-bridge: connecting to ${safeUrl} as ${clientId}`);
          }
          pool.refs++;

          const stale = toNumber(conn.staleMs);
          const interval = device.intervalMs ?? toNumber(conn.sampleIntervalMs) ?? 10_000;
          const handle = {
            id: device.id,
            pool,
            poolKey: key,
            staleMs: Number.isFinite(stale) && stale >= 0 ? stale : Math.max(3 * interval, MIN_STALE_MS),
            openedAt: clock.now(),
            lastMessageAt: null,
            latest: new Map(),
            fresh: new Set(),
            problems: new Map(), // tag name → why it can never produce a value
            bindings: [],
            closed: false,
          };
          for (const tag of device.tags ?? []) {
            const filter = typeof tag.topic === 'string' ? tag.topic : '';
            const why = filterError(filter);
            if (why) {
              handle.problems.set(tag.name, why);
              warnOnce(`${device.id}:${tag.name}:filter`, `mqtt-bridge: tag "${tag.name}" (device ${device.id}) is not subscribed: ${why}`);
              continue;
            }
            const b = { handle, tag, filter };
            handle.bindings.push(b);
            pool.addBinding(b);
          }
          return handle;
        },

        /**
         * @param {any} handle
         * @param {TagSpec[]} tags
         * @param {{reason: 'interval'|'once'}} opts
         * @returns {Promise<ReadResult>}
         */
        async read(handle, tags, { reason } = { reason: 'interval' }) {
          const values = {};
          const errors = {};
          for (const tag of tags) {
            const latest = handle.latest.get(tag.name);
            if (reason === 'once') {
              // An on-demand read answers from the cache: the source publishes on its own schedule.
              if (latest) values[tag.name] = latest.value;
              else errors[tag.name] = handle.problems.get(tag.name) ?? `no message received yet on ${tag.topic || '(no topic)'}`;
            } else if (handle.fresh.has(tag.name) && latest) {
              values[tag.name] = latest.value;
              handle.fresh.delete(tag.name);
            } else if (handle.problems.has(tag.name)) {
              errors[tag.name] = handle.problems.get(tag.name);
            }
          }
          const st = statusOf(handle);
          /** @type {ReadResult} */
          const res = { values, reachable: st.reachable };
          if (st.reason) res.reason = st.reason;
          if (Object.keys(errors).length) res.errors = errors;
          return res;
        },

        status(handle) {
          return statusOf(handle);
        },

        // cmdTopic is reserved; until writes exist, answer in the same words the gateway uses
        // for any protocol that cannot be written.
        async write(handle, op) {
          return { ok: false, error: `${op?.kind === 'modbus' ? 'modbus' : 'actuator'} writes are not supported for protocol "mqtt-bridge"` };
        },

        async close(handle) {
          if (!handle || handle.closed) return;
          handle.closed = true;
          const { pool } = handle;
          for (const b of handle.bindings) pool.removeBinding(b);
          handle.bindings = [];
          pool.refs--;
          if (pool.refs <= 0) {
            pool.end();
            if (pools.get(handle.poolKey) === pool) pools.delete(handle.poolKey);
          }
        },
      };
    },
  });
}

/** The built-in mqtt-bridge driver. */
export const mqttBridgeDriver = createMqttBridgeDriver();
export default mqttBridgeDriver;
