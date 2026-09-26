// Driver contract harness — exported as `synacl-gateway/testing`.
//
// Checks a DriverDefinition against the plugin API (apiVersion 1) the way the gateway core
// relies on it: the definition's shape, what `read` may return (finite values only, a tag that
// could not be read is ABSENT, a short reason), that `close` is idempotent, that a read honours
// its abort signal, and that connection secrets never reach a log line.
//
//   import { assertDriver } from 'synacl-gateway/testing';
//   test('my driver honours the contract', () => assertDriver(myDriver, { device: { conn: {...}, tags: [...] } }));

import { AssertionError } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryLogger, linesContaining } from './memory-log.js';

export { createMemoryLogger };

/** @typedef {import('../core/types.js').DriverDefinition} DriverDefinition */
/** @typedef {import('../core/types.js').DeviceSpec} DeviceSpec */
/** @typedef {import('../core/types.js').WriteOp} WriteOp */

const SECRET_KEY = /pass|secret|token|key/i;

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

/** Fill a tag with the documented defaults (what the core hands a driver). */
export function tagSpec(tag) {
  const t = typeof tag === 'string' ? { name: tag } : { ...tag };
  return {
    isIntervalRead: true, scaleFactor: 1, offset: 0, thresholdStart: 0, thresholdEnd: 0,
    mbAddress: 0, registerType: 'holding', mbFormat: 'u16', mbWordOrder: 'big',
    metric: '', topic: '', cmdTopic: '', jsonPath: '',
    ...t,
    raw: t.raw || { ...t },
  };
}

/** A full DeviceSpec from a partial one. */
export function deviceSpec(def, partial = {}) {
  const conn = partial.conn || {};
  const tags = (partial.tags || [{ name: 'value' }]).map(tagSpec);
  const spec = {
    id: partial.id || '64b7a1000000000000000002',
    protocol: partial.protocol || (def && Array.isArray(def.protocols) ? def.protocols[0] : 'unknown'),
    conn,
    tags,
    intervalMs: partial.intervalMs || 10_000,
    readIntervalMs: partial.readIntervalMs || 0,
  };
  spec.fingerprint = JSON.stringify({ protocol: spec.protocol, conn: spec.conn, tags: spec.tags.map((t) => t.raw) });
  spec.raw = { _id: spec.id, protocol: spec.protocol, conn: spec.conn, tags: spec.tags.map((t) => t.raw) };
  return spec;
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms); }),
  ]);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const describe = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

/** Problems with a ReadResult, or [] when it honours the contract. */
export function readResultProblems(result, tags) {
  const p = [];
  if (!isPlainObject(result)) return [`read() must resolve to an object (got ${describe(result)})`];
  if (!isPlainObject(result.values)) p.push('`values` must be an object');
  else {
    const names = new Set(tags.map((t) => t.name));
    for (const [k, v] of Object.entries(result.values)) {
      if (typeof v === 'number' && !Number.isFinite(v)) p.push(`values.${k} is ${v}: a tag that could not be read must be ABSENT, never NaN/Infinity`);
      else if (!['number', 'boolean', 'string'].includes(typeof v)) p.push(`values.${k} is ${v === null ? 'null' : typeof v}: only finite numbers, booleans and strings (the platform drops a whole message containing a null)`);
      if (!names.has(k)) p.push(`values.${k} was not requested (asked for ${[...names].join(', ')})`);
    }
  }
  if (typeof result.reachable !== 'boolean') p.push('`reachable` must be a boolean');
  if (result.reason !== undefined && (typeof result.reason !== 'string' || result.reason.length > 128)) p.push('`reason` must be a string of at most 128 characters');
  if (result.errors !== undefined && (!isPlainObject(result.errors) || Object.values(result.errors).some((e) => typeof e !== 'string'))) p.push('`errors` must map tag names to strings');
  return p;
}

/**
 * Run the contract checks.
 * @param {DriverDefinition|{default: DriverDefinition}} defOrModule
 * @param {{device?: Partial<DeviceSpec>, options?: Object, secrets?: string[], timeoutMs?: number, reads?: number, write?: WriteOp}} [opts]
 * @returns {Promise<{ok: boolean, name: string, checks: {id: string, ok: boolean, message: string}[], logs: import('../core/types.js').LogLine[]}>}
 */
export async function testDriver(defOrModule, opts = {}) {
  const def = defOrModule && typeof defOrModule === 'object' && 'default' in defOrModule && !('apiVersion' in defOrModule) ? defOrModule.default : defOrModule;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const checks = [];
  const check = (id, ok, message) => { checks.push({ id, ok: !!ok, message }); return !!ok; };
  const log = createMemoryLogger({ level: 'debug' });
  const name = def && typeof def.name === 'string' ? def.name : '(unnamed)';
  const finish = () => ({ ok: checks.every((c) => c.ok), name, checks, logs: log.lines });

  // ── shape ──
  const shape = [];
  if (!isPlainObject(def)) shape.push('the module must export a driver definition (default export)');
  else {
    if (typeof def.name !== 'string' || !def.name) shape.push('`name` must be a non-empty string');
    if (!Array.isArray(def.protocols) || !def.protocols.length || def.protocols.some((x) => typeof x !== 'string' || !x)) shape.push('`protocols` must be a non-empty array of strings');
    if (typeof def.create !== 'function') shape.push('`create(ctx)` must be a function');
    if (def.capabilities !== undefined && !isPlainObject(def.capabilities)) shape.push('`capabilities` must be an object when present');
    try {
      const api = await import('../drivers/api.js');
      if (typeof api.validateDriverDefinition === 'function') for (const x of api.validateDriverDefinition(def)) if (!shape.includes(x)) shape.push(x);
    } catch { /* the gateway's own validator is optional here */ }
  }
  check('shape', shape.length === 0, shape.length ? shape.join('; ') : 'definition has name, protocols, create and (optional) capabilities');
  check('api-version', def && def.apiVersion === 1, `apiVersion must be 1 (got ${describe(def && def.apiVersion)})`);
  if (!isPlainObject(def) || typeof def.create !== 'function') return finish();

  const device = deviceSpec(def, opts.device);
  const secrets = [...(opts.secrets || [])];
  for (const [k, v] of Object.entries(device.conn)) if (SECRET_KEY.test(k) && typeof v === 'string' && v.length >= 4) secrets.push(v);

  const dataDir = mkdtempSync(join(tmpdir(), 'synacl-driver-harness-'));
  const ctl = new AbortController();
  let inst;
  try {
    try {
      inst = def.create({ log: log.child('sensors'), clock: realClock, gatewayId: 'conformance-gw', dataDir, signal: ctl.signal, options: opts.options || {} });
    } catch (err) {
      check('create', false, `create(ctx) threw: ${err && err.message}`);
      return finish();
    }
    const missing = ['open', 'read', 'close'].filter((m) => !inst || typeof inst[m] !== 'function');
    const badOptional = ['write', 'status'].filter((m) => inst && inst[m] !== undefined && typeof inst[m] !== 'function');
    if (!check('create', missing.length === 0 && badOptional.length === 0, missing.length || badOptional.length
      ? `create(ctx) must return {open, read, close} functions (+ optional write, status); missing ${missing.join(', ') || '-'}${badOptional.length ? `, not functions: ${badOptional.join(', ')}` : ''}`
      : 'create(ctx) returned an instance with open, read and close')) return finish();

    let handle;
    try {
      handle = await withTimeout(inst.open(device), timeoutMs, 'open(device)');
      check('open', true, 'open(device) resolved');
    } catch (err) {
      check('open', false, `open(device) failed: ${err && err.message}`);
      return finish();
    }

    const reads = opts.reads ?? 2;
    for (let i = 1; i <= reads; i++) {
      try {
        const res = await withTimeout(inst.read(handle, device.tags, { reason: i === 1 ? 'interval' : 'once', signal: new AbortController().signal }), timeoutMs, 'read()');
        const p = readResultProblems(res, device.tags);
        check(`read.${i}`, p.length === 0, p.length ? p.join('; ') : `read ${i} returned a valid result (${describe(res.values)})`);
      } catch (err) {
        // A read may reject (the core treats it as unreachable), but it must not hang.
        check(`read.${i}`, !/did not settle/.test(String(err && err.message)), `read() rejected: ${err && err.message}`);
      }
    }

    // A read of a single tag must return nothing but that tag.
    try {
      const one = device.tags.slice(0, 1);
      const res = await withTimeout(inst.read(handle, one, { reason: 'once', signal: new AbortController().signal }), timeoutMs, 'read([tag])');
      const extra = isPlainObject(res && res.values) ? Object.keys(res.values).filter((k) => k !== one[0].name) : [];
      check('read-tags', extra.length === 0, extra.length ? `read([${one[0].name}]) also returned ${extra.join(', ')}` : 'a single-tag read returns only that tag');
    } catch (err) {
      check('read-tags', !/did not settle/.test(String(err && err.message)), `read([tag]) rejected: ${err && err.message}`);
    }

    // Abort: an aborted read must settle promptly — shutdown waits on it.
    {
      const ac = new AbortController();
      const p = inst.read(handle, device.tags, { reason: 'interval', signal: ac.signal });
      ac.abort();
      try { await withTimeout(p.catch(() => {}), timeoutMs, 'an aborted read'); check('abort', true, 'an aborted read settles'); } catch (err) { check('abort', false, err.message); }
    }

    if (opts.write && typeof inst.write === 'function') {
      try {
        const r = await withTimeout(inst.write(handle, opts.write), timeoutMs, 'write()');
        const ok = isPlainObject(r) && typeof r.ok === 'boolean' && (r.value === undefined || (typeof r.value === 'number' && Number.isFinite(r.value))) && (r.error === undefined || typeof r.error === 'string');
        check('write', ok, ok ? `write() returned ${describe(r)}` : `write() must resolve to {ok: boolean, value?: finite number, error?: string} (got ${describe(r)})`);
      } catch (err) {
        check('write', false, `write() rejected: ${err && err.message}`);
      }
    }

    if (typeof inst.status === 'function') {
      try {
        const s = inst.status(handle);
        const ok = isPlainObject(s) && typeof s.reachable === 'boolean' && (s.reason === undefined || (typeof s.reason === 'string' && s.reason.length <= 128));
        check('status', ok, ok ? 'status() returns {reachable, reason?}' : `status() must return {reachable: boolean, reason?: string ≤128} (got ${describe(s)})`);
      } catch (err) {
        check('status', false, `status() threw: ${err && err.message}`);
      }
    }

    try {
      await withTimeout(inst.close(handle), timeoutMs, 'close()');
      check('close', true, 'close() resolved');
    } catch (err) {
      check('close', false, `close() failed: ${err && err.message}`);
    }
    try {
      await withTimeout(inst.close(handle), timeoutMs, 'a second close()');
      check('close-idempotent', true, 'close() may be called twice');
    } catch (err) {
      check('close-idempotent', false, `close() must be idempotent: ${err && err.message}`);
    }
  } finally {
    ctl.abort();
    rmSync(dataDir, { recursive: true, force: true });
  }

  const leaks = linesContaining(log, secrets);
  check('secrets', leaks.length === 0, leaks.length ? `a connection secret appeared in a log line: "${leaks[0].msg.slice(0, 160)}" — call ctx.log.redact(secret) before logging anything that may contain it` : `no connection secret appeared in ${log.lines.length} log line(s)`);
  return finish();
}

/** testDriver, throwing an AssertionError that lists every failed check. For node:test. */
export async function assertDriver(defOrModule, opts) {
  const r = await testDriver(defOrModule, opts);
  if (!r.ok) {
    const failed = r.checks.filter((c) => !c.ok).map((c) => `  ✗ ${c.id}: ${c.message}`).join('\n');
    throw new AssertionError({ message: `driver "${r.name}" does not honour the driver contract:\n${failed}` });
  }
  return r;
}
