// Everything the CLI takes in — argv flags, environment, config.json — parsed and validated in
// one place, so `init`, `run`, `status`, `metrics` and `doctor` agree on what a valid identity is.
//
// A rule that runs through this file: the app's one-liner carries the broker password on the
// command line, so no message built here ever echoes a value the user typed. Node's own
// messages are not trusted for that (parseArgs quotes stray positionals, and V8's JSON.parse
// quotes the source text) — they are replaced with our own wording.

/** @typedef {import('../core/types.js').FileConfig} FileConfig */

import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';

/** Exit codes, as frozen in src/core/types.js (CliCommand). */
export const EXIT = Object.freeze({ OK: 0, RUNTIME: 1, USAGE: 2, CONNECT: 3, CONFORMANCE: 4, DOCTOR: 5, LOCKED: 6 });

export const TENANT_RE = /^[0-9a-f]{24}$/i;
/** Same rule as the app's chip-id check: MQTT wildcards and `/` would break the topic tree. */
export const GATEWAY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,63}$/;
/** A deployment without a public MQTT hostname prints `mqtt://:1883`; `new URL` throws on it. */
export const EMPTY_HOST_RE = /^(mqtts?|wss?):\/\/:(\d+)/i;
/** The platform generates 24 base62 characters; anything else is probably a copy/paste accident. */
export const PASSWORD_RE = /^[A-Za-z0-9]{24}$/;
export const BROKER_SCHEMES = Object.freeze(['mqtt', 'mqtts', 'ws', 'wss']);

export class UsageError extends Error {
  /** @param {string} message @param {{hint?: string, code?: string}} [opts] */
  constructor(message, { hint, code } = {}) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = EXIT.USAGE;
    if (hint) this.hint = hint;
    if (code) this.code = code;
  }
}

/**
 * util.parseArgs in strict mode, with `--help/-h` added and parse errors rewritten so they
 * never quote an argument value.
 * @param {string[]} argv
 * @param {Object} options  parseArgs option descriptors.
 * @param {{positionals?: boolean}} [opts]
 */
export function parseCommandArgs(argv, options, { positionals = false } = {}) {
  try {
    return parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' }, ...options },
      strict: true,
      allowPositionals: positionals,
    });
  } catch (err) {
    throw new UsageError(describeParseError(err, options));
  }
}

function describeParseError(err, options) {
  const quoted = /'(--?[A-Za-z][A-Za-z0-9-]*)/.exec(String(err?.message ?? ''))?.[1];
  // Only ever repeat something shaped like a flag NAME (a password could arrive as a stray arg).
  const flag = quoted && /^--[a-z][a-z0-9-]*$/.test(quoted) ? quoted : null;
  switch (err?.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return flag ? `unknown option ${flag}` : 'unknown option';
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return 'unexpected argument — this command takes only --flags (quote values that contain spaces)';
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE': {
      if (flag && options[flag.slice(2)]?.type === 'boolean') return `${flag} does not take a value`;
      if (/ambiguous/.test(err.message)) return `${flag ?? 'an option'} needs a value; to pass one that starts with "-" write ${flag ?? '--flag'}=<value>`;
      return `${flag ?? 'an option'} needs a value`;
    }
    default:
      return 'invalid arguments';
  }
}

/** True for hosts that don't leave the machine or the local network (a clear-text password there is the user's call). */
export function isLocalHost(hostname) {
  const h = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || /\.(local|lan|internal|home\.arpa)$/.test(h)) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (kind === 6) return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return !h.includes('.'); // a single-label name only resolves on a LAN or in a compose network
}

/**
 * Validates a broker URL. Order matters: the empty-host case is matched before `new URL`,
 * which throws on it and would otherwise produce a useless "Invalid URL".
 * @param {string} value
 * @param {string} [source]  How to name the value in messages (flag or env var).
 * @returns {{url: string, scheme: string, hostname: string, port: number|null, tls: boolean, local: boolean}}
 */
export function checkBroker(value, source = '--broker') {
  const raw = String(value ?? '').trim();
  if (!raw) throw new UsageError(`${source} is required (e.g. mqtts://mqtt.synacl.com:8883)`);
  const empty = EMPTY_HOST_RE.exec(raw);
  if (empty) throw emptyHostError(source, empty[1].toLowerCase(), empty[2]);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`${source} is not a valid URL (expected e.g. mqtts://mqtt.synacl.com:8883)`);
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (!BROKER_SCHEMES.includes(scheme)) {
    throw new UsageError(`${source} must start with mqtt://, mqtts://, ws:// or wss:// (got ${scheme}://)`);
  }
  if (!url.hostname) throw emptyHostError(source, scheme, url.port || (scheme === 'mqtts' ? '8883' : '1883'));
  if (url.username || url.password) {
    throw new UsageError(`${source} must not contain credentials — pass them with --user and --pass`);
  }
  return {
    url: raw,
    scheme,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : null,
    tls: scheme === 'mqtts' || scheme === 'wss',
    local: isLocalHost(url.hostname),
  };
}

function emptyHostError(source, scheme, port) {
  return new UsageError(
    `${source} has no host name: this Synacl deployment has no public MQTT hostname — use --broker ${scheme}://<your-broker-host>:${port}`,
    { hint: 'Use the address this machine can reach the broker at (an IP or a DNS name).', code: 'EEMPTYHOST' },
  );
}

/** Platform REST base derived from the broker host: `mqtt.X` → `https://api.X`; local → the dev backend. */
export function deriveApi(broker) {
  let host;
  try { host = new URL(broker).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return null; }
  if (host.startsWith('mqtt.') && host.length > 5) return `https://api.${host.slice(5)}`;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'http://localhost:8080';
  return null;
}

/** Checks the identity fields every command needs. Throws UsageError naming where the bad value came from. */
export function checkIdentity(cfg, names = {}) {
  const n = { broker: '--broker', tenant: '--tenant', gateway: '--gateway', username: '--user', password: '--pass', ...names };
  const broker = checkBroker(cfg.broker, n.broker);
  if (!TENANT_RE.test(String(cfg.tenant ?? ''))) {
    throw new UsageError(`${n.tenant} must be the 24-character account id from Connection Info (0-9, a-f)`);
  }
  if (!GATEWAY_ID_RE.test(String(cfg.gateway ?? ''))) {
    throw new UsageError(`${n.gateway} must be 3-64 characters: letters, digits and _ . : - (no spaces, "/", "+" or "#"), starting with a letter or digit`);
  }
  if (!String(cfg.username ?? '')) throw new UsageError(`${n.username} is required`);
  if (!String(cfg.password ?? '')) throw new UsageError(`${n.password} is required`);
  return broker;
}

/** Every non-identity FileConfig key at its default. */
export function defaultSettings() {
  return {
    tls: { caFile: null, rejectUnauthorized: true },
    drivers: [],
    driverDir: null,
    configCap: null,
    minIntervalMs: 1000,
    backfill: { maxBytes: 67108864, maxAgeHours: 168, batchIntervalMs: 1000 },
    host: { diskPath: '/' },
    bridge: { rejectUnauthorized: true },
    log: { level: 'info', format: 'auto' },
  };
}

/** Fills missing keys (one level deep for the section objects) without dropping unknown ones. */
export function withDefaults(cfg) {
  const d = defaultSettings();
  const out = { schema: 1, ...d, ...cfg };
  for (const k of ['tls', 'backfill', 'host', 'bridge', 'log']) {
    out[k] = { ...d[k], ...(isPlainObject(cfg?.[k]) ? cfg[k] : {}) };
  }
  if (!Array.isArray(out.drivers)) out.drivers = [];
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function configPathFor(home, configPath) {
  return configPath ? resolve(configPath) : join(home, 'config.json');
}

/** Reads config.json, or returns null when it doesn't exist. Never echoes the parse error (it quotes the file). */
export function readConfigFile(path) {
  if (!existsSync(path)) return null;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${path} (${err.code ?? 'error'})`, { code: 'ECONFIGREAD' });
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new UsageError(`${path} is not valid JSON — fix it or run init again`, { code: 'ECONFIGJSON' });
  }
  if (!isPlainObject(doc)) throw new UsageError(`${path} must contain a JSON object — run init again`, { code: 'ECONFIGJSON' });
  if (doc.schema !== undefined && doc.schema !== 1) {
    throw new UsageError(`${path} has schema ${JSON.stringify(doc.schema)}; this version understands schema 1 — upgrade synacl-gateway`, { code: 'ECONFIGSCHEMA' });
  }
  return doc;
}

const ENV_KEYS = [['SYNACL_BROKER', 'broker'], ['SYNACL_TENANT', 'tenant'], ['SYNACL_GATEWAY', 'gateway'], ['SYNACL_USER', 'username']];

/**
 * The config `run` (and doctor/status/metrics) works from: config.json, overridden by the
 * environment (`SYNACL_BROKER/TENANT/GATEWAY/USER/PASS`, `SYNACL_PASS_FILE` for Docker
 * secrets, `SYNACL_HOST_DISK_PATH` for the image's /data volume), with defaults filled in.
 * With no file, a complete set of identity variables is enough (env-only containers).
 * @param {{home: string, configPath?: string, env?: Object<string, string|undefined>}} opts
 * @returns {{config: FileConfig, path: string, fromFile: boolean, envKeys: string[]}}
 */
export function loadFileConfig({ home, configPath, env = {} }) {
  const path = configPathFor(home, configPath);
  const file = readConfigFile(path);
  const cfg = { ...(file ?? {}) };
  const envKeys = [];
  const names = { broker: 'broker', tenant: 'tenant', gateway: 'gateway', username: 'username', password: 'password' };
  for (const [key, field] of ENV_KEYS) {
    if (env[key]) { cfg[field] = env[key]; envKeys.push(key); names[field] = key; }
  }
  if (env.SYNACL_PASS && env.SYNACL_PASS_FILE) throw new UsageError('set SYNACL_PASS or SYNACL_PASS_FILE, not both');
  if (env.SYNACL_PASS) { cfg.password = env.SYNACL_PASS; envKeys.push('SYNACL_PASS'); names.password = 'SYNACL_PASS'; }
  if (env.SYNACL_PASS_FILE) {
    try {
      cfg.password = readFileSync(env.SYNACL_PASS_FILE, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new UsageError(`cannot read SYNACL_PASS_FILE (${err.code ?? 'error'})`);
    }
    envKeys.push('SYNACL_PASS_FILE');
    names.password = 'SYNACL_PASS_FILE';
  }
  if (!file && envKeys.length < 5) {
    throw new UsageError(`no configuration at ${path}`, {
      code: 'ENOCONFIG',
      hint: 'Copy the line from Gateways → Connection Info in the Synacl app and run it: synacl-gateway init --broker … --tenant … --gateway … --user … --pass …',
    });
  }
  if (env.SYNACL_HOST_DISK_PATH) {
    cfg.host = { ...(isPlainObject(cfg.host) ? cfg.host : {}), diskPath: env.SYNACL_HOST_DISK_PATH };
    envKeys.push('SYNACL_HOST_DISK_PATH');
  }
  const config = withDefaults(cfg);
  if (config.api === undefined) config.api = deriveApi(config.broker);
  if (!config.createdAt) config.createdAt = new Date().toISOString();
  const prefix = file ? `${path}: ` : '';
  checkIdentity(config, Object.fromEntries(Object.entries(names).map(([k, v]) => [k, v.startsWith('SYNACL_') ? v : `${prefix}"${v}"`])));
  return { config, path, fromFile: Boolean(file), envKeys };
}

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
export const LOG_FORMATS = Object.freeze(['auto', 'text', 'json']);
