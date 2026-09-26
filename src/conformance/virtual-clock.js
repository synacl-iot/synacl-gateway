// VirtualClock — a Clock (src/core/types.js) whose time only moves when the test says so.
//
// The gateway core schedules everything through its injected Clock, so a 30-minute scenario
// can run in milliseconds: `advance(ms)` fires every timer that falls due inside the window,
// in due order (ties in scheduling order), and lets promise continuations settle between
// timers so async code observes the same interleaving it would in real time.

/** @typedef {import('../core/types.js').Clock} Clock */

// 2026-01-15T12:00:00Z — any fixed, plausible epoch; well past the gateway's "clock is valid" year guard.
export const DEFAULT_EPOCH = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Let pending microtasks and already-queued I/O callbacks run. */
export async function settle(turns = 2) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {{start?: number}} [opts]
 * @returns {Clock & {
 *   advance(ms: number): Promise<void>, runUntil(pred: () => boolean, maxMs: number, stepMs?: number): Promise<boolean>,
 *   set(epochMs: number): void, settle(): Promise<void>, pending(): number, nextDue(): number|null,
 *   errors: Error[], timersFired: number }}
 */
export function createVirtualClock({ start = DEFAULT_EPOCH } = {}) {
  let now = Math.floor(start);
  let seq = 0;
  let fired = 0;
  /** @type {{id: number, due: number, seq: number, fn: Function, repeat: number, cancelled: boolean}[]} */
  const timers = []; // kept sorted by (due, seq)
  const errors = [];

  function insert(t) {
    let lo = 0;
    let hi = timers.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const m = timers[mid];
      if (m.due < t.due || (m.due === t.due && m.seq < t.seq)) lo = mid + 1;
      else hi = mid;
    }
    timers.splice(lo, 0, t);
  }

  function schedule(fn, ms, repeat) {
    if (typeof fn !== 'function') throw new TypeError('timer callback must be a function');
    const delay = Math.max(0, Math.floor(Number(ms) || 0));
    const t = { id: ++seq, due: now + delay, seq, fn, repeat: repeat ? Math.max(1, delay) : 0, cancelled: false };
    insert(t);
    // Opaque handle. `unref`/`ref` exist so code written for Node timers does not throw.
    return { __vtimer: t, unref() { return this; }, ref() { return this; }, hasRef() { return false; } };
  }

  function cancel(handle) {
    const t = handle && handle.__vtimer;
    if (!t || t.cancelled) return;
    t.cancelled = true;
    const i = timers.indexOf(t);
    if (i !== -1) timers.splice(i, 1);
  }

  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => schedule(fn, ms, false),
    clearTimeout: cancel,
    setInterval: (fn, ms) => schedule(fn, ms, true),
    clearInterval: cancel,

    errors,
    get timersFired() { return fired; },

    /** Move time forward by `ms`, firing due timers in order. Never moves backwards. */
    async advance(ms) {
      const target = now + Math.max(0, Math.floor(ms));
      await settle();
      while (timers.length && timers[0].due <= target) {
        const t = timers.shift();
        if (t.due > now) now = t.due;
        if (t.repeat) {
          t.due = now + t.repeat;
          t.seq = ++seq;
          insert(t);
        }
        fired++;
        try {
          t.fn();
        } catch (err) {
          // A throwing timer would crash a real process; here it is recorded so the scenario fails loudly.
          errors.push(err);
        }
        await settle();
      }
      now = target;
      await settle();
    },

    /** Advance in steps until `pred()` is true or `maxMs` elapsed. Resolves to whether pred held. */
    async runUntil(pred, maxMs, stepMs = 100) {
      const end = now + maxMs;
      await settle();
      if (pred()) return true;
      while (now < end) {
        await clock.advance(Math.min(stepMs, end - now));
        if (pred()) return true;
      }
      return false;
    },

    /** Jump the wall clock (e.g. an NTP step backwards) without firing timers. */
    set(epochMs) {
      const delta = Math.floor(epochMs) - now;
      now = Math.floor(epochMs);
      // Timers are relative in real life (monotonic), so they keep their remaining delay.
      for (const t of timers) t.due += delta;
    },

    settle: () => settle(),
    pending: () => timers.length,
    nextDue: () => (timers.length ? timers[0].due : null),
  };
  return clock;
}
