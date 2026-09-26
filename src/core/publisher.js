// Publisher: the single door every uplink goes through.
//
// It enforces the rules the platform punishes silently:
//   - only finite numbers, booleans and strings reach a `values` map (a null or NaN makes the
//     platform drop the whole message);
//   - nothing is handed to the transport while disconnected (a client that queues would
//     replay the outage as one burst, which the platform counts as rate violations);
//   - a device's live data never lands back-to-back with its previous message: if the previous
//     one has not been written yet, or was written less than half an interval ago, the reading
//     goes to the store-and-forward buffer instead, which replays it with its real timestamp
//     on a topic that has no interval gate.

import { readFileSync } from 'node:fs';

/** @typedef {import('./types.js').Transport} Transport */
/** @typedef {import('./types.js').Clock} Clock */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').Reading} Reading */

// topics.json is the source of truth for each uplink's schema, QoS and retain flag.
const TOPIC_TABLE = (() => {
  const doc = JSON.parse(readFileSync(new URL('../../protocol/v1/topics.json', import.meta.url), 'utf8'));
  const byId = new Map();
  for (const t of doc.topics) if (t.direction === 'up' && t.scope === 'gateway') byId.set(t.id, t);
  return byId;
})();

/** @param {string} name */
function topicRow(name) {
  if (TOPIC_TABLE.has(name)) return TOPIC_TABLE.get(name);
  if (TOPIC_TABLE.has(`gateway.${name}`)) return TOPIC_TABLE.get(`gateway.${name}`);
  for (const row of TOPIC_TABLE.values()) if (row.suffix === name) return row;
  return null;
}

/**
 * Keep what the data schema allows: finite numbers, booleans, strings. Everything else
 * (NaN, ±Infinity, null, undefined, objects, arrays) is dropped key by key.
 * @param {Object} values
 * @returns {Object<string, number|boolean|string>}
 */
export function cleanValues(values) {
  const out = {};
  if (!values || typeof values !== 'object') return out;
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'number') { if (Number.isFinite(v)) out[k] = v; }
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function intTs(ts, clock) {
  const n = typeof ts === 'number' && Number.isFinite(ts) ? Math.floor(ts) : clock.now();
  return n < 0 ? 0 : n;
}

function truncate(s, max) {
  const str = String(s);
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/**
 * @param {Object} deps
 * @param {Transport} deps.transport
 * @param {{up(name: string, deviceId?: string): string}} deps.topics
 * @param {{validate(schema: string, value: unknown): {ok: boolean, errors: string[]}}} [deps.validators]
 * @param {{append(record: Object): void}} [deps.backfill]
 * @param {Clock} deps.clock
 * @param {Logger} deps.log
 * @param {boolean} [deps.strict]  Throw on an invalid uplink (tests, conformance) instead of logging it.
 */
export function createPublisher({ transport, topics, validators, backfill, clock, log, strict = false }) {
  const netLog = log.child ? log.child('network') : log;
  /** Per-device live-publish bookkeeping for the backlog rule. */
  const wire = new Map(); // deviceId → {pending: boolean, pendingSince: number, lastWireAt: number}
  const counters = { live: 0, backfill: 0, dropped: 0, invalid: 0, failed: 0 };

  function check(schema, body) {
    if (!validators) return;
    const res = validators.validate(schema, body);
    if (res.ok) return;
    counters.invalid++;
    const msg = `outbound ${schema} message fails the protocol schema: ${res.errors.join('; ')}`;
    if (strict) throw new Error(msg);
    log.warn(msg);
  }

  async function send(topic, body, qos, retain) {
    if (!transport.connected) return false;
    try {
      await transport.publish(topic, JSON.stringify(body), { qos, retain });
      return true;
    } catch (err) {
      counters.failed++;
      netLog.debug('publish failed', { topic, err });
      return false;
    }
  }

  function isBacklogged(deviceId, intervalMs, now) {
    const w = wire.get(deviceId);
    if (!w) return false;
    // The wall clock was set back: past timestamps say nothing about the gap any more, and
    // without this every reading would be deferred until the clock caught up again.
    if (now < w.lastWireAt) w.lastWireAt = 0;
    if (now < w.pendingSince) w.pendingSince = now;
    // A write callback that never comes (a wedged socket) must not park the device in
    // backfill forever: after this long the pending flag no longer counts.
    const stale = Math.max(2 * intervalMs, 30000);
    if (w.pending && now - w.pendingSince < stale) return true;
    return w.lastWireAt > 0 && now - w.lastWireAt < intervalMs / 2;
  }

  function toBackfill(record) {
    if (!backfill) { counters.dropped++; return 'dropped'; }
    if (validators && strict) check('data-backfill', { batch: [record] });
    try {
      backfill.append(record);
    } catch (err) {
      counters.dropped++;
      log.warn('could not buffer a reading', { deviceId: record.deviceId, err });
      return 'dropped';
    }
    counters.backfill++;
    return 'backfill';
  }

  return {
    /**
     * @param {Reading} reading
     * @param {{intervalMs?: number, bypassBacklog?: boolean}} [opts]  bypassBacklog is for a
     *   read-once reply: the platform exempts it from the interval check, and it must not
     *   count as the device's previous message either.
     * @returns {Promise<'live'|'backfill'|'dropped'>}
     */
    async data(reading, { intervalMs = 0, bypassBacklog = false } = {}) {
      const values = cleanValues(reading.values);
      if (Object.keys(values).length === 0) { counters.dropped++; return 'dropped'; }
      const ts = intTs(reading.ts, clock);
      const body = { ts, values };
      if (Number.isInteger(reading.seq) && reading.seq >= 0) body.seq = reading.seq;
      const record = { deviceId: reading.deviceId, ...body };

      const now = clock.now();
      if (!transport.connected) return toBackfill(record);
      if (!bypassBacklog && isBacklogged(reading.deviceId, intervalMs, now)) {
        netLog.info('publish backlog: reading deferred to backfill, not sent live', { deviceId: reading.deviceId });
        return toBackfill(record);
      }

      check('data', body);
      const topic = topics.up('gateway.device-data', reading.deviceId);
      let w = wire.get(reading.deviceId);
      if (!bypassBacklog) {
        if (!w) { w = { pending: false, pendingSince: 0, lastWireAt: 0 }; wire.set(reading.deviceId, w); }
        w.pending = true;
        w.pendingSince = now;
      }
      const ok = await send(topic, body, 0, false);
      if (!bypassBacklog) {
        w.pending = false;
        if (ok) w.lastWireAt = clock.now();
      }
      if (ok) { counters.live++; return 'live'; }
      // The connection dropped between the check and the write: keep the reading.
      return toBackfill(record);
    },

    /** @returns {Promise<boolean>} */
    async deviceStatus(deviceId, { reachable, reason } = {}) {
      const body = { ts: clock.now(), reachable: !!reachable };
      if (!reachable && reason) body.reason = truncate(reason, 128);
      check('device-status', body);
      return send(topics.up('gateway.device-status', deviceId), body, 0, true);
    },

    /** @returns {Promise<boolean>} */
    async alert(deviceId, alert) {
      const body = { ...alert, ts: intTs(alert.ts, clock) };
      if (typeof body.code === 'string') body.code = truncate(body.code, 64);
      if (typeof body.message === 'string') body.message = truncate(body.message, 512);
      check('alert', body);
      return send(topics.up('gateway.device-alert', deviceId), body, 0, false);
    },

    /**
     * Command acknowledgement. `value` is coerced to what cmd-ack allows (a finite number or
     * null); a boolean becomes 1/0, anything else is left out.
     * @returns {Promise<boolean>}
     */
    async ack(deviceId, ack) {
      const ok = ack.status === 'ok';
      const body = { correlationId: String(ack.correlationId), status: ok ? 'ok' : 'error', error: ok ? null : truncate(ack.error || 'failed', 512) };
      if ('value' in ack) {
        const v = ack.value;
        if (typeof v === 'number' && Number.isFinite(v)) body.value = v;
        else if (typeof v === 'boolean') body.value = v ? 1 : 0;
        else if (v === null || (typeof v === 'number')) body.value = null;
      }
      body.ts = intTs(ack.ts, clock);
      check('cmd-ack', body);
      return send(topics.up('gateway.device-cmd-ack', deviceId), body, 0, false);
    },

    /**
     * Any gateway-scoped uplink by topics.json id (`gateway.status`, `status`, or the suffix).
     * QoS and retain default to the topic table.
     * @returns {Promise<boolean>}
     */
    async gateway(name, body, opts = {}) {
      const row = topicRow(name);
      if (!row) throw new Error(`unknown uplink topic "${name}"`);
      check(row.schema, body);
      return send(topics.up(row.id), body, opts.qos ?? row.qos, opts.retain ?? row.retain);
    },

    /** Drop backlog bookkeeping for a device that left the configuration. */
    forget(deviceId) { wire.delete(deviceId); },

    now: () => clock.now(),

    stats: () => ({ ...counters }),
  };
}
