// A scriptable driver for scheduler tests. Reads take `duration()` ms of CLOCK time, ignore
// their abort signal (the worst case a real driver can be), and are checked for overlap.

/** Deterministic PRNG so jitter tests are reproducible. */
export function prng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {Object} clock  The fake clock.
 * @param {Object} [opts]
 * @param {(deviceId: string, tags: Object[], reason: string) => number} [opts.duration]
 * @param {(deviceId: string, tags: Object[], reason: string) => Object} [opts.result]  ReadResult
 * @param {boolean} [opts.writable]
 */
export function createFakeDriver(clock, { duration = () => 0, result, writable = true } = {}) {
  const stats = { opens: 0, closes: 0, reads: [], writes: [], overlaps: 0, busy: new Map() };
  let counter = 0;
  const defaultResult = (deviceId, tags) => ({ values: Object.fromEntries(tags.map((t) => [t.name, ++counter])), reachable: true });
  const instance = {
    async open(device) {
      stats.opens++;
      return { id: device.id };
    },
    async read(handle, tags, { reason, signal }) {
      const n = (stats.busy.get(handle.id) || 0) + 1;
      stats.busy.set(handle.id, n);
      if (n > 1) stats.overlaps++;
      const rec = { deviceId: handle.id, at: clock.now(), tags: tags.map((t) => t.name), reason, aborted: false };
      stats.reads.push(rec);
      signal?.addEventListener('abort', () => { rec.aborted = true; });
      const d = duration(handle.id, tags, reason);
      if (d > 0) await new Promise((r) => clock.setTimeout(r, d));
      stats.busy.set(handle.id, stats.busy.get(handle.id) - 1);
      rec.endedAt = clock.now();
      return (result || defaultResult)(handle.id, tags, reason);
    },
    async close() {
      stats.closes++;
    },
  };
  if (writable) {
    instance.write = async (handle, op) => {
      stats.writes.push({ deviceId: handle.id, op });
      return { ok: true, value: op.value };
    };
  }
  const registry = {
    forProtocol: (p) => (p === 'fake' ? instance : null),
    protocols: () => ['fake'],
    capabilities: () => ({ sensorModels: {} }),
  };
  return { instance, registry, stats };
}
