// `host` driver — metrics of the machine the gateway runs on.
//
// conn: {sampleIntervalMs}   tag: {metric}   (a tag without `metric` falls back to its name)
// The metric keys are the ones the Synacl app offers for `host` devices; a key it does not know
// is omitted with a one-time warning. A metric that is unavailable on this machine (no
// temperature sensor, Windows load average, the first network sample) is OMITTED — never
// published as 0, which would read as a real value on a chart. The device is always reachable:
// if the gateway is running, so is its host.

import defaultSi from 'systeminformation';
import defaultOs from 'node:os';
import { defineDriver } from './api.js';

/** @typedef {import('../core/types.js').DriverContext} DriverContext */
/** @typedef {import('../core/types.js').TagSpec} TagSpec */
/** @typedef {import('../core/types.js').ReadResult} ReadResult */

/** Every metric this driver publishes, in the order the app lists them. */
export const HOST_METRICS = Object.freeze([
  { metric: 'cpu.temp', label: 'CPU temperature', unit: '°C', source: 'systeminformation cpuTemperature().main' },
  { metric: 'cpu.load', label: 'CPU load', unit: '%', source: 'systeminformation currentLoad().currentLoad, since the previous sample' },
  { metric: 'load.1m', label: 'Load average (1m)', unit: '', source: 'os.loadavg()[0] (not reported on Windows)' },
  { metric: 'mem.used_pct', label: 'Memory used', unit: '%', source: 'systeminformation mem(): (total − available) / total' },
  { metric: 'disk.used_pct', label: 'Disk used', unit: '%', source: 'systeminformation fsSize(): the filesystem holding host.diskPath' },
  { metric: 'uptime_s', label: 'Uptime', unit: 's', source: 'os.uptime(), whole seconds' },
  { metric: 'net.rx_bps', label: 'Network receive', unit: 'bps', source: 'systeminformation networkStats(default interface).rx_sec × 8' },
  { metric: 'net.tx_bps', label: 'Network transmit', unit: 'bps', source: 'systeminformation networkStats(default interface).tx_sec × 8' },
].map(Object.freeze));

const KNOWN = new Set(HOST_METRICS.map((m) => m.metric));

// Windows reports drives ("C:") as mount points, not "/".
const defaultDiskPath = (os) => (os.platform() === 'win32' ? 'C:' : '/');

const round2 = (v) => Math.round(v * 100) / 100;
// systeminformation reports "unknown" as null on some platforms and -1 on others.
const usable = (v) => typeof v === 'number' && Number.isFinite(v) && v !== -1;

/**
 * Pick the filesystem that holds `path`: an exact mount match, else the longest mount that
 * contains it (so `/home/pi` resolves to `/` and `/data` to its own volume when it has one).
 * @param {Array<{mount?: string}>} list
 * @param {string} path
 */
function fsFor(list, path) {
  if (!Array.isArray(list)) return undefined;
  const exact = list.find((f) => f?.mount === path);
  if (exact) return exact;
  let best;
  for (const f of list) {
    const m = f?.mount;
    if (typeof m !== 'string' || m === '') continue;
    const base = m.endsWith('/') || m.endsWith('\\') ? m.slice(0, -1) : m;
    const inside = m === '/' ? path.startsWith('/') : path === m || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
    if (inside && (!best || m.length > best.mount.length)) best = f;
  }
  return best;
}

/**
 * A reusable sampler. Stateful on purpose: CPU load and network rates are deltas since the
 * previous sample, so keep one sampler per consumer and call `prime()` once before the first
 * `sample()`.
 * @param {{si?: any, os?: any, diskPath?: string, now?: () => number}} [deps]  `diskPath` defaults to
 *   the root filesystem (`/`, or `C:` on Windows); `now` is the clock used for the network warm-up.
 */
export function createHostSampler({ si = defaultSi, os = defaultOs, diskPath, now = Date.now } = {}) {
  diskPath ||= defaultDiskPath(os);
  let iface; // default network interface, resolved lazily and re-resolved if it disappears
  let firstNetAt = null; // when the first network sample was taken
  let netRateSeen = false;

  async function netStats() {
    if (!iface) iface = await si.networkInterfaceDefault();
    if (!iface) return { missing: 'no default network interface' };
    const list = await si.networkStats(iface);
    const s = Array.isArray(list) ? list[0] : list;
    if (!s) {
      const gone = iface;
      iface = undefined; // re-resolve next time: the default route may have moved
      return { missing: `no statistics for interface ${JSON.stringify(String(gone))}` };
    }
    firstNetAt ??= now();
    return { s };
  }

  return {
    /** Take the baselines that delta metrics are measured from. */
    async prime() {
      await Promise.allSettled([si.currentLoad(), netStats()]);
    },

    /**
     * Sample the given metric keys (unknown keys are reported missing).
     * @param {string[]} keys
     * @returns {Promise<{values: Object<string, number>, missing: Object<string, {reason: string, transient?: boolean}>}>}
     */
    async sample(keys) {
      const want = new Set(keys);
      const values = {};
      const missing = {};
      const put = (key, v, why) => {
        if (!want.has(key)) return;
        if (usable(v)) values[key] = key === 'uptime_s' ? Math.floor(v) : round2(v);
        else missing[key] = { reason: why };
      };
      const tryMetric = async (keysHere, fn) => {
        if (!keysHere.some((k) => want.has(k))) return;
        try {
          await fn();
        } catch (err) {
          for (const k of keysHere) if (want.has(k)) missing[k] = { reason: `error reading it: ${err?.message ?? err}` };
        }
      };

      for (const k of want) if (!KNOWN.has(k)) missing[k] = { reason: 'unknown host metric' };

      await Promise.all([
        tryMetric(['cpu.temp'], async () => {
          const t = await si.cpuTemperature();
          put('cpu.temp', t?.main, 'no CPU temperature sensor exposed on this machine');
        }),
        tryMetric(['cpu.load'], async () => {
          const l = await si.currentLoad();
          put('cpu.load', l?.currentLoad, 'CPU load not reported');
        }),
        tryMetric(['load.1m'], async () => {
          if (os.platform() === 'win32') missing['load.1m'] = { reason: 'load average is not reported on Windows' };
          else put('load.1m', os.loadavg()?.[0], 'load average not reported');
        }),
        tryMetric(['mem.used_pct'], async () => {
          const m = await si.mem();
          const ok = usable(m?.total) && m.total > 0 && usable(m?.available);
          put('mem.used_pct', ok ? ((m.total - m.available) / m.total) * 100 : undefined, 'memory figures not reported');
        }),
        tryMetric(['disk.used_pct'], async () => {
          const f = fsFor(await si.fsSize(), diskPath);
          if (!f) {
            missing['disk.used_pct'] = { reason: `no filesystem found for ${diskPath}` };
            return;
          }
          // `use` is what df prints (used / (used + available)); fall back to used/size.
          const pct = usable(f.use) ? f.use : usable(f.used) && usable(f.size) && f.size > 0 ? (f.used / f.size) * 100 : undefined;
          put('disk.used_pct', pct, `no usage figures for ${f.mount}`);
        }),
        tryMetric(['uptime_s'], async () => {
          put('uptime_s', os.uptime(), 'uptime not reported');
        }),
        tryMetric(['net.rx_bps', 'net.tx_bps'], async () => {
          const { s, missing: why } = await netStats();
          // A rate needs two samples, and systeminformation answers from cache for 500 ms, so
          // "no rate yet" is expected for a few seconds after the first sample — only after
          // that is it worth a warning.
          const warmingUp = !netRateSeen && firstNetAt !== null && now() - firstNetAt < 5000;
          for (const [key, field] of [['net.rx_bps', 'rx_sec'], ['net.tx_bps', 'tx_sec']]) {
            if (!want.has(key)) continue;
            if (!s) missing[key] = { reason: why };
            else if (usable(s[field])) {
              values[key] = round2(s[field] * 8); // bytes/s → bits/s
              netRateSeen = true;
            } else missing[key] = warmingUp ? { reason: 'needs a second sample', transient: true } : { reason: 'rate not reported for this interface' };
          }
        }),
      ]);
      return { values, missing };
    },
  };
}

/**
 * What the host driver would publish right now, one row per metric — for the `metrics` CLI.
 * Without a `sampler` a new one is created and primed; pass `settleMs` (e.g. 1000) so the
 * delta metrics (cpu.load, net.*) are real on the first call. For repeated calls, create one
 * sampler, prime it, and pass it in each time.
 * @param {{diskPath?: string, si?: any, os?: any, sampler?: ReturnType<typeof createHostSampler>,
 *   settleMs?: number, clock?: {setTimeout: (fn: () => void, ms: number) => unknown}}} [opts]
 * @returns {Promise<Array<{metric: string, label: string, unit: string, source: string, available: boolean, value?: number, reason?: string}>>}
 */
export async function describeHostMetrics({ diskPath, si, os, sampler, settleMs = 0, clock } = {}) {
  let s = sampler;
  if (!s) {
    s = createHostSampler({ si, os, diskPath });
    await s.prime();
    if (settleMs > 0) {
      const timer = clock ?? { setTimeout: (fn, ms) => setTimeout(fn, ms) };
      await new Promise((resolve) => timer.setTimeout(resolve, settleMs));
    }
  }
  const { values, missing } = await s.sample(HOST_METRICS.map((m) => m.metric));
  return HOST_METRICS.map((m) =>
    m.metric in values
      ? { ...m, available: true, value: values[m.metric] }
      : { ...m, available: false, reason: missing[m.metric]?.reason ?? 'not reported' },
  );
}

/**
 * Build the host driver. `si` and `os` are injectable so tests can run it against stubs.
 * @param {{si?: any, os?: any}} [deps]
 */
export function createHostDriver({ si = defaultSi, os = defaultOs } = {}) {
  return defineDriver({
    apiVersion: 1,
    name: 'host',
    protocols: ['host'],
    capabilities: {},
    /** @param {DriverContext} ctx */
    create(ctx) {
      const diskPath = typeof ctx.options?.diskPath === 'string' && ctx.options.diskPath ? ctx.options.diskPath : undefined;
      const sampler = createHostSampler({ si, os, diskPath, now: () => ctx.clock.now() });
      const warned = new Set();
      let primed = null;
      const warnOnce = (key, msg) => {
        if (warned.has(key)) return;
        warned.add(key);
        ctx.log.warn(msg);
      };

      return {
        async open(device) {
          // CPU load and network rates are deltas: take the baseline now so the first
          // scheduled read reports a real figure rather than an average since boot.
          primed ??= sampler.prime();
          await primed;
          return { deviceId: device.id, closed: false };
        },

        /**
         * @param {{deviceId: string}} handle
         * @param {TagSpec[]} tags
         * @returns {Promise<ReadResult>}
         */
        async read(handle, tags) {
          const metricOf = (tag) => (tag.metric || tag.name || '').trim();
          const { values: sampled, missing } = await sampler.sample([...new Set(tags.map(metricOf))]);
          const values = {};
          const errors = {};
          for (const tag of tags) {
            const key = metricOf(tag);
            if (key in sampled) {
              values[tag.name] = sampled[key];
              continue;
            }
            const why = missing[key] ?? { reason: 'not reported' };
            errors[tag.name] = `${key || '(no metric)'}: ${why.reason}`;
            if (!KNOWN.has(key)) {
              warnOnce(`unknown:${key}`, `host: unknown metric "${key}" on tag "${tag.name}" — known metrics: ${[...KNOWN].join(', ')}`);
            } else if (why.transient) {
              ctx.log.debug(`host: ${key} ${why.reason}; it is published from the next read`);
            } else {
              warnOnce(`missing:${key}`, `host: ${key} is unavailable on this machine (${why.reason}); it is left out of the readings`);
            }
          }
          return { values, errors, reachable: true };
        },

        async close(handle) {
          if (handle) handle.closed = true;
        },
      };
    },
  });
}

/** The built-in host driver. */
export const hostDriver = createHostDriver();
export default hostDriver;
