// `synacl-gateway run` — runs the gateway in the foreground until SIGTERM/SIGINT. This is what
// systemd, Docker and the app's one-liner all start. Signals:
//   SIGTERM / SIGINT  clean shutdown (online:false, DISCONNECT, state saved) → exit 0; a second one → exit 1
//   SIGHUP            re-read config.json: new identity/broker/settings → in-process restart,
//                     otherwise re-request the device configuration (and apply the log level)

/** @typedef {import('../core/types.js').CliIO} CliIO */
/** @typedef {import('../core/types.js').FileConfig} FileConfig */

import { statSync } from 'node:fs';
import { EXIT, LOG_FORMATS, LOG_LEVELS, UsageError, loadFileConfig, parseCommandArgs } from './args.js';
import { createOutput } from './output.js';
import { version } from '../index.js';

const OPTIONS = {
  config: { type: 'string' },
  'log-level': { type: 'string' },
  'log-format': { type: 'string' },
};

export const USAGE = `Usage: synacl-gateway run [--config <path>] [--log-level <level>] [--log-format <format>]

Runs the gateway in the foreground until stopped (Ctrl-C / SIGTERM). Reads config.json from
$SYNACL_GATEWAY_HOME (default ~/.synacl-gateway), written by "synacl-gateway init".

Options:
  --config <path>         read this file instead of $SYNACL_GATEWAY_HOME/config.json
  --log-level <level>     debug | info | warn | error (default: config.json log.level, else info)
  --log-format <format>   text | json | auto (auto = text on a terminal, JSON lines otherwise)
  -h, --help              show this help

Environment (overrides config.json):
  SYNACL_BROKER  SYNACL_TENANT  SYNACL_GATEWAY  SYNACL_USER  SYNACL_PASS
  SYNACL_PASS_FILE        read the password from a file (Docker secrets)
  SYNACL_HOST_DISK_PATH   filesystem the host metrics report as disk.used_pct
  SYNACL_GATEWAY_HOME     where config.json and the gateway's state live

Signals: SIGTERM/SIGINT stop cleanly; SIGHUP reloads config.json.
`;

const SKEW_PROBE_EVERY_MS = 6 * 3600 * 1000;
const SKEW_WARN_MS = 2000;

/**
 * @param {{
 *   createGateway?: Function, createLogger?: Function, probeSkew?: (api: string|null) => Promise<number|null>,
 *   clock?: import('../core/types.js').Clock, signals?: NodeJS.EventEmitter, platform?: string,
 * }} [deps]  Injected in tests; defaults are the real core modules.
 */
export function createRunCommand(deps = {}) {
  /** @param {string[]} argv @param {CliIO} io */
  return async function run(argv, io) {
    const out = createOutput(io);
    let values;
    try {
      ({ values } = parseCommandArgs(argv, OPTIONS));
      if (values['log-level'] !== undefined && !LOG_LEVELS.includes(values['log-level'])) {
        throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join(', ')}`);
      }
      if (values['log-format'] !== undefined && !LOG_FORMATS.includes(values['log-format'])) {
        throw new UsageError(`--log-format must be one of ${LOG_FORMATS.join(', ')}`);
      }
    } catch (err) {
      out.error(err.message, 'Run "synacl-gateway run --help" for the options.');
      return EXIT.USAGE;
    }
    if (values.help) { io.stdout.write(USAGE); return EXIT.OK; }

    let loaded;
    try {
      loaded = loadFileConfig({ home: io.home, configPath: values.config, env: io.env });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      out.error(err.message, err.hint);
      return EXIT.USAGE;
    }
    let { config } = loaded;

    const clock = deps.clock ?? (await import('../core/clock.js')).realClock;
    const createLogger = deps.createLogger ?? (await import('../core/log.js')).createLogger;
    const log = createLogger({
      level: values['log-level'] ?? config.log.level,
      format: values['log-format'] ?? config.log.format,
      stdout: io.stdout,
      stderr: io.stderr,
      clock,
    });
    // Before anything is logged: from here on the password is replaced by *** in every line.
    log.redact(config.password);

    warnLooseMode(loaded, log);
    log.info(`synacl-gateway ${version} starting`, {
      gateway: config.gateway,
      broker: config.broker,
      config: loaded.fromFile ? loaded.path : 'environment',
      ...(loaded.envKeys.length ? { env: loaded.envKeys.join(',') } : {}),
      node: process.version,
    });

    const createGateway = deps.createGateway ?? (await import('../core/gateway.js')).createGateway;
    const probeSkew = deps.probeSkew ?? (await import('../core/clock.js')).probeSkew;
    const signals = deps.signals ?? process;
    const platform = deps.platform ?? process.platform;

    const gw = createGateway({ config, home: io.home, log });
    let finish;
    const exited = new Promise((resolve) => { finish = resolve; });
    let stopping = false;
    let reloading = null;
    let skewTimer = null;

    const shutdown = async (code) => {
      if (skewTimer !== null) { clock.clearInterval(skewTimer); skewTimer = null; }
      try {
        await gw.stop();
      } catch (err) {
        log.error('clean shutdown failed', { err });
        finish(EXIT.RUNTIME);
        return;
      }
      log.info('stopped');
      finish(code);
    };

    const onStop = (sig) => {
      if (stopping) {
        log.warn(`${sig} received again — exiting without finishing the clean shutdown`);
        finish(EXIT.RUNTIME);
        return;
      }
      stopping = true;
      log.info(`${sig} received — shutting down`);
      void (reloading ?? Promise.resolve()).then(() => shutdown(EXIT.OK));
    };

    let started = false;
    const onHup = () => {
      if (stopping) return;
      if (!started) { log.info('SIGHUP ignored: still starting'); return; }
      if (reloading) { log.info('SIGHUP ignored: a reload is already in progress'); return; }
      reloading = reload()
        .catch((err) => log.error('reload failed', { err }))
        .finally(() => { reloading = null; });
    };

    const reload = async () => {
      let next;
      try {
        next = loadFileConfig({ home: io.home, configPath: values.config, env: io.env }).config;
      } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        log.error(`reload skipped: ${err.message} — still running with the previous settings`);
        return;
      }
      log.redact(next.password);
      if (values['log-level'] === undefined && typeof log.setLevel === 'function') log.setLevel(next.log.level);
      try {
        const result = await gw.reload(next);
        config = next;
        log.info(result === 'restarted'
          ? 'settings changed — restarted the gateway with the new configuration'
          : 'settings unchanged — asked the platform for the device configuration again');
      } catch (err) {
        if (isLockHeld(err)) {
          log.error(`another synacl-gateway is running for gateway ${next.gateway} — stopping`, { pid: err.holder?.pid });
          stopping = true;
          await shutdown(EXIT.LOCKED);
          return;
        }
        log.error('reload failed', { err });
      }
    };

    const handlers = [['SIGTERM', () => onStop('SIGTERM')], ['SIGINT', () => onStop('SIGINT')]];
    if (platform !== 'win32') handlers.push(['SIGHUP', onHup]); // on Windows SIGHUP means "console closed"
    for (const [sig, fn] of handlers) signals.on(sig, fn);

    try {
      // A stop signal during start() must not wait for start() to finish (it may be waiting on the network).
      const first = await Promise.race([
        gw.start().then(() => ({ err: null }), (err) => ({ err })),
        exited.then((code) => ({ code })),
      ]);
      if ('code' in first) return first.code;
      if (first.err) {
        const { err } = first;
        if (isLockHeld(err)) {
          const pid = err.holder?.pid;
          log.error(`another synacl-gateway is running for this gateway${pid ? ` (pid ${pid})` : ''} — only one instance per gateway id can be connected`);
          return EXIT.LOCKED;
        }
        log.error('could not start', { err });
        await gw.stop().catch(() => {}); // release whatever start() had already taken (the lock, drivers)
        return EXIT.RUNTIME;
      }
      started = true;

      const checkClock = async () => {
        const skew = await probeSkew(config.api ?? null).catch(() => null);
        if (skew === null) return;
        if (Math.abs(skew) > SKEW_WARN_MS) {
          log.warn(`the system clock is ${(Math.abs(skew) / 1000).toFixed(1)} s ${skew > 0 ? 'ahead of' : 'behind'} the platform — readings carry this machine's timestamps; enable time sync (e.g. timedatectl set-ntp true)`, { skewMs: skew });
        } else {
          log.debug('system clock in sync with the platform', { skewMs: skew });
        }
      };
      if (!config.api) log.debug('no platform API address in config.json; the clock check is off');
      void checkClock();
      // Also keeps the event loop alive while the gateway is between connections.
      skewTimer = clock.setInterval(() => { void checkClock(); }, SKEW_PROBE_EVERY_MS);

      return await exited;
    } finally {
      for (const [sig, fn] of handlers) signals.removeListener(sig, fn);
      if (skewTimer !== null) clock.clearInterval(skewTimer);
    }
  };
}

export default createRunCommand();

function isLockHeld(err) {
  return err?.name === 'LockHeldError' || err?.code === 'ELOCKED';
}

/** config.json holds the broker password; say so when other users can read it. */
function warnLooseMode(loaded, log) {
  if (!loaded.fromFile || process.platform === 'win32') return;
  try {
    const mode = statSync(loaded.path).mode & 0o777;
    if (mode & 0o077) log.warn(`${loaded.path} is readable by other users (mode ${mode.toString(8)}) — run: chmod 600 ${loaded.path}`);
  } catch { /* vanished between load and stat: nothing to warn about */ }
}
