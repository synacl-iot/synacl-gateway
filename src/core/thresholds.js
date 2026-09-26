// Local threshold alerts: the alarm band a user sets on a tag is evaluated HERE, at the edge.
// The platform stores and displays the alerts but never evaluates tag bands itself, so without
// this module a band set in the app would do nothing on a software gateway.
//
// Behaviour matches the reference firmware:
//   - engineering value = raw × scaleFactor + offset (the band is in engineering units; the
//     wire carries raw values);
//   - a band of [0, 0] is "no band"; [0, 500] is a real band;
//   - edge-triggered: THRESHOLD_VIOLATION once when the value leaves the band, THRESHOLD_CLEARED
//     once when it comes back — never an alert per reading;
//   - a one-sided band arrives with a ±1e9 sentinel on the open side and needs no special case.
// The in-band state is reset silently (the platform clears its own warning at the same
// moments) when a tag's band, scale or offset changes, when the device becomes unreachable,
// and on restart. Transitions that happen while offline are queued (at most 100, oldest
// dropped) and sent after reconnect, in order.

/** @typedef {import('./types.js').DeviceSpec} DeviceSpec */
/** @typedef {import('./types.js').TagSpec} TagSpec */
/** @typedef {import('./types.js').Clock} Clock */
/** @typedef {import('./types.js').Logger} Logger */

const QUEUE_MAX = 100;
const SENTINEL = 1e9;

/** @param {TagSpec} tag */
function bandKey(tag) {
  return `${tag.thresholdStart}|${tag.thresholdEnd}|${tag.scaleFactor}|${tag.offset}`;
}

/** Engineering values carry float noise (0.1 × 3); 10 significant digits is plenty for a band. */
function tidy(n) {
  return Number(n.toPrecision(10));
}

function describeBand(start, end) {
  if (start <= -SENTINEL && end >= SENTINEL) return 'range (unbounded)';
  if (start <= -SENTINEL) return `upper limit ${tidy(end)}`;
  if (end >= SENTINEL) return `lower limit ${tidy(start)}`;
  return `range [${tidy(start)}, ${tidy(end)}]`;
}

/**
 * @param {Object} deps
 * @param {{alert(deviceId: string, alert: Object): Promise<boolean|void>}} deps.publisher
 * @param {Clock} deps.clock
 * @param {Logger} [deps.log]
 */
export function createThresholds({ publisher, clock, log }) {
  /** deviceId → Map(tagName → {band: string, inAlert: boolean}) */
  const state = new Map();
  /** @type {{deviceId: string, alert: Object}[]} */
  const queue = [];
  let dropped = 0;
  // Sends run one at a time so alerts leave in the order their transitions happened.
  let chain = Promise.resolve();

  function tagState(deviceId, tag) {
    let dev = state.get(deviceId);
    if (!dev) { dev = new Map(); state.set(deviceId, dev); }
    const key = bandKey(tag);
    let s = dev.get(tag.name);
    if (!s || s.band !== key) { s = { band: key, inAlert: false }; dev.set(tag.name, s); }
    return s;
  }

  function enqueue(item) {
    queue.push(item);
    if (queue.length > QUEUE_MAX) {
      queue.shift();
      dropped++;
      log?.warn('offline alert queue full — oldest transition dropped', { dropped });
    }
  }

  async function trySend(item) {
    // Anything already queued goes first; a new transition may not overtake it.
    if (queue.length > 0) { enqueue(item); return; }
    let sent = false;
    try { sent = (await publisher.alert(item.deviceId, item.alert)) !== false; } catch (err) { log?.debug('alert publish failed', { err }); }
    if (!sent) enqueue(item);
  }

  function raise(deviceId, alert) {
    const item = { deviceId, alert };
    chain = chain.then(() => trySend(item));
  }

  return {
    /**
     * Evaluate every numeric raw value of one successful reading.
     * @param {DeviceSpec} device
     * @param {Object<string, unknown>} values  Raw values keyed by tag name.
     * @param {number} ts  Reading timestamp (epoch ms).
     */
    evaluate(device, values, ts) {
      if (!device || !values) return;
      for (const tag of device.tags || []) {
        const raw = values[tag.name];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
        const start = Number(tag.thresholdStart) || 0;
        const end = Number(tag.thresholdEnd) || 0;
        const enabled = start !== 0 || end !== 0;
        const s = tagState(device.id, tag);
        if (!enabled) { s.inAlert = false; continue; }
        const scale = Number.isFinite(tag.scaleFactor) ? tag.scaleFactor : 1;
        const offset = Number.isFinite(tag.offset) ? tag.offset : 0;
        const eng = tidy(raw * scale + offset);
        if (!Number.isFinite(eng)) continue;
        const out = eng < start || eng > end;
        if (out && !s.inAlert) {
          s.inAlert = true;
          raise(device.id, {
            ts: Math.floor(ts ?? clock.now()), severity: 'warning', code: 'THRESHOLD_VIOLATION', tag: tag.name, value: eng,
            message: `${tag.name}: value ${eng} outside ${describeBand(start, end)}`,
          });
        } else if (!out && s.inAlert) {
          s.inAlert = false;
          raise(device.id, {
            ts: Math.floor(ts ?? clock.now()), severity: 'info', code: 'THRESHOLD_CLEARED', tag: tag.name, value: eng,
            message: `${tag.name}: value ${eng} back within ${describeBand(start, end)}`,
          });
        }
      }
    },

    /** Forget every tag's in-band state for a device (it became unreachable). */
    resetDevice(deviceId) {
      state.delete(deviceId);
    },

    /**
     * A new configuration was applied: drop state for devices and tags that are gone, and for
     * tags whose band, scale or offset changed.
     * @param {DeviceSpec[]} prev
     * @param {DeviceSpec[]} next
     */
    reconcile(prev, next) {
      const keep = new Map((next || []).map((d) => [d.id, d]));
      for (const id of [...state.keys()]) if (!keep.has(id)) state.delete(id);
      for (const [id, dev] of state) {
        const tags = new Map((keep.get(id).tags || []).map((t) => [t.name, t]));
        for (const [name, s] of [...dev]) {
          const t = tags.get(name);
          if (!t || bandKey(t) !== s.band) dev.delete(name);
        }
      }
      void prev; // state already tracks the band each tag was evaluated under
    },

    /** Send the transitions queued while offline, oldest first; stops at the first failure. */
    flushQueued() {
      chain = chain.then(async () => {
        while (queue.length > 0) {
          const item = queue[0];
          let sent = false;
          try { sent = (await publisher.alert(item.deviceId, item.alert)) !== false; } catch (err) { log?.debug('alert publish failed', { err }); }
          if (!sent) return;
          queue.shift();
        }
      });
      return chain;
    },

    /** For diagnostics and tests. */
    stats: () => ({ queued: queue.length, dropped, inAlert: [...state.values()].reduce((n, d) => n + [...d.values()].filter((s) => s.inAlert).length, 0) }),

    /** Resolves when every alert raised so far has been sent or queued. */
    idle: () => chain,
  };
}
