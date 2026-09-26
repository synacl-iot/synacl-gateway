// Scheduler: reads every device on its own interval and hands readings to the publisher.
//
// The platform measures the gap between a device's data messages and suspends a device that
// keeps publishing faster than its plan allows, without telling the gateway. So the pacing
// rules here are strict, and every timer runs on the injected Clock:
//   - one data message per device per interval, and a message's `ts` is never less than one
//     interval after the previous message's `ts` (a timer that fires early is re-armed for the
//     remainder);
//   - devices entering together start on staggered phases, grouped by interval, so a gateway
//     with many devices doesn't hit the account's per-second window all at once;
//   - never two reads of one device at the same time; a due tick that finds a read still
//     running is skipped;
//   - after 3 consecutive failures the retry delay doubles, up to max(interval, 60 s);
//   - a device with a read interval shorter than its publish interval (`readIntervalMs`) is
//     also sampled in between, for faster threshold alarms; only the publish read sends data.
//
// read/once follows the platform's read-once exemption: the platform marks the device when a
// user clicks "Read now", and the FIRST data message carrying that tag consumes the mark and
// skips the interval check. If a scheduled message consumed it instead, the reply would count
// as a violation. So while a read-once is pending the device's scheduled ticks are held; a
// scheduled read already in flight that contains the tag and goes out live IS the reply (it
// legitimately consumed the mark); otherwise the tag is read on its own and published at
// once, followed by the acknowledgement.

import { cleanValues } from './publisher.js';

/** @typedef {import('./types.js').Clock} Clock */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').DeviceSpec} DeviceSpec */
/** @typedef {import('./types.js').TagSpec} TagSpec */
/** @typedef {import('./types.js').DriverRegistry} DriverRegistry */
/** @typedef {import('./types.js').DriverInstance} DriverInstance */
/** @typedef {import('./types.js').ReadResult} ReadResult */
/** @typedef {import('./types.js').WriteOp} WriteOp */
/** @typedef {import('./types.js').WriteResult} WriteResult */

export const MAX_INTERVAL_MS = 3600000;
const STAGGER_CAP_MS = 10000;
const READ_TIMEOUT_CAP_MS = 10000;
const ONCE_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 10000;
const CLOSE_TIMEOUT_MS = 5000;
const BACKOFF_CAP_MS = 60000;
const BACKOFF_AFTER = 3;
/** A driver read that ignores its abort signal is abandoned this long after its timeout. */
const STALE_READ_MS = 60000;
const SEQ_SAVE_MS = 60000;
const SEQ_RELOAD_BUMP = 1000;
const ONCE_QUEUE_MAX = 4;
/** A read-once holds the device's schedule; however the transport behaves, it lets go after this. */
const ONCE_BUDGET_MS = 30000;
/** Node's timers overflow above this (a longer delay fires immediately). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export const NOT_IN_CONFIG = "device not in this gateway's configuration — resend config";

function errMessage(err) {
  const m = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
  return String(m || 'error').slice(0, 128);
}

/**
 * @param {Object} deps
 * @param {Clock} deps.clock
 * @param {Logger} deps.log
 * @param {Pick<DriverRegistry, 'forProtocol'>} deps.drivers
 * @param {ReturnType<typeof import('./publisher.js').createPublisher>} deps.publisher
 * @param {{evaluate: Function, resetDevice: Function}} [deps.thresholds]
 * @param {{readOverrides?: () => Object, writeOverrides?: (o: Object) => void, readSeq?: () => Object, writeSeq?: (s: Object) => void}} [deps.state]
 * @param {number} [deps.minIntervalMs]
 * @param {(deviceId: string, s: {reachable: boolean, reason?: string}) => void} [deps.onReachability]
 *   Called on every reachability change (wire it to presence.transition).
 * @param {{active: boolean, read(device: DeviceSpec, tags: TagSpec[]): ReadResult}} [deps.sim]
 */
export function createScheduler({ clock, log, drivers, publisher, thresholds, state, minIntervalMs = 1000, onReachability, sim }) {
  const sysLog = log.child ? log.child('system') : log;
  const cmdLog = log.child ? log.child('commands') : log;
  const readLog = log.child ? log.child('sensors') : log;
  const floorMs = Math.max(250, Number(minIntervalMs) || 0);

  /** @type {Map<string, Object>} */
  const entries = new Map();
  let stopped = false;
  let seqTimer = null;
  let seqDirty = false;
  /** @type {Object<string, number>} */
  const savedSeq = {};
  try {
    const s = state?.readSeq?.();
    for (const [id, n] of Object.entries(s?.devices || {})) if (Number.isInteger(n) && n >= 0) savedSeq[id] = n;
  } catch (err) {
    sysLog.warn('could not load message counters', { err });
  }

  const clampInterval = (ms) => Math.min(MAX_INTERVAL_MS, Math.max(floorMs, Math.round(Number(ms) || 0)));

  // ─── timers ──────────────────────────────────────────────────────────────────────────

  function raceTimeout(promise, ms) {
    return new Promise((resolve) => {
      const t = clock.setTimeout(() => resolve({ timedOut: true }), Math.min(ms, MAX_TIMER_MS));
      promise.then(
        (value) => { clock.clearTimeout(t); resolve({ value }); },
        (error) => { clock.clearTimeout(t); resolve({ error: error ?? new Error('failed') }); },
      );
    });
  }

  function arm(e, ms) {
    if (e.timer) clock.clearTimeout(e.timer);
    e.timer = null;
    if (e.closed || stopped || e.paused) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, Math.round(ms)));
    e.dueAt = clock.now() + delay;
    e.timer = clock.setTimeout(() => {
      e.timer = null;
      tick(e).catch((err) => {
        sysLog.error('scheduler tick failed', { deviceId: e.id, err });
        if (!e.timer) arm(e, e.intervalMs);
      });
    }, delay);
  }

  /** The sampling cadence: readIntervalMs when it is shorter than the publish interval, else 0 (off). */
  function sampleMs(e) {
    const r = Number(e.spec.readIntervalMs) || 0;
    if (r <= 0) return 0;
    const R = Math.max(250, Math.round(r));
    return R < e.intervalMs ? R : 0;
  }

  function armSample(e) {
    if (e.sampleTimer) clock.clearTimeout(e.sampleTimer);
    e.sampleTimer = null;
    if (e.closed || stopped || e.paused) return;
    const R = sampleMs(e);
    if (!R) return;
    e.sampleTimer = clock.setTimeout(() => {
      e.sampleTimer = null;
      sample(e).catch((err) => sysLog.error('sampling read failed', { deviceId: e.id, err }));
    }, R);
  }

  /** Arm the next regular tick unless one is already pending: never earlier than one interval after the last message. */
  function ensureArmed(e) {
    if (e.timer || e.closed || stopped || e.paused) return;
    const now = clock.now();
    const due = e.lastDataTs ? e.lastDataTs + e.intervalMs : now;
    arm(e, Math.max(0, due - now));
  }

  /** The interval changed: move a pending tick to the new due time. A device that has not
   *  published yet keeps its staggered first tick. */
  function rearm(e) {
    if (!e.timer || !e.lastDataTs) return;
    clock.clearTimeout(e.timer);
    e.timer = null;
    ensureArmed(e);
  }

  function armPause(e) {
    if (e.pauseTimer) clock.clearTimeout(e.pauseTimer);
    e.pauseTimer = null;
    if (!e.paused || e.paused.mode !== 'timed') return;
    const left = e.paused.until - clock.now();
    if (left <= 0) { endPause(e, 'timed pause ended'); return; }
    // A long pause is re-checked in steps rather than overflowing a single timer.
    e.pauseTimer = clock.setTimeout(() => { e.pauseTimer = null; armPause(e); }, Math.min(left, MAX_TIMER_MS));
  }

  // ─── overrides (persisted interval and pause state) ──────────────────────────────────

  function editOverrides(id, fn) {
    if (!state?.readOverrides || !state?.writeOverrides) return;
    try {
      const o = state.readOverrides() || {};
      const doc = { ...o, v: 1, devices: { ...(o.devices || {}) } };
      const cur = { ...(doc.devices[id] || {}) };
      fn(cur);
      if (Object.keys(cur).length) doc.devices[id] = cur;
      else delete doc.devices[id];
      state.writeOverrides(doc);
    } catch (err) {
      sysLog.warn('could not persist device override', { deviceId: id, err });
    }
  }

  function persistedPause(id) {
    try {
      const r = state?.readOverrides?.()?.devices?.[id]?.read;
      if (!r || r.enabled !== false) return null;
      if (r.mode === 'timed') {
        if (Number.isFinite(r.until) && r.until > clock.now()) return { mode: 'timed', until: r.until };
        editOverrides(id, (cur) => { delete cur.read; });
        return null;
      }
      return { mode: 'manual', until: null };
    } catch {
      return null;
    }
  }

  // ─── seq counters ────────────────────────────────────────────────────────────────────

  function persistSeq() {
    if (!seqDirty || !state?.writeSeq) return;
    const devices = { ...savedSeq };
    for (const e of entries.values()) devices[e.id] = e.seq;
    try {
      state.writeSeq({ v: 1, devices });
      seqDirty = false;
    } catch (err) {
      sysLog.warn('could not persist message counters', { err });
    }
  }

  function nextSeq(e) {
    const n = e.seq;
    e.seq = n + 1;
    seqDirty = true;
    return n;
  }

  // ─── reachability ────────────────────────────────────────────────────────────────────

  function setReach(e, reachable, reason) {
    const why = reachable ? null : (reason ? String(reason).slice(0, 128) : null);
    const prev = e.reachable;
    const changed = prev !== reachable || (!reachable && e.reason !== why);
    e.reachable = reachable;
    e.reason = why;
    if (!reachable && why) e.lastError = why;
    if (!changed || e.closed) return;
    if (prev === true && !reachable) {
      thresholds?.resetDevice?.(e.id);
      readLog.warn('device unreachable', { deviceId: e.id, reason: why });
    } else if (reachable && prev === false) {
      readLog.info('device reachable', { deviceId: e.id });
    }
    try {
      onReachability?.(e.id, reachable ? { reachable: true } : { reachable: false, ...(why ? { reason: why } : {}) });
    } catch (err) {
      sysLog.debug('reachability listener failed', { err });
    }
  }

  // ─── driver handles ──────────────────────────────────────────────────────────────────

  async function openEntry(e) {
    if (e.handle !== undefined) return;
    if (!e.opening) {
      e.opening = (async () => {
        const h = await e.driver.open(e.spec);
        if (e.closed) { await e.driver.close(h).catch(() => {}); return; }
        e.handle = h;
      })().finally(() => { e.opening = null; });
    }
    await e.opening;
    if (e.handle === undefined) throw new Error('device closed');
  }

  async function retire(e, { ackError = NOT_IN_CONFIG } = {}) {
    e.closed = true;
    if (e.timer) clock.clearTimeout(e.timer);
    if (e.pauseTimer) clock.clearTimeout(e.pauseTimer);
    if (e.sampleTimer) clock.clearTimeout(e.sampleTimer);
    e.timer = e.pauseTimer = e.sampleTimer = null;
    e.inFlight?.abort?.abort();
    for (const item of e.once.splice(0)) {
      if (ackError && item.correlationId) publisher.ack(e.id, { correlationId: item.correlationId, status: 'error', error: ackError }).catch(() => {});
      item.resolve();
    }
    if (e.handle !== undefined && e.driver) {
      const h = e.handle;
      e.handle = undefined;
      const r = await raceTimeout(Promise.resolve().then(() => e.driver.close(h)), CLOSE_TIMEOUT_MS);
      if (r.error) sysLog.debug('driver close failed', { deviceId: e.id, err: r.error });
      if (r.timedOut) sysLog.warn('driver close timed out', { deviceId: e.id });
    }
  }

  // ─── reads ───────────────────────────────────────────────────────────────────────────

  function unsupportedReason(e) {
    return `unsupported protocol: ${e.protocol}`;
  }

  /**
   * One read, bounded by `timeoutMs`. Sets e.inFlight for as long as the DRIVER is busy —
   * which can outlast the timeout — so no second read starts on top of it.
   * @returns {Promise<{values: Object, reachable: boolean, reason?: string, errors?: Object}>}
   */
  async function readWith(e, tags, reason, timeoutMs, flight) {
    e.inFlight = flight;
    if (sim?.active) {
      e.inFlight = null;
      try { return { ...sim.read(e.spec, tags), reachable: true }; } catch (err) { return { values: {}, reachable: false, reason: errMessage(err) }; }
    }
    if (!e.driver) {
      e.inFlight = null;
      return { values: {}, reachable: false, reason: unsupportedReason(e) };
    }
    if (tags.length === 0) {
      // Nothing to poll (only on-demand tags): reachability comes from the driver's own view.
      e.inFlight = null;
      try {
        await openEntry(e);
        const s = e.driver.status?.(e.handle);
        return s && typeof s.reachable === 'boolean' ? { values: {}, ...s } : { values: {}, reachable: true };
      } catch (err) {
        return { values: {}, reachable: false, reason: errMessage(err) };
      }
    }
    const ac = new AbortController();
    flight.abort = ac;
    flight.timeoutMs = timeoutMs;
    const work = (async () => {
      await openEntry(e);
      return e.driver.read(e.handle, tags, { reason, signal: ac.signal });
    })();
    flight.settled = work.then(() => {}, () => {}).then(() => { if (e.inFlight === flight) e.inFlight = null; });
    const r = await raceTimeout(work, timeoutMs);
    if (r.timedOut) {
      ac.abort();
      return { values: {}, reachable: false, reason: 'timeout' };
    }
    if (r.error) return { values: {}, reachable: false, reason: errMessage(r.error) };
    const res = r.value;
    if (!res || typeof res !== 'object') return { values: {}, reachable: false, reason: 'driver returned no result' };
    return { values: res.values && typeof res.values === 'object' ? res.values : {}, reachable: res.reachable !== false, reason: res.reason, errors: res.errors };
  }

  /** Keep only the requested tags, with values the data schema accepts. */
  function pick(values, tags) {
    const want = new Set(tags.map((t) => t.name));
    const out = {};
    for (const [k, v] of Object.entries(cleanValues(values))) if (want.has(k)) out[k] = v;
    return out;
  }

  function backoffDelay(e) {
    const I = e.intervalMs;
    if (e.failures < BACKOFF_AFTER) return I;
    return Math.min(I * 2 ** (e.failures - 2), Math.max(I, BACKOFF_CAP_MS));
  }

  function flightIsStale(f, now) {
    return f.startedAt + (f.timeoutMs || READ_TIMEOUT_CAP_MS) + STALE_READ_MS < now;
  }

  async function tick(e) {
    if (e.closed || stopped || e.paused) return;
    if (e.onceActive || e.once.length > 0) { e.tickHeld = true; return; }
    if (e.inFlight?.reason === 'sample') {
      // A sampling read is finishing: publishing waits for it rather than losing a whole interval.
      await waitIdle(e);
      if (e.closed || stopped || e.paused) return;
      if (e.onceActive || e.once.length > 0) { e.tickHeld = true; return; }
    }
    const now = clock.now();
    const I = e.intervalMs;
    if (e.inFlight) {
      if (!flightIsStale(e.inFlight, now)) {
        readLog.debug('previous read still running — tick skipped', { deviceId: e.id });
        arm(e, I);
        return;
      }
      readLog.error('driver read never returned — abandoning it', { deviceId: e.id });
      e.inFlight = null;
    }
    if (e.lastDataTs) {
      if (e.lastDataTs - now > I) {
        sysLog.warn('wall clock went backwards — pacing baseline reset', { deviceId: e.id, byMs: e.lastDataTs - now });
        e.lastDataTs = now - I;
      } else if (now < e.lastDataTs + I) {
        arm(e, e.lastDataTs + I - now);
        return;
      }
    }
    await runInterval(e);
  }

  async function runInterval(e) {
    const I = e.intervalMs;
    const tags = e.spec.tags.filter((t) => t.isIntervalRead);
    const ts = clock.now();
    let finish;
    const flight = { reason: 'interval', tags: new Set(tags.map((t) => t.name)), startedAt: ts, done: new Promise((r) => { finish = r; }) };
    let outcome = { route: null, values: {}, ts };
    try {
      const res = await readWith(e, tags, 'interval', Math.min(0.8 * I, READ_TIMEOUT_CAP_MS), flight);
      if (e.closed || stopped) return;
      e.lastPollAt = clock.now();
      const values = pick(res.values, tags);
      const ok = res.reachable && Object.keys(values).length > 0;
      if (res.reachable) e.failures = 0;
      else e.failures++;
      if (res.errors && typeof res.errors === 'object') {
        const first = Object.values(res.errors)[0];
        if (first) e.lastError = String(first).slice(0, 256);
      }
      setReach(e, !!res.reachable, res.reason);

      // The next tick is armed BEFORE the publish is awaited: a slow socket must never delay
      // the schedule (the publisher sends a reading that sat behind a stall to backfill).
      const delay = res.reachable ? I : backoffDelay(e);
      if (!e.paused && !e.onceActive && e.once.length === 0) arm(e, Math.max(0, ts + delay - clock.now()));
      else if (!e.paused) e.tickHeld = true;

      if (ok) {
        thresholds?.evaluate?.(e.spec, values, ts);
        e.lastDataTs = ts;
        const route = await publisher.data({ deviceId: e.id, ts, values, seq: nextSeq(e) }, { intervalMs: I });
        outcome = { route, values, ts };
      }
    } finally {
      finish(outcome);
      if (!flight.settled && e.inFlight === flight) e.inFlight = null;
    }
  }

  /** A read between publishes: thresholds and reachability only, never data. */
  async function sample(e) {
    armSample(e);
    if (e.closed || stopped || e.paused || e.inFlight || e.onceActive || e.once.length > 0) return;
    const R = sampleMs(e);
    const now = clock.now();
    // The publish read is due soon anyway; two reads back-to-back would only load the device.
    if (e.timer && e.dueAt - now < R / 2) return;
    const tags = e.spec.tags.filter((t) => t.isIntervalRead);
    if (tags.length === 0) return;
    const flight = { reason: 'sample', tags: new Set(tags.map((t) => t.name)), startedAt: now, done: Promise.resolve({ route: null, values: {}, ts: now }) };
    const res = await readWith(e, tags, 'interval', Math.min(0.8 * R, READ_TIMEOUT_CAP_MS), flight);
    if (!flight.settled && e.inFlight === flight) e.inFlight = null;
    if (e.closed || stopped) return;
    e.lastPollAt = clock.now();
    setReach(e, !!res.reachable, res.reason);
    const values = pick(res.values, tags);
    if (res.reachable && Object.keys(values).length > 0) thresholds?.evaluate?.(e.spec, values, now);
  }

  // ─── read/once ───────────────────────────────────────────────────────────────────────

  async function waitIdle(e) {
    while (e.inFlight && !e.closed) {
      const f = e.inFlight;
      if (!f.settled) { await f.done; continue; }
      const left = f.startedAt + (f.timeoutMs || READ_TIMEOUT_CAP_MS) + STALE_READ_MS - clock.now();
      if (left <= 0) { if (e.inFlight === f) e.inFlight = null; break; }
      await raceTimeout(f.settled, left);
    }
  }

  async function serviceOnce(e, item) {
    const ack = (a) => (item.correlationId ? publisher.ack(e.id, { correlationId: item.correlationId, ...a }) : Promise.resolve(true));

    // A scheduled read already on its way that contains the tag and goes out live is the answer.
    const flight = e.inFlight;
    if (flight && flight.reason === 'interval' && flight.tags.has(item.tag)) {
      const r = await raceTimeout(flight.done, READ_TIMEOUT_CAP_MS + ONCE_TIMEOUT_MS);
      const res = r.value;
      if (res && res.route === 'live' && Object.prototype.hasOwnProperty.call(res.values, item.tag)) {
        cmdLog.info('read-once answered by the scheduled read', { deviceId: e.id, tag: item.tag });
        await ack({ status: 'ok', error: null, value: res.values[item.tag], ts: res.ts });
        return;
      }
    }
    await waitIdle(e);
    if (e.closed || stopped) return;

    const ts = clock.now();
    const once = { reason: 'once', tags: new Set([item.tag]), startedAt: ts, done: Promise.resolve({ route: null, values: {}, ts }) };
    const res = await readWith(e, [item.tagSpec], 'once', ONCE_TIMEOUT_MS, once);
    if (!once.settled && e.inFlight === once) e.inFlight = null;
    if (e.closed || stopped) return;
    setReach(e, !!res.reachable, res.reason);
    const values = pick(res.values, [item.tagSpec]);
    if (!res.reachable || !Object.prototype.hasOwnProperty.call(values, item.tag)) {
      // A driver's own per-tag reason (e.g. "no message received yet on <topic>") is the
      // most useful thing the user can see; otherwise say why the read failed.
      const tagErr = res.errors?.[item.tag];
      const why = tagErr ? String(tagErr) : `read failed: ${(res.reachable ? 'no value' : res.reason) || 'unknown error'}`;
      cmdLog.warn('read-once failed', { deviceId: e.id, tag: item.tag, reason: why });
      await ack({ status: 'error', error: why });
      return;
    }
    thresholds?.evaluate?.(e.spec, values, ts);
    // Published at once, outside the pacing check: the platform exempts this message.
    const route = await publisher.data({ deviceId: e.id, ts, values, seq: nextSeq(e) }, { intervalMs: e.intervalMs, bypassBacklog: true });
    cmdLog.info('read-once', { deviceId: e.id, tag: item.tag, route });
    await ack({ status: 'ok', error: null, value: values[item.tag], ts });
  }

  async function drainOnce(e) {
    if (e.onceActive) return;
    e.onceActive = true;
    try {
      while (e.once.length > 0 && !e.closed && !stopped) {
        const item = e.once[0];
        const r = await raceTimeout(serviceOnce(e, item), ONCE_BUDGET_MS);
        if (r.error) cmdLog.error('read-once failed', { deviceId: e.id, err: r.error });
        if (r.timedOut) cmdLog.warn('read-once still waiting on the transport — releasing the schedule', { deviceId: e.id });
        e.once.shift();
        item.resolve();
      }
    } finally {
      e.onceActive = false;
      if (e.tickHeld) {
        e.tickHeld = false;
        ensureArmed(e);
      }
    }
  }

  // ─── pause ───────────────────────────────────────────────────────────────────────────

  function endPause(e, why) {
    e.paused = null;
    if (e.pauseTimer) clock.clearTimeout(e.pauseTimer);
    e.pauseTimer = null;
    editOverrides(e.id, (cur) => { delete cur.read; });
    cmdLog.info(`reads resumed (${why})`, { deviceId: e.id });
    // Read promptly, but never sooner than one interval after the last message.
    ensureArmed(e);
    armSample(e);
  }

  // ─── public API ──────────────────────────────────────────────────────────────────────

  function fingerprintOf(spec) {
    return spec.fingerprint ?? JSON.stringify({ protocol: spec.protocol, conn: spec.conn, tags: spec.tags });
  }

  function newEntry(spec, prev) {
    const driver = drivers.forProtocol(spec.protocol) || null;
    return {
      id: spec.id,
      spec,
      protocol: spec.protocol,
      fingerprint: fingerprintOf(spec),
      intervalMs: clampInterval(spec.intervalMs),
      driver,
      handle: undefined,
      opening: null,
      timer: null,
      pauseTimer: null,
      sampleTimer: null,
      dueAt: 0,
      lastDataTs: prev?.lastDataTs || 0,
      lastPollAt: prev?.lastPollAt || 0,
      failures: 0,
      reachable: prev ? prev.reachable : null,
      reason: prev ? prev.reason : null,
      lastError: null,
      paused: prev ? prev.paused : persistedPause(spec.id),
      inFlight: null,
      once: [],
      onceActive: false,
      tickHeld: false,
      closed: false,
      seq: prev ? prev.seq : (savedSeq[spec.id] !== undefined ? savedSeq[spec.id] + SEQ_RELOAD_BUMP : 0),
    };
  }

  return {
    /**
     * Converge on a new device list. Unchanged devices (same fingerprint) keep their driver
     * handle and their timer; changed ones are closed and reopened; removed ones are closed.
     * Pacing state (the last message's ts, seq, pause) survives a change, so a re-applied
     * configuration never causes an early message.
     * @param {DeviceSpec[]} devices
     */
    async apply(devices) {
      if (stopped) return;
      const next = new Map((devices || []).filter((d) => d && d.id).map((d) => [d.id, d]));
      const closing = [];
      for (const [id, e] of entries) {
        if (next.has(id)) continue;
        entries.delete(id);
        publisher.forget?.(id);
        closing.push(retire(e));
        sysLog.info('device removed', { deviceId: id });
      }

      const entering = [];
      for (const spec of next.values()) {
        const e = entries.get(spec.id);
        if (e && e.fingerprint === fingerprintOf(spec)) {
          e.spec = spec;
          const I = clampInterval(spec.intervalMs);
          if (I !== e.intervalMs) {
            e.intervalMs = I;
            rearm(e);
            armSample(e);
          }
          continue;
        }
        if (e) closing.push(retire(e, { ackError: 'device reconfigured while the read was pending — try again' }));
        const ne = newEntry(spec, e);
        entries.set(spec.id, ne);
        entering.push(ne);
        sysLog.info(e ? 'device changed' : 'device added', { deviceId: spec.id, protocol: spec.protocol, intervalMs: ne.intervalMs });
      }

      // Stagger newcomers inside each interval group across min(I, 10 s).
      const now = clock.now();
      const groups = new Map();
      for (const e of entering) {
        if (!groups.has(e.intervalMs)) groups.set(e.intervalMs, []);
        groups.get(e.intervalMs).push(e);
      }
      for (const [I, group] of groups) {
        const span = Math.min(I, STAGGER_CAP_MS);
        group.forEach((e, k) => {
          let due = now + Math.round(((k + 1) / (group.length + 1)) * span);
          if (e.lastDataTs) due = Math.max(due, e.lastDataTs + I);
          if (e.paused) armPause(e);
          else { arm(e, due - now); armSample(e); }
        });
      }

      for (const e of entering) {
        if (!e.driver) {
          setReach(e, false, unsupportedReason(e));
          sysLog.warn(`no driver for protocol "${e.protocol}"`, { deviceId: e.id });
          continue;
        }
        // Open eagerly (push-style drivers start listening now); failures are retried by the next tick.
        openEntry(e).catch((err) => {
          e.lastError = errMessage(err);
          readLog.debug('driver open failed', { deviceId: e.id, err });
        });
      }

      if (!seqTimer && !stopped) seqTimer = clock.setInterval(persistSeq, SEQ_SAVE_MS);
      await Promise.all(closing);
    },

    /**
     * Read one tag now and reply: data carrying only that tag, then the ack.
     * @param {string} deviceId
     * @param {string} tag
     * @param {string|null} correlationId  No ack is sent without one.
     */
    readOnce(deviceId, tag, correlationId) {
      const e = entries.get(deviceId);
      const ack = (a) => (correlationId ? publisher.ack(deviceId, { correlationId, ...a }) : Promise.resolve(true));
      if (stopped) return Promise.resolve();
      if (!e) return ack({ status: 'error', error: NOT_IN_CONFIG }).then(() => {});
      const tagSpec = e.spec.tags.find((t) => t.name === tag);
      if (!tagSpec) {
        cmdLog.warn('read-once for an unknown tag', { deviceId, tag });
        return ack({ status: 'error', error: `tag "${tag}" not found` }).then(() => {});
      }
      if (e.once.length >= ONCE_QUEUE_MAX) return ack({ status: 'error', error: 'read-once busy' }).then(() => {});
      return new Promise((resolve) => {
        e.once.push({ tag, tagSpec, correlationId, resolve });
        drainOnce(e);
      });
    },

    /** Persisted override; applied live; clamped to [max(250, minIntervalMs), 3 600 000]. */
    setInterval(deviceId, ms) {
      const e = entries.get(deviceId);
      if (!e) return;
      const I = clampInterval(ms);
      e.intervalMs = I;
      editOverrides(deviceId, (cur) => { cur.intervalMs = I; cur.intervalSetAt = clock.now(); });
      cmdLog.info('interval set', { deviceId, intervalMs: I });
      rearm(e);
      armSample(e);
    },

    /**
     * @param {string} deviceId
     * @param {'manual'|'restart'|'timed'} mode  manual = until read/enable (persisted);
     *   restart = until the process restarts (memory only); timed = for durationMs (persisted).
     * @param {number} [durationMs]
     */
    pause(deviceId, mode, durationMs) {
      const e = entries.get(deviceId);
      if (!e) return;
      let m = mode === 'until_restart' ? 'restart' : mode;
      if (m !== 'restart' && m !== 'timed') m = 'manual';
      let until = null;
      if (m === 'timed') {
        const d = Number(durationMs);
        if (!Number.isFinite(d) || d <= 0) { cmdLog.warn('timed pause without a valid durationMs — ignored', { deviceId }); return; }
        until = clock.now() + Math.round(d);
      }
      e.paused = { mode: m, until };
      if (e.timer) clock.clearTimeout(e.timer);
      if (e.sampleTimer) clock.clearTimeout(e.sampleTimer);
      e.timer = e.sampleTimer = null;
      armPause(e);
      editOverrides(deviceId, (cur) => {
        if (m === 'restart') delete cur.read;
        else cur.read = m === 'timed' ? { enabled: false, mode: 'timed', until } : { enabled: false, mode: 'manual' };
      });
      cmdLog.info('reads paused', { deviceId, mode: m, ...(until ? { until: new Date(until).toISOString() } : {}) });
    },

    resume(deviceId) {
      const e = entries.get(deviceId);
      if (!e) return;
      if (!e.paused) { ensureArmed(e); return; }
      endPause(e, 'read/enable');
    },

    /**
     * @param {string} deviceId
     * @param {WriteOp} op
     * @returns {Promise<WriteResult>}
     */
    async write(deviceId, op) {
      const e = entries.get(deviceId);
      if (!e) return { ok: false, error: NOT_IN_CONFIG };
      if (!e.driver) return { ok: false, error: unsupportedReason(e) };
      const kind = op?.kind === 'modbus' ? 'modbus' : 'actuator';
      if (typeof e.driver.write !== 'function') return { ok: false, error: `${kind} writes are not supported for protocol "${e.protocol}"` };
      const r = await raceTimeout((async () => { await openEntry(e); return e.driver.write(e.handle, op); })(), WRITE_TIMEOUT_MS);
      if (r.timedOut) return { ok: false, error: 'write timed out' };
      if (r.error) return { ok: false, error: errMessage(r.error) };
      const res = r.value || {};
      const out = { ok: res.ok === true };
      if (typeof res.value === 'number' && Number.isFinite(res.value)) out.value = res.value;
      if (!out.ok) out.error = String(res.error || 'write failed').slice(0, 512);
      return out;
    },

    /** Per-device runtime view, for presence, diagnostics and runtime.json. */
    snapshot() {
      return [...entries.values()].map((e) => {
        let { reachable, reason } = e;
        if (e.handle !== undefined && typeof e.driver?.status === 'function' && !sim?.active) {
          try {
            const s = e.driver.status(e.handle);
            if (s && typeof s.reachable === 'boolean') { reachable = s.reachable; reason = s.reachable ? null : (s.reason ?? reason); }
          } catch { /* keep the read-derived view */ }
        }
        return {
          id: e.id,
          protocol: e.protocol,
          intervalMs: e.intervalMs,
          lastDataTs: e.lastDataTs || null,
          lastPollAt: e.lastPollAt || null,
          reachable,
          reason: reason || null,
          paused: e.paused ? e.paused.mode : null,
          pausedUntil: e.paused?.until ?? null,
          failures: e.failures,
          inFlight: !!e.inFlight,
          lastError: e.lastError,
          supported: !!e.driver,
          seq: e.seq,
        };
      });
    },

    /** Write the per-device message counters now (also done every 60 s and on stop). */
    persistSeq() { seqDirty = true; persistSeq(); },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (seqTimer) clock.clearInterval(seqTimer);
      seqTimer = null;
      await Promise.all([...entries.values()].map((e) => retire(e, { ackError: null })));
      if (entries.size > 0) seqDirty = true;
      persistSeq();
      entries.clear();
    },
  };
}
