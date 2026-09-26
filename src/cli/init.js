// `synacl-gateway init` — the command the Synacl app prints under Gateways → Connection Info:
//
//   npx synacl-gateway init --broker mqtts://mqtt.synacl.com:8883 --tenant <24 hex> \
//     --gateway <chip id> --user <username> --pass <password> && npx synacl-gateway run
//
// That line is a shipped contract: its flags, their space-separated form and the `&&` (so a
// failed check must exit non-zero) cannot change. init validates it, writes config.json
// (0600, atomically), then proves the credentials with a throwaway MQTT session.

/** @typedef {import('../core/types.js').CliIO} CliIO */
/** @typedef {import('../core/types.js').FileConfig} FileConfig */

import { randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  EXIT, PASSWORD_RE, UsageError, checkBroker, checkIdentity, configPathFor, deriveApi,
  parseCommandArgs, readConfigFile, withDefaults,
} from './args.js';
import { createOutput } from './output.js';
import { promptHidden } from './prompt.js';

const OPTIONS = {
  broker: { type: 'string' },
  tenant: { type: 'string' },
  gateway: { type: 'string' },
  user: { type: 'string' },
  pass: { type: 'string' },
  'pass-stdin': { type: 'boolean' },
  api: { type: 'string' },
  ca: { type: 'string' },
  'insecure-tls': { type: 'boolean' },
  'no-verify': { type: 'boolean' },
  config: { type: 'string' },
};

export const USAGE = `Usage: synacl-gateway init --broker <url> --tenant <id> --gateway <id> --user <name> --pass <password> [options]

Writes the gateway's settings to $SYNACL_GATEWAY_HOME/config.json (default ~/.synacl-gateway)
and checks them against the broker. Copy the whole line from Gateways → Connection Info in the
Synacl app.

Required:
  --broker <url>      mqtts://host:8883, mqtt://host:1883, wss://host/mqtt or ws://…
  --tenant <id>       the 24-character account id shown in Connection Info
  --gateway <id>      the gateway id (chip id)
  --user <name>       the gateway's MQTT username
  --pass <password>   the gateway's MQTT password (or --pass-stdin)

Options:
  --pass-stdin        read the password from stdin (typed with echo off on a terminal)
  --api <url>         platform REST address, when it can't be derived from the broker host
  --ca <file>         PEM file with the CA that signed the broker's certificate
  --insecure-tls      don't verify the broker's certificate (not recommended; prefer --ca)
  --no-verify         write the file without connecting to the broker
  --config <path>     write this file instead of $SYNACL_GATEWAY_HOME/config.json
  -h, --help          show this help

Tip: start the line with a space so most shells keep the password out of their history.
`;

/** Order of keys in the written file (unknown keys from an older file follow). */
const KEY_ORDER = ['schema', 'broker', 'tenant', 'gateway', 'username', 'password', 'api', 'tls', 'drivers', 'driverDir',
  'configCap', 'minIntervalMs', 'backfill', 'host', 'bridge', 'log', 'createdAt'];

/**
 * @param {{
 *   verify?: typeof verifyConnection,
 *   openState?: (opts: {home: string, tenant: string, gateway: string}) => {dir: string, lockHolder?: () => ({alive: boolean, pid: number}|null)},
 *   now?: () => Date,
 *   argv1?: string,
 * }} [deps]  Injected in tests; defaults are the real modules.
 */
export function createInitCommand(deps = {}) {
  /** @param {string[]} argv @param {CliIO} io */
  return async function init(argv, io) {
    const out = createOutput(io);
    let values;
    try {
      ({ values } = parseCommandArgs(argv, OPTIONS));
    } catch (err) {
      out.error(err.message, 'Run "synacl-gateway init --help" for the flags.');
      return EXIT.USAGE;
    }
    if (values.help) { io.stdout.write(USAGE); return EXIT.OK; }

    let config;
    let path;
    let previous;
    try {
      ({ config, path, previous } = await buildConfig(values, io, out, deps));
    } catch (err) {
      if (err instanceof UsageError) { out.error(err.message, err.hint); return EXIT.USAGE; }
      if (err?.code === 'ABORTED') { out.error('no password entered'); return EXIT.USAGE; }
      throw err;
    }

    const openState = deps.openState ?? (await import('../core/state.js')).openState;
    if (previous && (previous.tenant !== config.tenant || previous.gateway !== config.gateway)) {
      const oldDir = safe(() => openState({ home: io.home, tenant: previous.tenant, gateway: previous.gateway }).dir);
      out.info(`This replaces gateway ${previous.gateway}. Its state and any buffered readings stay in ${oldDir ?? join(io.home, 'state')}.`);
    }

    try {
      writeConfigAtomic(path, config, { home: io.home });
    } catch (err) {
      out.error(`cannot write ${path} (${err.code ?? err.message})`,
        err.code === 'EACCES' || err.code === 'EPERM' ? 'Check that this user owns the directory, or choose another with SYNACL_GATEWAY_HOME.' : undefined);
      return EXIT.RUNTIME;
    }
    out.info(`Saved ${path} (gateway ${config.gateway} on ${config.broker}).`);

    const running = [config, previous].filter(Boolean)
      .map((c) => safe(() => openState({ home: io.home, tenant: c.tenant, gateway: c.gateway }).lockHolder?.()))
      .find((h) => h?.alive);

    if (running) {
      out.info(`synacl-gateway is already running for this gateway (pid ${running.pid}), so the connection check was skipped.`);
      out.info(`Restart the service to pick up the new settings (sudo systemctl restart synacl-gateway, or kill -HUP ${running.pid}).`);
      return EXIT.OK;
    }
    if (values['no-verify']) {
      out.info('Connection check skipped (--no-verify).');
    } else {
      const verify = deps.verify ?? verifyConnection;
      const clientId = `${config.gateway}-init-${randomBytes(2).toString('hex')}`;
      out.info(`Checking the connection to ${config.broker} …`);
      const res = await verify({ config, clientId });
      if (!res.ok) {
        out.error(res.message, res.hint);
        out.error(`The settings were saved to ${path}. Fix the problem above and run the init line again${res.stage === 'tcp' ? ', or start anyway with "synacl-gateway run" (it keeps retrying)' : ''}.`);
        return EXIT.CONNECT;
      }
      out.info(`Connected: credentials accepted, ${res.grants.length}/${res.grants.length} subscriptions granted.`);
    }

    out.line();
    out.line('Next: synacl-gateway run');
    if (isNpx(deps.argv1 ?? process.argv[1])) {
      out.line('To keep it running in the background: npm i -g synacl-gateway, then synacl-gateway service install');
    } else {
      out.line('  or run it in the background:  synacl-gateway service install');
    }
    return EXIT.OK;
  };
}

export default createInitCommand();

async function buildConfig(values, io, out, deps) {
  const missing = ['broker', 'tenant', 'gateway', 'user'].filter((k) => values[k] === undefined).map((k) => `--${k}`);
  if (values.pass === undefined && !values['pass-stdin']) missing.push('--pass');
  if (missing.length) {
    throw new UsageError(`missing ${missing.join(', ')}`, { hint: 'Copy the whole line from Gateways → Connection Info in the Synacl app.' });
  }
  if (values.pass !== undefined && values['pass-stdin']) throw new UsageError('use either --pass or --pass-stdin, not both');

  // The broker is checked before anything else (and before prompting): the empty-host case
  // is the most likely failure of a pasted line and deserves the specific explanation.
  const broker = checkBroker(values.broker);
  const password = values['pass-stdin'] ? await promptHidden('Gateway password (from Connection Info): ', io) : values.pass;
  const identity = {
    broker: broker.url,
    tenant: String(values.tenant).toLowerCase(), // ObjectId strings are lower case; topics and ACLs are case-sensitive
    gateway: values.gateway,
    username: values.user,
    password,
  };
  checkIdentity(identity);

  if (!PASSWORD_RE.test(password)) {
    out.warn('the password does not look like one the platform generates (24 letters and digits) — check that the whole value was copied.');
  }
  if (!broker.tls && !broker.local) {
    out.warn(`${broker.scheme}:// sends the password in clear text to ${broker.hostname}; use ${broker.scheme === 'ws' ? 'wss' : 'mqtts'}:// if the broker supports TLS.`);
  }

  const tls = { caFile: null, rejectUnauthorized: !values['insecure-tls'] };
  if (values.ca !== undefined) {
    const caFile = resolve(String(values.ca));
    try {
      readFileSync(caFile);
    } catch (err) {
      throw new UsageError(`cannot read the --ca file ${caFile} (${err.code ?? 'error'})`);
    }
    tls.caFile = caFile;
  }
  if (!broker.tls && (values.ca !== undefined || values['insecure-tls'])) {
    out.warn(`--ca and --insecure-tls only apply to mqtts:// and wss:// brokers; ${broker.scheme}:// does not use TLS.`);
  } else if (values['insecure-tls']) {
    out.warn('TLS certificate verification is OFF: anything on the network path can impersonate the broker and read the password. Prefer --ca <file>.');
  }

  const path = configPathFor(io.home, values.config);
  let previous = null;
  try {
    previous = readConfigFile(path);
  } catch (err) {
    if (err.code === 'ECONFIGSCHEMA') throw new UsageError(`${path} was written by a newer synacl-gateway — upgrade before running init`);
    out.warn(`replacing ${path}, which could not be read (${err.message.replace(`${path} `, '')}).`);
  }
  if (previous && previous.broker === identity.broker && (previous.tls?.caFile || previous.tls?.rejectUnauthorized === false)
    && values.ca === undefined && !values['insecure-tls']) {
    out.warn('the previous --ca / --insecure-tls setting is not carried over; add the flag again if the broker needs it.');
  }

  let api;
  if (values.api !== undefined) {
    let u;
    try { u = new URL(String(values.api)); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol)) throw new UsageError('--api must be an http(s) URL, e.g. https://api.synacl.com');
    api = u.href.replace(/\/+$/, '');
  } else {
    // An --api given on an earlier init for the same broker stays; the app's line never has one.
    api = deriveApi(broker.url) ?? (previous?.broker === identity.broker && typeof previous.api === 'string' ? previous.api : null);
  }

  // Settings the user tuned by hand (drivers, backfill limits, log level …) survive a re-init,
  // e.g. after the platform issued a new password; identity and TLS come from this line only.
  const merged = withDefaults({ ...(previous ?? {}), ...identity, api, tls, createdAt: (deps.now?.() ?? new Date()).toISOString() });
  const ordered = {};
  for (const k of KEY_ORDER) ordered[k] = merged[k];
  for (const k of Object.keys(merged)) if (!(k in ordered)) ordered[k] = merged[k];
  ordered.schema = 1;
  if (api === null) {
    out.info('No platform API address could be derived from the broker host; pass --api https://api.<your-domain> to enable the clock check and "doctor" cloud checks.');
  }
  return { config: /** @type {FileConfig} */ (ordered), path, previous };
}

function safe(fn) {
  try { return fn(); } catch { return undefined; }
}

function isNpx(argv1) {
  if (!argv1) return false;
  let p = argv1;
  try { p = realpathSync(argv1); } catch { /* keep the raw path */ }
  return p.split(/[\\/]/).includes('_npx');
}

/**
 * Writes the config so that a crash never leaves a half-written file and the password is
 * never readable by others, even for an instant: a 0600 temp file in the same directory,
 * fsync, rename over the target, fsync the directory.
 * @param {string} path
 * @param {Object} config
 * @param {{home?: string}} [opts]
 */
export function writeConfigAtomic(path, config, { home } = {}) {
  const dir = dirname(path);
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && existed && home && resolve(dir) === resolve(home)) {
    // Tighten a home dir created by something else (e.g. mkdir with the default umask).
    try {
      const st = statSync(dir);
      if ((st.mode & 0o077) && st.uid === process.getuid?.()) chmodSync(dir, 0o700);
    } catch { /* not ours to change */ }
  }
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600); // a pre-existing target's inode is gone, but be explicit about the result
    try {
      const dfd = openSync(dir, 'r');
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch { /* some filesystems can't fsync a directory; the rename is still atomic */ }
  }
}

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_SIGNATURE_FAILURE', 'CERT_UNTRUSTED', 'CERT_REVOKED',
]);
const DEFAULT_PORTS = { mqtt: 1883, mqtts: 8883, ws: 80, wss: 443 };

/**
 * Proves a config against the broker without disturbing a running gateway: its own client id,
 * no Last Will, nothing published, a graceful DISCONNECT. Checks the CONNACK and that each of
 * the seven downlink subscriptions is granted — a refused subscription (0x80) is the only
 * in-band sign that tenant/gateway don't match the credential. Also used by `doctor`.
 * @param {{config: FileConfig, clientId: string, timeoutMs?: number, mqtt?: {connect: Function}, filters?: string[]}} opts
 * @returns {Promise<{ok: boolean, stage: 'tcp'|'tls'|'connack'|'suback', code?: number|string,
 *   grants?: number[], deniedFilters?: string[], message: string, hint?: string}>}
 */
export async function verifyConnection({ config, clientId, timeoutMs = 15000, mqtt, filters }) {
  const client$ = mqtt ?? (await import('mqtt'));
  const subs = filters ?? (await import('../core/topics.js')).createTopics({ tenant: config.tenant, gateway: config.gateway }).subscriptions();
  const url = new URL(config.broker);
  const scheme = url.protocol.replace(/:$/, '');
  const where = `${url.hostname}:${url.port || DEFAULT_PORTS[scheme]}`;
  const tlsScheme = scheme === 'mqtts' || scheme === 'wss';

  let ca;
  if (config.tls?.caFile) {
    try {
      ca = readFileSync(config.tls.caFile);
    } catch (err) {
      return { ok: false, stage: 'tls', code: err.code, message: `cannot read the CA file ${config.tls.caFile} (${err.code})` };
    }
  }

  return new Promise((resolveResult) => {
    let settled = false;
    let connected = false;
    const client = client$.connect(config.broker, {
      clientId,
      username: config.username,
      password: config.password,
      protocolVersion: 4,
      clean: true,
      keepalive: 30,
      connectTimeout: timeoutMs,
      reconnectPeriod: 0,
      resubscribe: false,
      queueQoSZero: false,
      rejectUnauthorized: config.tls?.rejectUnauthorized !== false,
      ...(ca ? { ca } : {}),
    });
    const timer = setTimeout(() => finish(unreachable('ETIMEDOUT')), timeoutMs + 2000);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const done = () => resolveResult(result);
      if (connected && client.connected) {
        const t = setTimeout(() => { client.end(true); done(); }, 2000);
        client.end(false, {}, () => { clearTimeout(t); done(); });
      } else {
        client.end(true);
        done();
      }
    }

    function unreachable(code) {
      const base = { ok: false, stage: 'tcp', code };
      switch (code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
          return { ...base, message: `cannot resolve ${url.hostname} (DNS lookup failed)`, hint: 'Check the host name and this machine\'s DNS / internet connection.' };
        case 'ECONNREFUSED':
          return { ...base, message: `${where} refused the connection`, hint: 'Wrong port, or no broker listening there.' };
        default:
          return {
            ...base,
            message: `no answer from ${where} within ${Math.round(timeoutMs / 1000)} s (${code})`,
            hint: `A firewall may block outbound port ${url.port || DEFAULT_PORTS[scheme]}.${scheme === 'mqtts' ? ` If it does, the broker may also be reachable over WebSocket: --broker wss://${url.hostname}/mqtt` : ''}`,
          };
      }
    }

    // A reset/close before CONNACK almost always means TLS on one side and plain TCP on the other.
    function closedEarly(code) {
      return tlsScheme
        ? { ok: false, stage: 'tls', code, message: `${where} closed the connection during the TLS handshake`,
          hint: 'mqtts:// needs the broker\'s TLS port (usually 8883); for a plain port use mqtt://.' }
        : { ok: false, stage: 'connack', code, message: `${where} closed the connection before answering`,
          hint: 'Is this a TLS port? Try mqtts:// (usually port 8883).' };
    }

    client.on('connect', () => {
      connected = true;
      client.subscribe(subs, { qos: 1 }, (err, _granted, packet) => {
        const grants = (packet ?? err?.packet)?.granted;
        if (!Array.isArray(grants) || grants.length !== subs.length) {
          finish({ ok: false, stage: 'suback', code: 'EPROTO', message: 'the broker gave no usable answer to the subscriptions' });
          return;
        }
        const deniedFilters = subs.filter((_, i) => (grants[i] & 0x80) !== 0);
        if (deniedFilters.length) {
          finish({
            ok: false, stage: 'suback', code: 128, grants, deniedFilters,
            message: `the broker accepted the credentials but refused ${deniedFilters.length} of ${subs.length} subscriptions (${deniedFilters.map((f) => f.split('/').slice(5).join('/')).join(', ')})`,
            hint: '--tenant and --gateway do not match this username/password. Copy them from the same Connection Info line.',
          });
          return;
        }
        finish({ ok: true, stage: 'suback', grants, message: `connected; ${subs.length}/${subs.length} subscriptions granted` });
      });
    });

    client.on('error', (err) => {
      const code = err?.code;
      if (typeof code === 'number') {
        if (code === 4 || code === 5) {
          finish({
            ok: false, stage: 'connack', code,
            message: `the broker rejected the username/password (CONNACK ${code})`,
            hint: 'Copy the line from Gateways → Connection Info again; the password changes whenever the gateway is re-registered.',
          });
        } else {
          finish({ ok: false, stage: 'connack', code, message: `the broker refused the connection (CONNACK ${code}: ${err.message.replace(/^Connection refused: /, '')})` });
        }
      } else if (TLS_CODES.has(code)) {
        finish({
          ok: false, stage: 'tls', code,
          message: `the broker's TLS certificate was not accepted (${code})`,
          hint: 'If the broker uses a private CA, pass --ca <file>. --insecure-tls turns verification off (not recommended).',
        });
      } else if (code === 'EPROTO' || String(code).startsWith('ERR_SSL_') || /wrong version number|packet length too long/i.test(String(err?.message))) {
        finish({
          ok: false, stage: 'tls', code: code ?? 'EPROTO',
          message: `${where} did not answer TLS`,
          hint: 'Use mqtt:// for a plain port, or the broker\'s TLS port (usually 8883) with mqtts://.',
        });
      } else if ((code === 'ECONNRESET' || code === 'EPIPE') && !connected) {
        finish(closedEarly(code));
      } else if (err?.message === 'connack timeout') {
        finish(unreachable('ETIMEDOUT'));
      } else if (typeof code === 'string' && code.startsWith('E')) {
        finish(unreachable(code));
      } else {
        finish({ ok: false, stage: connected ? 'suback' : 'tcp', code, message: `connection failed: ${String(err?.message ?? code ?? 'unknown error').slice(0, 200)}` });
      }
    });

    client.on('close', () => {
      if (settled) return;
      finish(connected
        ? { ok: false, stage: 'suback', code: 'ECONNRESET', message: 'the broker closed the connection during the subscription check' }
        : closedEarly('ECONNRESET'));
    });
  });
}
