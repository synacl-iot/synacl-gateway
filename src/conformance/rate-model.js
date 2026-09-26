// A model of the platform's ingest rate gate, re-implemented from its documented behaviour.
//
// What a gateway is judged on, per live data message, in this order:
//   1. a suspended device's messages are dropped outright;
//   2. the account's messages-per-second window (all devices together; a drop, never a violation);
//   3. the per-device minimum interval — skipped entirely while a read-once is armed for the device;
//   4. an optional hourly cap.
// The interval check measures ARRIVAL gaps, with one tolerance: when the message's own `ts`
// is plausible (not more than 5 s ahead of server time, not more than 120 s behind it), a
// message that arrives too soon is still accepted if its `ts` is at least one interval after
// the `ts` of the previous accepted message (a network burst of correctly spaced readings).
// A reading whose `ts` is a full interval OLDER than the previous accepted one is late: dropped
// but never counted. Anything else that fails is a violation; enough violations suspend the device.
// Replayed (backfill) records never touch any of this — they have their own per-account,
// per-minute record ceiling.

/** @typedef {import('../core/types.js').Clock} Clock */

/** Plan profiles: the account's minimum publish interval and messages-per-second ceiling. */
export const PLAN_PROFILES = Object.freeze({
  free: Object.freeze({ name: 'free', minIntervalMs: 5000, maxMsgsPerSec: 5, maxMsgsPerHour: 0 }),
  s1: Object.freeze({ name: 's1', minIntervalMs: 1000, maxMsgsPerSec: 30, maxMsgsPerHour: 0 }),
  s2: Object.freeze({ name: 's2', minIntervalMs: 500, maxMsgsPerSec: 120, maxMsgsPerHour: 0 }),
});

export const DEVICE_TS_MAX_FUTURE_MS = 5_000;
export const DEVICE_TS_MAX_AGE_MS = 120_000;
export const VIOLATIONS_WARN_ONLY = 5;
export const VIOLATIONS_BEFORE_SUSPEND = 20;
export const SUSPENSION_MS = 3_600_000;           // first escalation step
export const BACKFILL_MAX_RECORDS_PER_MIN = 3000;
export const READ_ONCE_GATE_MS = 5_000;
export const READ_ONCE_PENDING_MS = 30_000;
// The account-wide counter starts with the first message it counts and lives for up to 2 s,
// so the model uses a window opened by the first message and closed 2 s later — stricter than
// a sliding 1 s window, never looser.
export const TENANT_WINDOW_MS = 2_000;

/**
 * @param {{clock: Clock, plan?: {minIntervalMs: number, maxMsgsPerSec: number, maxMsgsPerHour?: number}|string,
 *          tenantWindowMs?: number}} opts
 */
export function createRateModel({ clock, plan = 'free', tenantWindowMs = TENANT_WINDOW_MS }) {
  const limits = typeof plan === 'string' ? PLAN_PROFILES[plan] : plan;
  if (!limits) throw new Error(`unknown plan profile "${plan}"`);

  /** @type {Map<string, {arrivalGateUntil: number, lastTs: {ts: number, exp: number}|null, violations: number, suspendedUntil: number, hour: {bucket: number, n: number}, readOnceGateUntil: number, pending: {tag: string, exp: number}|null}>} */
  const devices = new Map();
  let tenantWin = { openedAt: -Infinity, n: 0 };
  let backfillWin = { minute: -1, n: 0 };
  const events = [];      // platform-side events this model raised: quota/rate-limited, quota/suspended, …
  const decisions = [];   // one per live message: {deviceId, ts, at, result, reason}

  const dev = (id) => {
    let d = devices.get(id);
    if (!d) {
      d = { arrivalGateUntil: -Infinity, lastTs: null, violations: 0, suspendedUntil: 0, hour: { bucket: -1, n: 0 }, readOnceGateUntil: -Infinity, pending: null };
      devices.set(id, d);
    }
    return d;
  };

  function trustedTs(ts, now) {
    if (!Number.isSafeInteger(ts) || ts <= 0) return null;
    if (ts > now + DEVICE_TS_MAX_FUTURE_MS) return null;
    if (ts < now - DEVICE_TS_MAX_AGE_MS) return null;
    return ts;
  }

  /** 1 accepted by arrival gap · 2 accepted by device-ts gap · 3 late · 0 too fast */
  function checkInterval(d, deviceTs, now) {
    const interval = limits.minIntervalMs;
    if (!interval) return 1;
    const ts = trustedTs(deviceTs, now);
    if (d.lastTs && d.lastTs.exp <= now) d.lastTs = null;
    if (now >= d.arrivalGateUntil) {
      d.arrivalGateUntil = now + interval;
      // An untrusted ts clears the reference, so alternating good and bad ts cannot double the rate.
      d.lastTs = ts == null ? null : { ts, exp: now + DEVICE_TS_MAX_AGE_MS + DEVICE_TS_MAX_FUTURE_MS };
      return 1;
    }
    if (ts != null && d.lastTs) {
      const prev = d.lastTs.ts;
      if (ts - prev >= interval) {
        d.lastTs = { ts, exp: now + DEVICE_TS_MAX_AGE_MS + DEVICE_TS_MAX_FUTURE_MS };
        return 2;
      }
      if (prev - ts >= interval) return 3;
    }
    return 0;
  }

  function violation(deviceId, d, reason, now) {
    d.violations++;
    const n = d.violations;
    if (n <= VIOLATIONS_BEFORE_SUSPEND) {
      events.push({ type: 'quota/rate-limited', deviceId, at: now, severity: n <= VIOLATIONS_WARN_ONLY ? 'warning' : 'error', reason, violCount: n });
    } else {
      d.suspendedUntil = now + SUSPENSION_MS;
      events.push({ type: 'quota/suspended', deviceId, at: now, reason });
    }
  }

  return {
    limits,
    events,
    decisions,

    /**
     * Gate one live data message as it ARRIVES (clock.now() is the arrival time).
     * @returns {{accepted: boolean, reason: string|null, path?: 'arrival'|'device-ts'|'exempt', ephemeral?: string|null}}
     */
    gateLive(deviceId, body) {
      const now = clock.now();
      const d = dev(deviceId);
      const record = (res) => { decisions.push({ deviceId, ts: body && body.ts, at: now, ...res }); return res; };
      if (d.suspendedUntil > now) return record({ accepted: false, reason: 'suspended' });

      const pending = d.pending && d.pending.exp > now ? d.pending.tag : null;
      if (!pending) d.pending = null;

      // Account window: counted for every message that gets this far, accepted or not.
      if (limits.maxMsgsPerSec) {
        if (now - tenantWin.openedAt >= tenantWindowMs) tenantWin = { openedAt: now, n: 0 };
        tenantWin.n++;
        if (tenantWin.n > limits.maxMsgsPerSec) {
          if (!events.some((e) => e.type === 'quota/tenant-rate-limited' && now - e.at < 60_000)) {
            events.push({ type: 'quota/tenant-rate-limited', at: now });
          }
          return record({ accepted: false, reason: 'tenant_rate' });
        }
      }

      let path = 'exempt';
      if (!pending) {
        const r = checkInterval(d, body && body.ts, now);
        if (r === 3) return record({ accepted: false, reason: 'late' });
        if (r === 0) {
          violation(deviceId, d, 'interval', now);
          return record({ accepted: false, reason: 'interval' });
        }
        path = r === 2 ? 'device-ts' : 'arrival';
      }

      if (limits.maxMsgsPerHour) {
        const bucket = Math.floor(now / 3_600_000);
        if (d.hour.bucket !== bucket) d.hour = { bucket, n: 0 };
        d.hour.n++;
        if (d.hour.n > limits.maxMsgsPerHour) {
          violation(deviceId, d, 'hourly_cap', now);
          return record({ accepted: false, reason: 'hourly_cap' });
        }
      }

      // The FIRST accepted message containing the armed tag consumes the marker — whichever
      // message that is. (A scheduled publish that lands first takes it.)
      let ephemeral = null;
      if (pending && body && body.values && Object.prototype.hasOwnProperty.call(body.values, pending)) {
        ephemeral = pending;
        d.pending = null;
      }
      return record({ accepted: true, reason: null, path, ephemeral });
    },

    /**
     * Arm a read-once as the platform does before sending `read/once`: refused when another
     * was armed for this device in the last 5 s; the marker lives 30 s.
     */
    armReadOnce(deviceId, tag) {
      const now = clock.now();
      const d = dev(deviceId);
      if (now < d.readOnceGateUntil) return false;
      d.readOnceGateUntil = now + READ_ONCE_GATE_MS;
      d.pending = { tag, exp: now + READ_ONCE_PENDING_MS };
      return true;
    },
    readOncePending(deviceId) {
      const d = devices.get(deviceId);
      return d && d.pending && d.pending.exp > clock.now() ? d.pending.tag : null;
    },

    /** Gate a replayed batch's records for one device (per-account records-per-minute ceiling). */
    gateBackfill(deviceId, count) {
      const now = clock.now();
      const d = dev(deviceId);
      if (d.suspendedUntil > now) return { accepted: false, reason: 'suspended' };
      const minute = Math.floor(now / 60_000);
      if (backfillWin.minute !== minute) backfillWin = { minute, n: 0 };
      backfillWin.n += count;
      if (backfillWin.n > BACKFILL_MAX_RECORDS_PER_MIN) {
        events.push({ type: 'quota/tenant-rate-limited', at: now, backfill: true });
        return { accepted: false, reason: 'backfill_rate' };
      }
      return { accepted: true, reason: null };
    },

    violations(deviceId) {
      if (deviceId) return devices.get(deviceId)?.violations || 0;
      let n = 0;
      for (const d of devices.values()) n += d.violations;
      return n;
    },
    suspended(deviceId) { return (devices.get(deviceId)?.suspendedUntil || 0) > clock.now(); },
    /** Drops by reason across all live decisions. */
    drops() {
      const out = {};
      for (const x of decisions) if (!x.accepted) out[x.reason] = (out[x.reason] || 0) + 1;
      return out;
    },
  };
}
