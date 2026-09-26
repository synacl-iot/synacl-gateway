// Remote diagnostics: the one-shot `debug/response` snapshot and the live log tail on
// `debug/log`.
//
// Both are relayed live to the user's debug panel, so both are bounded (the schema's caps)
// and carry nothing sensitive: device ids and protocols only — never device names, `conn`
// objects or credentials — and every log line has already been through the logger's redactor.
//
// The live tail follows the reference firmware: a category bitmask with `system` always on,
// a 5-minute window that a repeated start extends (so a forgotten console cannot stream
// forever), a flush every second of at most 50 lines, and a token bucket (20 lines/s, burst
// 40) whose overflow is reported as one "… N lines dropped" line instead of being streamed.

import { CATEGORY_BITS } from './log.js';
import { detectNet } from './presence.js';

/** @typedef {import('./types.js').Clock} Clock */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').LogLine} LogLine */

export const TAIL_WINDOW_MS = 5 * 60 * 1000;
const FLUSH_MS = 1000;
const MAX_LINES = 50;
const MAX_LINE_CHARS = 512;
const RATE_PER_S = 20;
const BURST = 40;
const MAX_PENDING = 200;
const MAX_DEVICES = 200;
const MAX_RECENT = 100;
/** `start` without a mask (an older platform): system + commands. */
const DEFAULT_MASK = CATEGORY_BITS.system | CATEGORY_BITS.commands;
const ALL_BITS = 63;

function clip(s, max) {
  const str = String(s ?? '');
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/** @param {LogLine} line */
function tailText(line) {
  const t = new Date(line.ts).toISOString().slice(11, 23);
  const lvl = line.level === 'warn' || line.level === 'error' ? `${line.level.toUpperCase()} ` : '';
  return clip(`${t} [${line.category}] ${lvl}${line.msg}`, MAX_LINE_CHARS);
}

/** @param {LogLine} line */
function ringText(line) {
  return clip(`${new Date(line.ts).toISOString()} ${line.level.toUpperCase()} [${line.category}] ${line.msg}`, MAX_LINE_CHARS);
}

function maskNames(mask) {
  const names = Object.entries(CATEGORY_BITS).filter(([n, b]) => n !== 'system' && mask & b).map(([n]) => n);
  return names.length ? names.join(',') : 'system only';
}

/**
 * @param {Object} deps
 * @param {{gateway(name: string, body: Object, opts?: Object): Promise<boolean|void>}} deps.publisher
 * @param {Logger & {recent?: () => LogLine[]}} deps.log  A logger from createLogger (uses tap + recent).
 * @param {Clock} deps.clock
 * @param {() => {configHash?: number, connected?: boolean, devices?: Object[], fw?: string, ip?: string, uplink?: string}} [deps.snapshot]
 * @param {string} [deps.version]
 * @param {() => {ip?: string, uplink?: string}} [deps.netInfo]
 * @param {() => number} [deps.uptimeMs]
 * @param {() => {heapTotal: number, heapUsed: number}} [deps.memory]
 */
export function createDebug({
  publisher, log, clock, snapshot, version,
  netInfo = detectNet,
  uptimeMs = () => Math.floor(process.uptime() * 1000),
  memory = () => process.memoryUsage(),
}) {
  const sysLog = log.child ? log.child('system') : log;

  let streaming = false;
  let mask = CATEGORY_BITS.system;
  let until = 0;
  let pending = /** @type {string[]} */ ([]);
  let dropped = 0;
  let seq = 0;
  let tokens = BURST;
  let tokensAt = 0;
  let untap = null;
  let flushTimer = null;
  let flushing = false;

  function takeToken() {
    const now = clock.now();
    tokens = Math.min(BURST, tokens + (Math.max(0, now - tokensAt) * RATE_PER_S) / 1000);
    tokensAt = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }

  /** @param {LogLine} line */
  function onLine(line) {
    if (!streaming) return;
    const bit = CATEGORY_BITS[line.category] || CATEGORY_BITS.system;
    if (!(mask & bit)) return;
    if (takeToken() && pending.length < MAX_PENDING) pending.push(tailText(line));
    else dropped++;
  }

  function endTail() {
    streaming = false;
    untap?.();
    untap = null;
    if (flushTimer) clock.clearInterval(flushTimer);
    flushTimer = null;
    pending = [];
    dropped = 0;
  }

  async function flush() {
    if (!streaming || flushing) return;
    const now = clock.now();
    if (now >= until) {
      endTail();
      sysLog.info('debug log tail auto-stopped');
      return;
    }
    if (pending.length === 0 && dropped === 0) return;
    flushing = true;
    const lines = [];
    const droppedNow = dropped;
    if (droppedNow) lines.push(`${new Date(now).toISOString().slice(11, 23)} [system] … ${droppedNow} lines dropped (rate limit)`);
    const taken = pending.splice(0, MAX_LINES - lines.length);
    dropped = 0;
    lines.push(...taken);
    let sent = false;
    try {
      sent = (await publisher.gateway('gateway.debug-log', { ts: now, seq, lines })) !== false;
    } catch (err) {
      sysLog.debug('debug log publish failed', { err });
    } finally {
      flushing = false;
    }
    if (sent) { seq++; return; }
    // Offline: keep the lines for the next flush (an outage's own lines are worth seeing).
    if (!streaming) return;
    pending = [...taken, ...pending];
    dropped += droppedNow;
    if (pending.length > MAX_PENDING) { dropped += pending.length - MAX_PENDING; pending = pending.slice(-MAX_PENDING); }
  }

  return {
    /**
     * Publish one diagnostics snapshot, echoing the command's correlationId.
     * @param {string} correlationId
     * @returns {Promise<boolean|void>}
     */
    async diag(correlationId) {
      const now = clock.now();
      let snap = {};
      try { snap = snapshot?.() || {}; } catch (err) { sysLog.debug('diagnostics snapshot failed', { err }); }
      let net = {};
      try { net = netInfo?.() || {}; } catch { /* no address is still a useful snapshot */ }

      const body = { correlationId: clip(correlationId, 64), ts: now };
      const ip = snap.ip ?? net.ip;
      if (typeof ip === 'string' && ip) body.ip = clip(ip, 64);
      const up = Number(uptimeMs());
      if (Number.isFinite(up) && up >= 0) body.uptimeMs = Math.floor(up);
      try {
        const m = memory();
        const free = Math.floor(m.heapTotal - m.heapUsed);
        if (Number.isFinite(free) && free >= 0) body.freeHeap = free;
      } catch { /* optional */ }
      const fw = version ?? snap.fw;
      if (fw) body.fw = clip(fw, 32);
      body.mqttConnected = snap.connected ?? true;
      if (Number.isInteger(snap.configHash)) body.configHash = snap.configHash;
      const uplink = snap.uplink ?? net.uplink;
      if (['wifi', 'ethernet', 'cellular'].includes(uplink)) body.uplink = uplink;

      body.devices = (Array.isArray(snap.devices) ? snap.devices : []).slice(0, MAX_DEVICES).map((d) => {
        const out = { id: clip(d.id, 64) };
        if (d.protocol) out.protocol = clip(d.protocol, 32);
        out.online = d.paused ? true : d.reachable === true;
        if (Number.isFinite(d.lastPollAt) && d.lastPollAt > 0) out.lastPollMs = Math.max(0, Math.floor(now - d.lastPollAt));
        const err = d.lastError || (d.reachable === false ? d.reason : null);
        if (err) out.lastError = clip(err, 256);
        if (Number.isFinite(d.intervalMs)) out.intervalMs = d.intervalMs;
        if (d.paused) out.paused = String(d.paused);
        return out;
      });

      const recent = typeof log.recent === 'function' ? log.recent() : [];
      body.recentLogs = recent.slice(-MAX_RECENT).map(ringText);

      return publisher.gateway('gateway.debug-response', body);
    },

    /**
     * Start the live tail, or re-scope a running one: the mask is replaced and the window
     * extended to 5 minutes from now.
     * @param {number} [cats]  Wire bitmask; `system` is always added.
     */
    startLogs(cats) {
      const m = (Number.isInteger(cats) ? cats & ALL_BITS : DEFAULT_MASK) | CATEGORY_BITS.system;
      const was = streaming;
      if (!was) {
        pending = [];
        dropped = 0;
        untap = log.tap(onLine);
        flushTimer = clock.setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
      }
      mask = m;
      streaming = true;
      until = clock.now() + TAIL_WINDOW_MS;
      tokens = BURST;
      tokensAt = clock.now();
      sysLog.info(`debug log tail ${was ? 'updated' : 'started'} (${maskNames(m)})`);
    },

    stopLogs() {
      if (!streaming) return;
      endTail();
      sysLog.info('debug log tail stopped');
    },

    /** Shutdown / restart: end the tail without announcing it. */
    stop() { endTail(); },

    get tailActive() { return streaming; },

    /** Runs one flush now (tests; the timer does this every second). */
    flush,
  };
}
