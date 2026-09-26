// Scripted drivers — deterministic stand-ins for real hardware, so conformance exercises the
// gateway core (scheduling, publishing, commands) and nothing else. Reads take virtual time
// on the injected clock (with optional jitter), values are scripted per device and tag, and
// every call is logged for assertions.

import { createRng } from './memory-transport.js';

/** @typedef {import('../core/types.js').DriverDefinition} DriverDefinition */

/**
 * Shared controls for every scripted driver in one run.
 * @param {{seed?: number, readLatencyMs?: number, readJitterMs?: number}} [opts]
 */
export function createDriverControls({ seed = 7, readLatencyMs = 20, readJitterMs = 0 } = {}) {
  const rng = createRng(seed);
  const state = {
    values: new Map(),        // `${deviceId}/${tag}` -> number | (n) => number | undefined (= cannot read)
    failing: new Map(),       // deviceId -> reason (unreachable)
    latency: new Map(),       // deviceId -> ms
    counts: new Map(),        // deviceId -> reads so far
  };
  const controls = {
    readLatencyMs,
    readJitterMs,
    reads: [],     // {deviceId, tags, reason, startedAt, endedAt, result}
    opens: [],     // {deviceId, at}
    closes: [],    // {deviceId, at}
    writes: [],    // {deviceId, op, at}
    /** Script a tag's value: a number, a function of the read count, or undefined (tag unreadable). */
    setValue(deviceId, tag, v) { state.values.set(`${deviceId}/${tag}`, v); },
    fail(deviceId, reason = 'timeout') { state.failing.set(deviceId, reason); },
    recover(deviceId) { state.failing.delete(deviceId); },
    setLatency(deviceId, ms) { state.latency.set(deviceId, ms); },
    opensOf: (id) => controls.opens.filter((o) => o.deviceId === id).length,
    closesOf: (id) => controls.closes.filter((o) => o.deviceId === id).length,
    readsOf: (id) => controls.reads.filter((r) => r.deviceId === id),
    _latency(deviceId) {
      const base = state.latency.has(deviceId) ? state.latency.get(deviceId) : controls.readLatencyMs;
      return base + (controls.readJitterMs > 0 ? Math.floor(rng() * (controls.readJitterMs + 1)) : 0);
    },
    _value(deviceId, tag) {
      const n = (state.counts.get(deviceId) || 0);
      const k = `${deviceId}/${tag.name}`;
      if (state.values.has(k)) {
        const v = state.values.get(k);
        return typeof v === 'function' ? v(n) : v;
      }
      // Default: a slowly varying, always finite value derived from the tag name.
      let h = 0;
      for (const c of tag.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return Math.round(((h % 500) / 10 + (n % 10) / 10) * 100) / 100;
    },
    _state: state,
  };
  return controls;
}

function sleep(clock, ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error('aborted')); return; }
    const t = clock.setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clock.clearTimeout(t); reject(new Error('aborted')); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * One scripted driver definition.
 * @param {ReturnType<typeof createDriverControls>} controls
 * @param {{name: string, protocols: string[], writable?: boolean, capabilities?: Object}} spec
 * @returns {DriverDefinition}
 */
export function scriptedDriver(controls, { name, protocols, writable = false, capabilities = {} }) {
  return {
    apiVersion: 1,
    name,
    protocols,
    capabilities,
    create(ctx) {
      const clock = ctx.clock;
      const instance = {
        async open(device) {
          controls.opens.push({ deviceId: device.id, at: clock.now() });
          return { id: device.id, protocol: device.protocol, closed: false };
        },
        async read(handle, tags, { reason, signal } = {}) {
          const startedAt = clock.now();
          const entry = { deviceId: handle.id, tags: tags.map((t) => t.name), reason, startedAt, endedAt: null, result: null };
          controls.reads.push(entry);
          await sleep(clock, controls._latency(handle.id), signal);
          controls._state.counts.set(handle.id, (controls._state.counts.get(handle.id) || 0) + 1);
          let result;
          if (controls._state.failing.has(handle.id)) {
            result = { values: {}, reachable: false, reason: controls._state.failing.get(handle.id) };
          } else {
            const values = {};
            const errors = {};
            for (const tag of tags) {
              const v = controls._value(handle.id, tag);
              if (v === undefined) errors[tag.name] = 'no value';
              else values[tag.name] = v;
            }
            result = { values, errors, reachable: true };
          }
          entry.endedAt = clock.now();
          entry.result = result;
          return result;
        },
        async close(handle) {
          if (handle.closed) return;
          handle.closed = true;
          controls.closes.push({ deviceId: handle.id, at: clock.now() });
        },
      };
      if (writable) {
        instance.write = async (handle, op) => {
          controls.writes.push({ deviceId: handle.id, op, at: clock.now() });
          await sleep(clock, controls.readLatencyMs);
          return { ok: true, value: op.value };
        };
      }
      return instance;
    },
  };
}

/**
 * The default conformance driver set: `rs485` (writable, a Modbus-style bus) plus stand-ins
 * for the three built-in protocols, so a scenario can use any of them without real I/O.
 */
export function createScriptedDrivers(controls) {
  return [
    scriptedDriver(controls, { name: 'conformance-host', protocols: ['host'] }),
    scriptedDriver(controls, { name: 'conformance-bridge', protocols: ['mqtt-bridge'] }),
    scriptedDriver(controls, { name: 'conformance-modbus', protocols: ['modbus-tcp', 'rs485'], writable: true, capabilities: { modbusFormats: true } }),
  ];
}
