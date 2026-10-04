// `synacl-gateway status` — what the gateway is doing, read from the files `run` keeps up to
// date (runtime.json every 10 s, run.lock). Needs no connection
// and works when the gateway is stopped or crashed: the lock's owner tells running from dead —
// by its pid and the start time recorded with it, because a container restart or a reboot
// hands the old pid to another process. Read-only: a stale lock is reported, not removed.

/** @typedef {import('../core/types.js').CliIO} CliIO */

import { EXIT, UsageError, loadFileConfig, parseCommandArgs } from './args.js';
import { createOutput, formatAgo, formatBytes, formatDuration, table } from './output.js';

const OPTIONS = { json: { type: 'boolean' }, config: { type: 'string' } };

export const USAGE = `Usage: synacl-gateway status [--json] [--config <path>]

Shows whether the gateway is running, its connection, configuration sync, buffer and devices.
Works while it is stopped too ("not running, last seen …").

Options:
  --json            print one JSON document
  --config <path>   read this file instead of $SYNACL_GATEWAY_HOME/config.json
  -h, --help        show this help
`;

/** @param {{openState?: Function, now?: () => number}} [deps] */
export function createStatusCommand(deps = {}) {
  /** @param {string[]} argv @param {CliIO} io */
  return async function status(argv, io) {
    let values;
    try {
      ({ values } = parseCommandArgs(argv, OPTIONS));
    } catch (err) {
      createOutput(io).error(err.message, 'Run "synacl-gateway status --help" for the options.');
      return EXIT.USAGE;
    }
    if (values.help) { io.stdout.write(USAGE); return EXIT.OK; }
    const out = createOutput(io, { json: Boolean(values.json) });

    let loaded;
    try {
      loaded = loadFileConfig({ home: io.home, configPath: values.config, env: io.env });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      out.error(err.message, err.hint);
      return EXIT.USAGE;
    }
    const { config } = loaded;
    const openState = deps.openState ?? (await import('../core/state.js')).openState;
    const now = (deps.now ?? Date.now)();
    const state = openState({ home: io.home, tenant: config.tenant, gateway: config.gateway });
    const runtime = state.readRuntime() ?? null;
    const lock = state.lockHolder?.() ?? null;
    // Not readConfigRaw(): it discards a stored config whose hash doesn't match, and a running
    // gateway can be between writing the bytes and the meta — a status call must never race it.
    const running = Boolean(lock?.alive);
    // A restarted gateway takes the lock first and writes runtime.json only once its devices
    // are loaded; until then the file is the previous run's. The lock is taken just before
    // startedAt is recorded, so a snapshot that started before the lock is not this process's.
    const runtimeCurrent = running && Boolean(runtime)
      && !(Number.isFinite(runtime.startedAt) && Number.isFinite(lock.startedAt) && runtime.startedAt < lock.startedAt);
    const staleLock = lock && !running ? { pid: lock.pid, hostname: lock.hostname, reason: lock.stale ?? null } : null;

    const report = {
      running,
      pid: running ? lock.pid : null,
      runtimeCurrent,
      staleLock,
      gateway: config.gateway,
      tenant: config.tenant,
      broker: config.broker,
      home: io.home,
      configPath: loaded.fromFile ? loaded.path : null,
      stateDir: state.dir,
      // Whitelisted fields only: runtime.json never carries credentials, but a future field might.
      runtime: runtime && pick(runtime, ['pid', 'version', 'state', 'startedAt', 'updatedAt', 'connected', 'connectedSince',
        'lastHeartbeatAt', 'configHash', 'configSynced', 'devices', 'buffer']),
    };
    if (out.json) { out.data(report); return EXIT.OK; }

    const rows = [['Gateway', `${config.gateway} (account ${config.tenant}) on ${config.broker}`]];
    const rt = report.runtime;
    const stale = staleLock ? ` (${staleLockText(staleLock)})` : '';
    if (running && (runtimeCurrent || !rt)) {
      const up = Number.isFinite(rt?.startedAt) ? `, up ${formatDuration(now - rt.startedAt)}` : '';
      rows.push(['Process', `running (pid ${lock.pid}${up}${rt?.version ? `, version ${rt.version}` : ''})`]);
    } else if (running) {
      rows.push(['Process', `running (pid ${lock.pid}, starting up)`]);
    } else if (rt) {
      const when = Number.isFinite(rt.updatedAt) ? formatAgo(rt.updatedAt, now) : 'at an unknown time';
      rows.push(['Process', rt.state === 'stopped' ? `not running${stale} — stopped ${when}` : `not running${stale} — last seen ${when} (it did not shut down cleanly)`]);
    } else {
      rows.push(['Process', `not running${stale} — no record of a previous run with these settings`]);
    }
    if (rt && runtimeCurrent) {
      rows.push(['MQTT', rt.connected
        ? `connected${Number.isFinite(rt.connectedSince) ? ` for ${formatDuration(now - rt.connectedSince)}` : ''}`
        : `not connected${rt.state ? ` (${rt.state})` : ''}`]);
      rows.push(['Heartbeat', Number.isFinite(rt.lastHeartbeatAt) ? formatAgo(rt.lastHeartbeatAt, now) : 'none sent yet']);
    }
    const hash = rt?.configHash;
    if (hash) {
      const synced = rt.configSynced === true ? 'in sync with the platform' : rt.configSynced === false ? 'not confirmed by the platform yet' : 'sync unknown';
      rows.push(['Config', `hash ${hash}, ${synced}`]);
    } else {
      rows.push(['Config', 'no devices yet — add a device to this gateway in the app; it is sent here automatically']);
    }
    if (rt?.buffer) {
      const b = rt.buffer;
      rows.push(['Buffer', `${b.records ?? 0} readings waiting (${formatBytes(b.bytes ?? 0)})${b.dropped ? `, ${b.dropped} dropped` : ''}${b.writeErrors ? `, ${b.writeErrors} write errors` : ''}`]);
    }
    const devices = Array.isArray(rt?.devices) ? rt.devices : [];
    rows.push(['Devices', String(devices.length)]);
    out.line(table(rows));
    if (devices.length) {
      out.line();
      const head = ['ID', 'PROTOCOL', 'INTERVAL', 'LAST DATA', 'STATUS'];
      const body = devices.map((d) => [
        String(d.id ?? '?'),
        String(d.protocol ?? '?'),
        Number.isFinite(d.intervalMs) ? formatDuration(d.intervalMs) : '?',
        Number.isFinite(d.lastDataTs) ? formatAgo(d.lastDataTs, now) : 'never',
        d.paused ? 'paused' : d.reachable === false ? `unreachable${d.reason ? `: ${d.reason}` : ''}` : d.reachable ? 'ok' : '?',
      ]);
      out.line(table([head, ...body], { indent: '  ' }));
    }
    if (rt && !running) out.line('\nThe values above are from the last run. Start it with: synacl-gateway run');
    else if (rt && !runtimeCurrent) out.line('\nThe values above are from the last run; the gateway is starting and replaces them once its devices are loaded.');
    return EXIT.OK;
  };
}

function staleLockText({ pid, hostname, reason }) {
  if (reason === 'pid-reused') return `stale lock file: pid ${pid} is now a different process`;
  if (reason === 'exited') return `stale lock file: pid ${pid} has exited`;
  if (reason === 'other-host') return `stale lock file from host ${hostname}`;
  return 'stale lock file';
}

export default createStatusCommand();

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
