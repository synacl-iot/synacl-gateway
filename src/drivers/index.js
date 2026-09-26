// The driver registry: which driver serves which protocol for a running gateway.
//
// Built-ins register first, then the packages listed in config.json `drivers`, then any
// `extra` definitions handed in programmatically (tests, `conformance --driver`). A later
// driver for a protocol replaces an earlier one, with a warning. Third-party drivers are
// loaded in-process with full trust — they are code the operator chose to install.
//
// Every instance handed out is wrapped so the core can rely on the contract even when a
// third-party driver is sloppy: handles are tracked (closeAll works), read results are
// reduced to finite numbers/booleans/strings for the requested tags only, reasons are capped
// at 128 characters, and a throwing read/status/write becomes a failed result.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDriverDefinition } from './api.js';
import { hostDriver } from './host.js';
import { mqttBridgeDriver } from './mqtt-bridge.js';
import { modbusTcpDriver } from './modbus-tcp.js';

export { defineDriver, DriverError, apiVersion, validateDriverDefinition } from './api.js';
export { hostDriver, createHostDriver, describeHostMetrics, createHostSampler, HOST_METRICS } from './host.js';
export { mqttBridgeDriver, createMqttBridgeDriver } from './mqtt-bridge.js';
export { modbusTcpDriver, createModbusTcpDriver } from './modbus-tcp.js';

/** @typedef {import('../core/types.js').DriverDefinition} DriverDefinition */
/** @typedef {import('../core/types.js').DriverInstance} DriverInstance */
/** @typedef {import('../core/types.js').DriverRegistry} DriverRegistry */
/** @typedef {import('../core/types.js').FileConfig} FileConfig */
/** @typedef {import('../core/types.js').Logger} Logger */
/** @typedef {import('../core/types.js').Clock} Clock */

/** The drivers every gateway has, in registration order. */
export const BUILTIN_DRIVERS = Object.freeze([hostDriver, mqttBridgeDriver, modbusTcpDriver]);

// Which FileConfig section each built-in receives as ctx.options.
const BUILTIN_OPTIONS = { host: 'host', 'mqtt-bridge': 'bridge' };

const REASON_MAX = 128;
const cap = (s, n = REASON_MAX) => (typeof s === 'string' ? s : String(s ?? '')).slice(0, n);
const okValue = (v) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || typeof v === 'string';
const errMessage = (err) => err?.reason ?? err?.message ?? String(err);

/**
 * Resolve a package's ESM entry from its directory: exports (".", then the import/node/default
 * conditions), then main, then index.js. Enough for driver packages; not a full resolver.
 * @param {string} dir
 * @returns {string}
 */
function packageEntry(dir) {
  const pkgFile = join(dir, 'package.json');
  if (!existsSync(pkgFile)) {
    const idx = join(dir, 'index.js');
    if (existsSync(idx)) return idx;
    throw new Error(`no package.json or index.js in ${dir}`);
  }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const pick = (target) => {
    if (typeof target === 'string') return target;
    if (Array.isArray(target)) {
      for (const t of target) {
        const r = pick(t);
        if (r) return r;
      }
      return undefined;
    }
    if (target && typeof target === 'object') {
      if ('.' in target) return pick(target['.']);
      for (const cond of ['import', 'node', 'default', 'require']) if (cond in target) return pick(target[cond]);
    }
    return undefined;
  };
  const rel = pick(pkg.exports) ?? pkg.main ?? 'index.js';
  return join(dir, rel);
}

/**
 * Find the file to import for a `config.drivers` entry.
 * Paths (absolute, or ./ ../ relative to the gateway home) may name a file or a package
 * directory. Names are resolved from the drivers directory — `npm i --prefix <driverDir> <pkg>`
 * — because a globally installed gateway cannot see sibling global packages.
 * @param {string} spec
 * @param {{driverDir: string, home: string}} where
 * @returns {string} absolute file path
 */
export function resolveDriverSpec(spec, { driverDir, home }) {
  if (isAbsolute(spec) || spec.startsWith('./') || spec.startsWith('../')) {
    const p = resolvePath(home, spec);
    if (!existsSync(p)) throw new Error(`${p} does not exist`);
    return statSync(p).isDirectory() ? packageEntry(p) : p;
  }
  const req = createRequire(join(driverDir, 'package.json'));
  try {
    return req.resolve(spec);
  } catch (err) {
    // createRequire resolves with the "require" condition; an ESM-only package that exports
    // only "import" fails there, so look for the package directory ourselves.
    for (const base of req.resolve.paths(spec) ?? []) {
      const dir = join(base, spec);
      if (existsSync(join(dir, 'package.json'))) return packageEntry(dir);
    }
    throw new Error(`cannot find package "${spec}" under ${driverDir} (install it with: npm i --prefix ${driverDir} ${spec})`, { cause: err });
  }
}

/**
 * Import a driver package and return its definition (the default export, or `driver`).
 * @param {string} spec
 * @param {{driverDir: string, home: string}} where
 * @returns {Promise<{def: DriverDefinition, file: string}>}
 */
export async function loadDriverPackage(spec, where) {
  const file = resolveDriverSpec(spec, where);
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    // A driver resolves `synacl-gateway/driver` from where IT is installed, and a globally
    // installed gateway is not visible from there: npm installs it as the driver's peer
    // dependency, unless peers were omitted.
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /synacl-gateway/.test(err.message)) {
      throw new Error(`it imports synacl-gateway, which is not installed next to it (run: npm i --prefix ${where.driverDir} synacl-gateway)`, { cause: err });
    }
    // Node before 22 reads a .js file as CommonJS unless its package says "type": "module".
    if (err instanceof SyntaxError && /\b(export|import)\b/.test(err.message) && file.endsWith('.js')) {
      throw new Error(`${err.message} — ${file} is an ES module: name it .mjs or add "type": "module" to its package.json`, { cause: err });
    }
    throw err;
  }
  const def = mod?.default ?? mod?.driver;
  return { def, file };
}

/** Category for a driver's log lines: Modbus drivers under `modbus`, everything else `sensors`. */
function categoryFor(def) {
  return def.protocols.some((p) => /modbus|rs485/i.test(p)) ? 'modbus' : 'sensors';
}

/**
 * Wrap a driver instance so the core can rely on the contract (see the header comment).
 * @param {string} name
 * @param {DriverInstance} inst
 * @param {Logger} log
 */
function guardInstance(name, inst, log) {
  /** @type {Map<object, unknown>} wrapper handle → the driver's own handle */
  const handles = new Map();

  const sanitizeRead = (res, tags) => {
    const wanted = new Set(tags.map((t) => t.name));
    const values = {};
    for (const [k, v] of Object.entries(res?.values ?? {})) if (wanted.has(k) && okValue(v)) values[k] = v;
    /** @type {import('../core/types.js').ReadResult} */
    const out = { values, reachable: res?.reachable === undefined ? true : Boolean(res.reachable) };
    if (res?.reason !== undefined && res.reason !== null && res.reason !== '') out.reason = cap(res.reason);
    if (res?.errors && typeof res.errors === 'object') {
      const errors = {};
      for (const [k, v] of Object.entries(res.errors)) if (typeof v === 'string') errors[k] = cap(v, 256);
      if (Object.keys(errors).length) out.errors = errors;
    }
    return out;
  };

  const own = (h) => {
    if (!handles.has(h)) throw new Error(`${name}: unknown or closed device handle`);
    return handles.get(h);
  };

  /** @type {DriverInstance & {closeAll: () => Promise<void>, openCount: () => number}} */
  const wrapped = {
    async open(device) {
      const inner = await inst.open(device);
      // Our own handle object: the driver's may be a primitive shared by several devices.
      const h = Object.freeze({ driver: name, deviceId: device.id });
      handles.set(h, inner);
      return h;
    },
    async read(h, tags, opts) {
      try {
        return sanitizeRead(await inst.read(own(h), tags, opts), tags);
      } catch (err) {
        return { values: {}, reachable: false, reason: cap(errMessage(err)) };
      }
    },
    async close(h) {
      if (!handles.has(h)) return; // idempotent
      const inner = handles.get(h);
      handles.delete(h);
      try {
        await inst.close(inner);
      } catch (err) {
        log.warn(`driver ${name}: close failed: ${err?.message ?? err}`);
      }
    },
    async closeAll() {
      await Promise.allSettled([...handles.keys()].map((h) => wrapped.close(h)));
    },
    openCount: () => handles.size,
  };
  // Optional methods stay absent when the driver lacks them: the core tests for their presence
  // (no write() ⇒ "writes are not supported for protocol …", no status() ⇒ pull-style).
  if (typeof inst.write === 'function') {
    wrapped.write = async (h, op) => {
      try {
        const r = await inst.write(own(h), op);
        const out = { ok: Boolean(r?.ok) };
        if (typeof r?.value === 'number' && Number.isFinite(r.value)) out.value = r.value;
        if (r?.error !== undefined) out.error = cap(r.error, 256);
        else if (!out.ok) out.error = 'write failed';
        return out;
      } catch (err) {
        return { ok: false, error: cap(errMessage(err), 256) };
      }
    };
  }
  if (typeof inst.status === 'function') {
    wrapped.status = (h) => {
      try {
        const s = inst.status(own(h));
        const out = { reachable: Boolean(s?.reachable) };
        if (s?.reason) out.reason = cap(s.reason);
        return out;
      } catch (err) {
        return { reachable: false, reason: cap(errMessage(err)) };
      }
    };
  }
  return wrapped;
}

/**
 * Build the registry for a running gateway.
 * @param {{config?: Partial<FileConfig>, home?: string, log: Logger, clock: Clock, signal?: AbortSignal,
 *   builtins?: readonly DriverDefinition[], extra?: readonly DriverDefinition[]}} opts
 * @returns {Promise<DriverRegistry & {
 *   drivers: () => Array<{name: string, protocols: string[], source: string}>,
 *   loadErrors: () => Array<{spec: string, error: string}>}>}
 */
export async function createDriverRegistry({ config = {}, home, log, clock, signal, builtins = BUILTIN_DRIVERS, extra = [] }) {
  const gatewayHome = home ?? join(homedir(), '.synacl-gateway');
  const driverDir = config.driverDir || join(gatewayHome, 'drivers');
  const baseLog = log;

  /** @type {Array<{def: DriverDefinition, source: string, instance: any, failed: boolean}>} */
  const entries = [];
  /** @type {Map<string, (typeof entries)[number]>} */
  const byProtocol = new Map();
  const errors = [];

  const register = (def, source) => {
    const problems = validateDriverDefinition(def);
    if (problems.length) {
      const name = def && typeof def.name === 'string' ? `"${def.name}"` : `from ${source}`;
      const msg = `driver ${name} refused: ${problems.join('; ')}`;
      baseLog.error(msg);
      errors.push({ spec: source, error: msg });
      return;
    }
    const entry = { def, source, instance: null, failed: false };
    entries.push(entry);
    for (const p of def.protocols) {
      const prev = byProtocol.get(p);
      if (prev && prev.def !== def) {
        baseLog.warn(`driver "${def.name}" (${source}) replaces "${prev.def.name}" (${prev.source}) for protocol "${p}"`);
      }
      byProtocol.set(p, entry);
    }
  };

  for (const def of builtins) register(def, 'builtin');
  for (const spec of Array.isArray(config.drivers) ? config.drivers : []) {
    if (typeof spec !== 'string' || spec.trim() === '') {
      errors.push({ spec: String(spec), error: 'driver entries must be package names or paths' });
      baseLog.error(`config.json drivers: ignoring ${JSON.stringify(spec)} (expected a package name or a path)`);
      continue;
    }
    try {
      const { def } = await loadDriverPackage(spec, { driverDir, home: gatewayHome });
      register(def, spec);
    } catch (err) {
      const msg = `driver "${spec}" not loaded: ${err?.message ?? err}`;
      baseLog.error(msg);
      errors.push({ spec, error: msg });
    }
  }
  for (const def of extra) register(def, 'extra');

  const serving = () => entries.filter((e) => [...byProtocol.values()].includes(e));

  // Instances are created on first use, so a built-in that no configured device needs (or
  // that a package replaced) costs nothing.
  const instanceFor = (entry) => {
    if (entry.instance || entry.failed) return entry.instance;
    const { def } = entry;
    const scoped = typeof baseLog.child === 'function' ? baseLog.child(categoryFor(def)) : baseLog;
    const optionsKey = entry.source === 'builtin' ? BUILTIN_OPTIONS[def.name] : undefined;
    const options = (optionsKey ? config[optionsKey] : config.driverOptions?.[def.name]) ?? {};
    const dataDir = join(gatewayHome, 'driver-data', def.name.replace(/[^A-Za-z0-9._-]+/g, '_'));
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      scoped.warn(`driver ${def.name}: cannot create its data directory ${dataDir}: ${err?.message ?? err}`);
    }
    try {
      const inst = def.create({
        log: scoped,
        clock,
        gatewayId: config.gateway ?? '',
        dataDir,
        signal: signal ?? new AbortController().signal,
        options: { ...options },
      });
      if (!inst || typeof inst.open !== 'function' || typeof inst.read !== 'function' || typeof inst.close !== 'function') {
        throw new Error('create() must return {open, read, close}');
      }
      entry.instance = guardInstance(def.name, inst, scoped);
    } catch (err) {
      entry.failed = true;
      const msg = `driver ${def.name}: create() failed: ${err?.message ?? err}`;
      baseLog.error(msg);
      errors.push({ spec: entry.source, error: msg });
    }
    return entry.instance;
  };

  return {
    protocols: () => [...byProtocol.keys()],
    forProtocol(protocol) {
      const entry = byProtocol.get(protocol);
      return entry ? instanceFor(entry) : null;
    },
    capabilities() {
      let modbusFormats = false;
      /** @type {Object<string, string[]>} */
      const sensorModels = {};
      for (const { def } of serving()) {
        if (def.capabilities?.modbusFormats === true) modbusFormats = true;
        for (const [bus, models] of Object.entries(def.capabilities?.sensorModels ?? {})) {
          sensorModels[bus] = [...new Set([...(sensorModels[bus] ?? []), ...models])];
        }
      }
      return { modbusFormats, sensorModels };
    },
    async closeAll() {
      await Promise.allSettled(entries.filter((e) => e.instance).map((e) => e.instance.closeAll()));
    },
    drivers: () => serving().map((e) => ({ name: e.def.name, protocols: e.def.protocols.filter((p) => byProtocol.get(p) === e), source: e.source })),
    loadErrors: () => errors.map((e) => ({ ...e })),
  };
}

export default createDriverRegistry;
