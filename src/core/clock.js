// The real Clock (see types.js) and a clock-skew probe.
//
// Every timer in the core goes through a Clock so the conformance suite can swap in a virtual
// one. Timers are deliberately NOT unref'd: while the gateway waits out a reconnect backoff the
// timer is the only thing keeping the process alive. stop() clears every timer it armed.

/** @typedef {import('./types.js').Clock} Clock */

/** @type {Clock} */
export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(/** @type {any} */ (h)),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(/** @type {any} */ (h)),
};

/**
 * Estimate how far the local clock is off, from the `Date` header of an HTTPS HEAD to the
 * platform API. Readings are timestamped locally, so a Pi without an RTC that booted before
 * NTP would otherwise publish (and buffer) data from the wrong day.
 *
 * @param {string|null|undefined} apiUrl
 * @param {{timeoutMs?: number, fetch?: typeof fetch}} [opts]
 * @returns {Promise<number|null>}  local − server in ms (positive = local clock ahead), measured
 *   at the midpoint of the round trip. Resolution is ±1 s (the header has whole seconds).
 *   null on any failure; never throws.
 */
export async function probeSkew(apiUrl, { timeoutMs = 5000, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!apiUrl || typeof fetchImpl !== 'function') return null;
  try {
    const sent = Date.now();
    const res = await fetchImpl(apiUrl, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const received = Date.now();
    const header = res?.headers?.get?.('date');
    if (!header) return null;
    const server = Date.parse(header);
    if (!Number.isFinite(server)) return null;
    // The server stamps the header somewhere inside the round trip; the midpoint halves the
    // worst-case error. The header truncates to the second, so add half a second back.
    const local = sent + (received - sent) / 2;
    return Math.round(local - (server + 500));
  } catch {
    return null;
  }
}
