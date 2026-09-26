// Presence: the gateway heartbeat and each device's retained reachability.
//
// Heartbeat — `status`, retained, QoS 0, every 60 s. It deliberately carries NO `ts`: the
// platform then stamps it with its own clock, so a gateway with a wrong clock can never look
// stale against the platform's 180 s staleness check.
//
// Device status — `devices/{id}/status`, retained, `{ts, reachable, reason?}`. The platform
// marks a device offline 90 s after it was last seen, so every device is republished at least
// every 30 s (on its own phase, so a big gateway doesn't send them all in one burst) and
// immediately on any reachability change. A paused device still reports reachable: the user
// paused its reads, the device itself is fine.

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';

/** @typedef {import('./types.js').Clock} Clock */
/** @typedef {import('./types.js').Logger} Logger */

export const HEARTBEAT_MS = 60000;
export const STATUS_MS = 30000;
/** How often a quiet presence loop re-reads the device list to pick up new devices. */
const RECONCILE_MS = 5000;

const HEARTBEAT_KEYS = ['ip', 'fw', 'rssi', 'uplink', 'ethIp', 'bufRam', 'bufFlash', 'bufDropped', 'flashErrors', 'flashWearPct', 'simMode'];
const COUNTER_KEYS = new Set(['bufRam', 'bufFlash', 'bufDropped', 'flashErrors']);
const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|vmnet|vboxnet|utun|tun|tap|wg|zt|tailscale|awdl|llw|bridge|gif|stf|anpi|ap\d)/i;

/**
 * The IPv4 address of the interface that carries the default route, and whether that
 * interface is Wi-Fi or wired. Linux reads the routing table; elsewhere the first physical-
 * looking interface with an IPv4 address is used and `uplink` is left out.
 * @returns {{ip?: string, uplink?: 'wifi'|'ethernet', iface?: string}}
 */
export function detectNet({ fsRead = readFileSync, fsExists = existsSync, interfaces = os.networkInterfaces, platform = process.platform } = {}) {
  let ifaces;
  try { ifaces = interfaces() || {}; } catch { return {}; }
  const v4 = (name) => (ifaces[name] || []).find((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal)?.address;

  if (platform === 'linux') {
    try {
      const routes = fsRead('/proc/net/route', 'utf8').split('\n').slice(1);
      let best = null;
      for (const line of routes) {
        const [iface, dest, , , , , metric] = line.trim().split(/\s+/);
        if (dest !== '00000000' || !iface) continue;
        const m = Number(metric) || 0;
        if (!best || m < best.metric) best = { iface, metric: m };
      }
      if (best) {
        const ip = v4(best.iface);
        let uplink;
        if (fsExists(`/sys/class/net/${best.iface}/wireless`)) uplink = 'wifi';
        else if (fsExists(`/sys/class/net/${best.iface}/device`)) uplink = 'ethernet';
        return { ...(ip ? { ip } : {}), ...(uplink ? { uplink } : {}), iface: best.iface };
      }
    } catch { /* no procfs (container sandbox): fall through to the heuristic */ }
  }
  for (const name of Object.keys(ifaces)) {
    if (VIRTUAL_IFACE.test(name)) continue;
    const ip = v4(name);
    if (ip) return { ip, iface: name };
  }
  return {};
}

/**
 * @param {Object} deps
 * @param {{gateway(name: string, body: Object, opts?: Object): Promise<boolean|void>,
 *          deviceStatus(id: string, s: {reachable: boolean, reason?: string}): Promise<boolean|void>}} deps.publisher
 * @param {Clock} deps.clock
 * @param {() => Array<{id: string, reachable: boolean|null, reason?: string|null, paused?: unknown}>} deps.getDevices
 * @param {() => Object} [deps.getHeartbeatExtras]  {fw?, bufRam, bufFlash, bufDropped, flashErrors, simMode}
 * @param {string} [deps.version]  Reported as `fw` unless the extras carry one.
 * @param {() => {ip?: string, uplink?: string}} [deps.netInfo]  Defaults to detectNet().
 * @param {Logger} [deps.log]
 */
export function createPresence({ publisher, clock, getDevices, getHeartbeatExtras, version, netInfo = detectNet, log }) {
  let running = false;
  let hbTimer = null;
  let stTimer = null;
  /** deviceId → next due time for its periodic status */
  const due = new Map();

  function heartbeatBody() {
    let net = {};
    try { net = netInfo() || {}; } catch { /* keep the heartbeat going without an address */ }
    let extras = {};
    try { extras = getHeartbeatExtras?.() || {}; } catch (err) { log?.debug('heartbeat extras failed', { err }); }
    const merged = { ...net, ...(version ? { fw: version } : {}), ...extras };
    const body = { online: true };
    for (const k of HEARTBEAT_KEYS) {
      const v = merged[k];
      if (v === undefined || v === null) continue;
      if (COUNTER_KEYS.has(k)) { if (Number.isFinite(v)) body[k] = Math.max(0, Math.floor(v)); continue; }
      if (k === 'simMode') { if (typeof v === 'boolean') body[k] = v; continue; }
      if (k === 'uplink' && !['wifi', 'ethernet', 'cellular'].includes(v)) continue;
      body[k] = v;
    }
    // A counter the extras forgot still has to be reported, or the app shows stale buffer health.
    for (const k of COUNTER_KEYS) if (!(k in body)) body[k] = 0;
    return body;
  }

  async function heartbeatNow() {
    const sent = await publisher.gateway('gateway.status', heartbeatBody(), { qos: 0, retain: true });
    if (running) armHeartbeat();
    return sent;
  }

  function armHeartbeat() {
    if (hbTimer) clock.clearTimeout(hbTimer);
    hbTimer = clock.setTimeout(() => { hbTimer = null; heartbeatNow().catch((err) => log?.warn('heartbeat failed', { err })); }, HEARTBEAT_MS);
  }

  function effective(d) {
    if (d.paused) return { reachable: true };
    if (d.reachable === null || d.reachable === undefined) return null;
    return d.reachable ? { reachable: true } : { reachable: false, ...(d.reason ? { reason: String(d.reason) } : {}) };
  }

  function publishStatus(d) {
    const s = effective(d);
    if (!s) return;
    publisher.deviceStatus(d.id, s).catch((err) => log?.debug('device status failed', { err }));
  }

  function listDevices() {
    try { return getDevices() || []; } catch (err) { log?.warn('device list unavailable', { err }); return []; }
  }

  function statusLoop() {
    stTimer = null;
    if (!running) return;
    const now = clock.now();
    const devices = listDevices();
    const ids = new Set(devices.map((d) => d.id));
    for (const id of [...due.keys()]) if (!ids.has(id)) due.delete(id);

    // Newcomers get a phase spread across one status period.
    const fresh = devices.filter((d) => !due.has(d.id));
    fresh.forEach((d, k) => due.set(d.id, now + Math.round(((k + 1) / (fresh.length + 1)) * STATUS_MS)));

    let next = now + RECONCILE_MS;
    for (const d of devices) {
      let t = due.get(d.id);
      if (t <= now) {
        publishStatus(d);
        t = now + STATUS_MS;
        due.set(d.id, t);
      }
      if (t < next) next = t;
    }
    stTimer = clock.setTimeout(statusLoop, Math.max(1, next - now));
  }

  return {
    heartbeatNow,

    /** Begin the periodic heartbeat and device statuses (the caller sends the first heartbeat). */
    start() {
      if (running) return;
      running = true;
      armHeartbeat();
      statusLoop();
    },

    stop() {
      running = false;
      if (hbTimer) clock.clearTimeout(hbTimer);
      if (stTimer) clock.clearTimeout(stTimer);
      hbTimer = stTimer = null;
      due.clear();
    },

    /**
     * A device's reachability changed: publish now, and restart its 30 s period from here.
     * Ignored while stopped (offline); the next start() republishes every device.
     */
    transition(deviceId, { reachable, reason } = {}) {
      if (!running) return;
      const d = listDevices().find((x) => x.id === deviceId) || { id: deviceId, reachable, reason };
      publishStatus({ ...d, reachable, reason });
      due.set(deviceId, clock.now() + STATUS_MS);
    },

    /** The graceful-shutdown message: `{"online":false}`, retained, QoS 1 (resolves on PUBACK). */
    goodbye() {
      return publisher.gateway('gateway.status', { online: false }, { qos: 1, retain: true });
    },

    /** For tests and diagnostics. */
    heartbeatBody,
  };
}
