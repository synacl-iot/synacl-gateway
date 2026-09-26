// Device-configuration sync: config/request → config/push.
//
// The reply is `{"unchanged":true}`, the full device list, or (only when the gateway sent `cap`)
// one base64 chunk of it. The gateway hashes the EXACT bytes it received (FNV-1a), stores them,
// applies them, and then always asks again with the new hash: only the `unchanged` answer to
// that second request tells the platform this gateway is in sync.
//
// Every request has side effects on the platform (it re-sends macros and job settings and
// records a config-sync event in the user's feed), so requests are never sent on a fixed timer:
// on connect (after 2 s), after every applied config, on an explicit requestNow(), and — only
// when nothing answers — after 10, 20, 40 and 80 s, then every 10 minutes. The same reason is
// why `cap` (chunking) is opt-in: every part is its own request.

import { fnv1a32 } from './fnv.js';

/** @typedef {import('./types.js').Transport} Transport */
/** @typedef {import('./types.js').Clock} Clock */
/** @typedef {import('./types.js').Logger} Logger */

export const FIRST_REQUEST_DELAY_MS = 2000;
export const RETRY_DELAYS_MS = Object.freeze([10000, 20000, 40000, 80000]);
export const SLOW_RETRY_MS = 600000;
export const PART_TIMEOUT_MS = 10000;
export const PART_RETRIES = 3;
export const MAX_TRANSFER_RESTARTS = 3;
/** What the capability report advertises as `maxConfigBytes`. */
export const DEFAULT_MAX_CONFIG_BYTES = 1048576;
/** Identical full payloads in a row before we stop answering them with a new request. */
const MAX_SAME_IN_A_ROW = 3;

/**
 * @param {Object} o
 * @param {Transport} o.transport
 * @param {{up(name: string): string}} o.topics
 * @param {{writeConfigRaw(bytes: Buffer, meta: Object): void, readConfigRaw?(): {meta: Object}|null}} o.state
 * @param {Clock} o.clock
 * @param {Logger} o.log
 * @param {number|null} [o.configCap]  bytes per MQTT message; null = never chunk.
 * @param {(bytes: Buffer, doc: Object, hash: number) => Promise<void>} o.onApply
 * @param {{validate(name: string, v: unknown): {ok: boolean, errors: string[]}}} [o.validators]
 * @param {number} [o.initialHash]  hash of the config already running (default: read from state).
 * @param {number} [o.maxConfigBytes]
 * @param {(synced: boolean) => void} [o.onSynced]  called when the in-sync flag changes.
 */
export function createConfigSync({
  transport, topics, state, clock, log, configCap = null, onApply, validators,
  initialHash, maxConfigBytes = DEFAULT_MAX_CONFIG_BYTES, onSynced,
}) {
  const topic = topics.up('gateway.config-request');
  const cap = Number.isInteger(configCap) && configCap > 0 ? configCap : null;

  let hash = Number.isInteger(initialHash) ? initialHash : (state?.readConfigRaw?.()?.meta?.hash ?? 0);
  let isSynced = false;
  let online = false;
  let stopped = false;
  /** Requests sent in the current cycle without an answer; picks the retry delay. */
  let attempt = 0;
  let startTimer = null;
  let replyTimer = null;
  /** @type {{h: number, n: number, parts: Buffer[], next: number, bytes: number} | null} */
  let transfer = null;
  /** Hash-mismatch restarts, bounded per announced (h, n). */
  let restarts = { h: -1, n: -1, count: 0 };
  let partTimeouts = 0;
  let sameInARow = 0;
  let chain = Promise.resolve();

  function setSynced(v) {
    if (isSynced === v) return;
    isSynced = v;
    onSynced?.(v);
  }

  function clearStart() {
    if (startTimer !== null) { clock.clearTimeout(startTimer); startTimer = null; }
  }

  function clearReply() {
    if (replyTimer !== null) { clock.clearTimeout(replyTimer); replyTimer = null; }
  }

  function send(body, reason) {
    if (!transport.connected) return;
    log.debug('config/request', { ...body, reason });
    transport.publish(topic, JSON.stringify(body), { qos: 0 }).catch((err) => {
      // Lost with the connection; onConnected() asks again.
      log.debug('config/request not sent', { error: err.message });
    });
  }

  /** A whole-config request; arms the retry timer. */
  function request(reason) {
    clearStart();
    clearReply();
    if (!online || stopped) return;
    const body = cap ? { hash, cap } : { hash };
    send(body, reason);
    const delay = attempt < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[attempt] : SLOW_RETRY_MS;
    attempt++;
    replyTimer = clock.setTimeout(() => {
      replyTimer = null;
      log.warn('no reply to config/request — the platform may be refusing an oversized configuration '
        + '(event gateway/config-too-large) or has not stored this gateway\'s capabilities yet; asking again',
      { attempt, nextInSeconds: (attempt < RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[attempt] : SLOW_RETRY_MS) / 1000 });
      request('retry');
    }, delay);
  }

  /** Ask for one part of a chunked transfer — always with the OLD hash. */
  function requestPart(part, reason) {
    clearStart();
    clearReply();
    if (!online || stopped) return;
    send(cap ? { hash, cap, part } : { hash, part }, reason);
    replyTimer = clock.setTimeout(() => {
      replyTimer = null;
      partTimeouts++;
      if (partTimeouts > PART_RETRIES) {
        log.warn(`configuration part ${part} did not arrive after ${PART_RETRIES} retries; abandoning the transfer`);
        abortTransfer();
        slowRetry();
        return;
      }
      requestPart(part, 'part-timeout');
    }, PART_TIMEOUT_MS);
  }

  function slowRetry() {
    clearReply();
    attempt = RETRY_DELAYS_MS.length;
    replyTimer = clock.setTimeout(() => { replyTimer = null; request('slow-retry'); }, SLOW_RETRY_MS);
  }

  function abortTransfer() {
    transfer = null;
    partTimeouts = 0;
  }

  async function applyFull(bytes, doc, via) {
    clearReply();
    const h = fnv1a32(bytes);
    if (validators) {
      // New optional keys may appear within v1: a schema miss is worth a warning, not a refusal.
      const v = validators.validate('config-push', doc);
      if (!v.ok) log.warn('config/push does not match the published schema; applying it anyway', { errors: v.errors.slice(0, 5) });
    }
    if (h === hash) {
      sameInARow++;
      log.info('configuration unchanged (identical bytes); not re-applying', { hash: h });
      if (sameInARow >= MAX_SAME_IN_A_ROW) {
        log.error('the platform keeps sending the configuration this gateway already runs; pausing requests for 10 minutes', { hash: h });
        sameInARow = 0;
        slowRetry();
        return;
      }
    } else {
      sameInARow = 0;
      const now = clock.now();
      try {
        state.writeConfigRaw(bytes, { hash: h, bytes: bytes.length, receivedAt: now, appliedAt: now, via });
      } catch (err) {
        log.error('could not save the configuration; running it anyway', { error: err.message });
      }
      hash = h;
      setSynced(false);
      try {
        await onApply(bytes, doc, h);
        log.info('configuration applied', { hash: h, devices: doc.devices.length, bytes: bytes.length, via });
      } catch (err) {
        log.error('applying the configuration failed', { hash: h, error: err?.message ?? String(err) });
      }
      if (stopped) return;
    }
    attempt = 0;
    request('applied');
  }

  function isChunk(doc) {
    return 'p' in doc && 'd' in doc && !('devices' in doc);
  }

  async function handleChunk(doc) {
    const { p, n, h, d } = doc;
    if (!Number.isInteger(p) || !Number.isInteger(n) || n < 1 || p < 0 || p >= n
      || !Number.isInteger(h) || h < 0 || h > 0xffffffff || typeof d !== 'string') {
      log.warn('malformed configuration chunk; restarting the transfer', { p, n });
      abortTransfer();
      requestPart(0, 'malformed');
      return;
    }
    if (!transfer && h === hash) {
      // A straggler for the configuration we already run (e.g. after a full push won the race).
      log.debug('configuration part for the current configuration ignored', { p });
      return;
    }
    if (!transfer || transfer.h !== h || transfer.n !== n) {
      if (transfer) log.info('the configuration changed during a chunked transfer; starting over');
      abortTransfer();
      if (p !== 0) { requestPart(0, 'restart'); return; }
      transfer = { h, n, parts: new Array(n), next: 0, bytes: 0 };
      if (restarts.h !== h || restarts.n !== n) restarts = { h, n, count: 0 };
      log.info(`receiving the configuration in ${n} parts`, { hash: h });
    }
    // A duplicate: the request for the part we need is still outstanding with its own timer.
    if (p < transfer.next) { log.debug('duplicate configuration part ignored', { p }); return; }
    if (p > transfer.next) { requestPart(transfer.next, 'out-of-order'); return; }

    partTimeouts = 0;
    const part = Buffer.from(d, 'base64');
    transfer.bytes += part.length;
    if (transfer.bytes > maxConfigBytes) {
      log.error(`chunked configuration exceeds ${maxConfigBytes} bytes; abandoning it`);
      abortTransfer();
      slowRetry();
      return;
    }
    transfer.parts[p] = part;
    transfer.next = p + 1;
    if (transfer.next < n) { requestPart(transfer.next, 'next-part'); return; }

    // Concatenate BYTES: a multi-byte character may straddle two parts.
    const whole = Buffer.concat(transfer.parts);
    abortTransfer();
    clearReply();
    if (fnv1a32(whole) !== h) {
      restarts.count++;
      if (restarts.count > MAX_TRANSFER_RESTARTS) {
        log.error(`reassembled configuration failed its hash check ${restarts.count} times; asking again in 10 minutes`, { expected: h });
        slowRetry();
        return;
      }
      log.warn('reassembled configuration failed its hash check; restarting the transfer', { expected: h, restart: restarts.count });
      requestPart(0, 'hash-mismatch');
      return;
    }
    let full;
    try { full = JSON.parse(whole.toString('utf8')); } catch { full = null; }
    if (!full || !Array.isArray(full.devices) || full.success !== true) {
      log.error('reassembled configuration is not a device list; keeping the current configuration');
      return;
    }
    await applyFull(whole, full, 'chunked');
  }

  async function handle(buf) {
    if (stopped) return;
    const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    let doc = null;
    try { doc = JSON.parse(bytes.toString('utf8')); } catch { /* reported below */ }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      clearReply();
      log.error('config/push is not a JSON object; keeping the current configuration');
      return;
    }
    if (doc.unchanged === true) {
      clearReply();
      abortTransfer();
      attempt = 0;
      sameInARow = 0;
      if (!isSynced) log.info('configuration is current', { hash });
      setSynced(true);
      return;
    }
    if (isChunk(doc)) { await handleChunk(doc); return; }
    if (!Array.isArray(doc.devices) || doc.success !== true) {
      // No re-request: the app keeps showing the gateway as out of date, which is the truth.
      clearReply();
      log.error('config/push has no device list (devices + success:true); keeping the current configuration');
      return;
    }
    if (transfer) { log.info('a full configuration arrived during a chunked transfer; transfer abandoned'); abortTransfer(); }
    await applyFull(bytes, doc, replyTimer !== null ? 'reply' : 'push');
  }

  return {
    /** Called by the gateway after the heartbeat and capability report went out. */
    onConnected() {
      if (stopped) return;
      online = true;
      attempt = 0;
      abortTransfer();
      clearReply();
      clearStart();
      // The capability report and this request are handled by different platform workers; the
      // delay lets the capabilities land first (they decide the size budget and chunking).
      startTimer = clock.setTimeout(() => { startTimer = null; request('connect'); }, FIRST_REQUEST_DELAY_MS);
    },

    onDisconnected() {
      online = false;
      clearStart();
      clearReply();
      abortTransfer();
    },

    /** @param {Buffer} buf  a config/push payload, exactly as received */
    onMessage(buf) {
      chain = chain.then(() => handle(buf)).catch((err) => {
        log.error('config/push handling failed', { error: err?.message ?? String(err) });
      });
    },

    requestNow(reason = 'manual') {
      if (stopped) return;
      attempt = 0;
      abortTransfer();
      request(reason);
    },

    currentHash: () => hash,
    synced: () => isSynced,
    /** Resolves when every message received so far has been handled (tests, shutdown). */
    idle: () => chain,

    stop() {
      stopped = true;
      online = false;
      clearStart();
      clearReply();
      abortTransfer();
    },
  };
}
