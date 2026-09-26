// `synacl-gateway doctor` — look for problems on this machine, at the broker and on the platform.
//
// Local checks need nothing but config.json. The platform checks sign in to the Synacl API with
// the account's e-mail and password; the password is read with echo off (or from
// SYNACL_PASSWORD), never from a flag, and the session token stays in memory. Everything
// printed is whitelisted: a gateway record from the API carries its broker password and a
// device record carries its `conn` (which can hold credentials) — neither is ever shown.
//
// Output: `[ok]` fine · `[!!]` a problem, with a fix · `[--]` skipped or informational.
// Exit codes: 0 no problems · 5 problems found · 2 usage error · 1 internal error.

/** @typedef {import('../core/types.js').CliIO} CliIO */
/** @typedef {import('../core/types.js').FileConfig} FileConfig */

import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { EXIT, loadFileConfig, parseCommandArgs, UsageError } from './args.js';
import { promptHidden, promptLine } from './prompt.js';
import { createCloudApi } from '../cloud/api.js';

export const USAGE = `Usage: synacl-gateway doctor [--email <address>] [--api <url>] [--skip-cloud] [--json] [--config <path>]

Checks this machine (Node.js, config.json permissions, clock), the broker (reachability, TLS,
credentials, the 7 subscriptions — with its own client id, so a running gateway is not
disturbed), the local gateway process, and — after you sign in — what the platform sees:
the gateway record, config currency, capabilities, feature flags, every device's status and
rate limits, and the last 24 hours of relevant events.

Options:
  --email <address>   the Synacl account to sign in with (else prompted on a terminal)
  --api <url>         the platform API (default: "api" from config.json)
  --skip-cloud        local and broker checks only
  --json              machine-readable output
  --config <path>     a config.json other than $SYNACL_GATEWAY_HOME/config.json
  -h, --help          show this help

The password is read from the terminal with echo off, or from SYNACL_PASSWORD. Signing in
is recorded like any sign-in on the account (login history, sign-in notifications).

Exit codes: 0 no problems · 5 problems found · 2 usage error · 1 internal error
`;

const DAY_MS = 24 * 3_600_000;
const MAX_DEVICE_CHECKS = 25;
const EVENT_TYPES = ['gateway/config-too-large', 'gateway/config-sync', 'quota/suspended', 'quota/rate-limited', 'modbus/timeout', 'device/offline'];
const PROTOCOL_FLAGS = [['protocol_host', 'host'], ['protocol_mqtt_bridge', 'mqtt-bridge'], ['protocol_modbus_tcp', 'modbus-tcp']];

const clip = (s, n = 160) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`);

/** A device's configured publish interval, read from its conn WITHOUT exposing conn itself. */
function deviceIntervalMs(d) {
  const c = d && d.conn && typeof d.conn === 'object' ? d.conn : {};
  const n = Number(c.sampleIntervalMs ?? c.tickDuration);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {Object} [deps]  Injection points for tests.
 */
export function createDoctorCommand(deps = {}) {
  const d = {
    fetch: globalThis.fetch,
    now: () => Date.now(),
    platform: process.platform,
    nodeVersion: process.versions.node,
    loadFileConfig,
    promptHidden,
    promptLine,
    stat: statSync,
    verifyConnection: async (opts) => (await import('./init.js')).verifyConnection(opts),
    openState: async (opts) => (await import('../core/state.js')).openState(opts),
    probeSkew: async (api, opts) => (await import('../core/clock.js')).probeSkew(api, opts),
    clientSuffix: () => randomBytes(2).toString('hex'),
    ...deps,
  };

  /**
   * @param {string[]} argv
   * @param {CliIO} io
   */
  return async function doctor(argv, io) {
    let args;
    try {
      args = parseCommandArgs(argv, {
        email: { type: 'string' },
        api: { type: 'string' },
        'skip-cloud': { type: 'boolean' },
        json: { type: 'boolean' },
        config: { type: 'string' },
      }).values;
    } catch (err) {
      io.stderr.write(`error: ${err.message}\n\n${USAGE}`);
      return err instanceof UsageError ? EXIT.USAGE : EXIT.RUNTIME;
    }
    if (args.help) { io.stdout.write(USAGE); return EXIT.OK; }

    const json = !!args.json;
    const checks = [];
    let section = '';
    const say = (text) => { if (!json) io.stdout.write(text); };
    const heading = (name) => { section = name; say(`\n${name}\n`); };
    const add = (status, id, message, hint) => {
      const c = { section, id, status, message };
      if (hint) c.hint = hint;
      checks.push(c);
      const tag = status === 'ok' ? '[ok]' : status === 'problem' ? '[!!]' : '[--]';
      say(`  ${tag} ${message}\n`);
      if (hint && status !== 'ok') say(`       → ${hint}\n`);
    };
    const ok = (id, m) => add('ok', id, m);
    const bad = (id, m, hint) => add('problem', id, m, hint);
    const info = (id, m, hint) => add('info', id, m, hint);

    const finish = (extra = {}) => {
      const problems = checks.filter((c) => c.status === 'problem').length;
      if (json) io.stdout.write(`${JSON.stringify({ problems, checks, ...extra }, null, 2)}\n`);
      else say(`\n${problems ? `${problems} problem${problems === 1 ? '' : 's'} found.` : 'No problems found.'}\n`);
      return problems ? EXIT.DOCTOR : EXIT.OK;
    };

    try {
      // ── This machine ──
      heading('This machine');
      const [maj, min] = String(d.nodeVersion).split('.').map(Number);
      if (maj > 20 || (maj === 20 && min >= 11)) ok('node', `Node.js ${d.nodeVersion}${maj === 20 ? ' (works; 22 LTS recommended — Node 20 is past end of life)' : ''}`);
      else bad('node', `Node.js ${d.nodeVersion} is too old`, 'Install Node.js 22 LTS (see the README for Raspberry Pi instructions).');

      /** @type {FileConfig} */
      let config;
      let loaded;
      try {
        loaded = d.loadFileConfig({ home: io.home, configPath: args.config, env: io.env });
        config = loaded.config;
      } catch (err) {
        bad('config', err.message, err.hint || 'Run synacl-gateway init with the line from Gateways → Connection Info.');
        return finish();
      }
      say(`  gateway ${config.gateway}, account ${config.tenant}, broker ${config.broker}\n`);
      if (!loaded.fromFile) info('config-mode', `configuration from the environment (${loaded.envKeys.join(', ')})`);
      else if (d.platform === 'win32') info('config-mode', 'file permissions are not checked on Windows');
      else {
        const mode = d.stat(loaded.path).mode & 0o777;
        if (mode & 0o077) bad('config-mode', `${loaded.path} is readable by other users (mode ${mode.toString(8).padStart(4, '0')}) and holds the broker password`, `chmod 600 ${loaded.path}`);
        else ok('config-mode', `config.json is private (mode ${mode.toString(8).padStart(4, '0')})`);
      }

      const apiBase = args.api || config.api || null;
      if (!apiBase) info('clock', 'clock not checked (no API URL — pass --api)');
      else {
        const skew = await d.probeSkew(apiBase, { fetch: d.fetch });
        if (skew == null) info('clock', `clock not checked (no answer from ${apiBase})`);
        else if (Math.abs(skew) <= 2_000) ok('clock', `clock is within ${(Math.abs(skew) / 1000).toFixed(1)} s of the platform's`);
        else bad('clock', `clock is ${(Math.abs(skew) / 1000).toFixed(1)} s ${skew > 0 ? 'ahead of' : 'behind'} the platform's`, 'Enable time sync (e.g. `sudo timedatectl set-ntp true`). Readings are timestamped here; a clock more than a few seconds off loses the platform\'s tolerance for network bursts.');
      }

      // Broker: one probe with its OWN client id — reusing the gateway's would take over (and
      // disconnect) a running instance, which the platform would see as the gateway dropping.
      const clientId = `${config.gateway}-doctor-${d.clientSuffix()}`;
      let probe;
      try {
        probe = await d.verifyConnection({ config, clientId, timeoutMs: 15_000 });
      } catch (err) {
        probe = { ok: false, stage: 'tcp', message: `broker check failed: ${err && err.message}` };
      }
      const tlsScheme = /^(mqtts|wss):/i.test(config.broker);
      const stages = ['tcp', 'tls', 'connack', 'suback'];
      const reached = probe.ok ? 4 : stages.indexOf(probe.stage);
      if (reached === 0) bad('broker-reach', probe.message, probe.hint);
      else ok('broker-reach', `broker reachable (${config.broker.replace(/\/\/[^@/]*@/, '//')})`);
      if (tlsScheme) {
        if (reached === 1) bad('broker-tls', probe.message, probe.hint);
        else if (reached > 1) ok('broker-tls', 'TLS handshake and certificate OK');
        else info('broker-tls', 'TLS not checked');
      }
      if (reached === 2) {
        const creds = probe.code === 4 || probe.code === 5;
        bad('broker-login', probe.message, probe.hint || (creds ? 'The broker rejected the username/password. Run init again with the line from Gateways → Connection Info.' : undefined));
      } else if (reached > 2) ok('broker-login', 'broker accepted the credentials (CONNACK)');
      else info('broker-login', 'credentials not checked');
      if (reached === 3) bad('broker-acl', probe.message, probe.hint);
      else if (reached > 3) ok('broker-acl', `${(probe.grants || []).length || 7}/${(probe.grants || []).length || 7} subscriptions granted — tenant and gateway match the credential`);
      else info('broker-acl', 'subscriptions not checked');

      // The local process, from its lock and runtime.json (read-only: never touches config state).
      let runtime = null;
      let running = false;
      try {
        const st = await d.openState({ home: io.home, tenant: config.tenant, gateway: config.gateway, clock: { now: d.now } });
        const holder = st.lockHolder();
        runtime = st.readRuntime();
        running = !!(holder && holder.alive);
        if (running) {
          const age = runtime && runtime.updatedAt ? d.now() - runtime.updatedAt : null;
          if (age != null && age > 60_000) bad('local', `synacl-gateway is running (pid ${holder.pid}) but has not updated its status for ${ago(age)}`, 'It may be stuck. Restart it (sudo systemctl restart synacl-gateway, or stop and start `run`).');
          else if (runtime && runtime.connected) {
            ok('local', `synacl-gateway is running (pid ${holder.pid}), connected${runtime.configSynced ? `, config current (hash ${runtime.configHash})` : ''}`);
            if (!runtime.configSynced) bad('local-config', 'the running gateway has not confirmed its configuration yet', 'Wait a minute; if it persists press Resend config in the app, or look for gateway/config-too-large below.');
          } else bad('local', `synacl-gateway is running (pid ${holder.pid}) but not connected to the broker`, 'See the broker checks above and the gateway log (journalctl -u synacl-gateway).');
          if (runtime && runtime.buffer && runtime.buffer.records > 0) info('local-buffer', `${runtime.buffer.records} buffered reading(s) waiting to be replayed`);
        } else if (holder && holder.hostname) {
          info('local', `synacl-gateway is not running here${runtime && runtime.updatedAt ? ` (last seen ${ago(d.now() - runtime.updatedAt)})` : ''}`, 'Start it with `synacl-gateway run`, or install the service: `synacl-gateway service install`.');
        } else {
          info('local', 'synacl-gateway is not running here', 'Start it with `synacl-gateway run`, or install the service: `synacl-gateway service install`.');
        }
      } catch (err) {
        info('local', `local state not readable (${clip(err && err.message, 80)})`);
      }

      // ── The platform ──
      heading('Platform');
      if (args['skip-cloud']) { info('cloud', 'skipped (--skip-cloud)'); return finish(); }
      if (!apiBase) { info('cloud', 'skipped: no API URL (pass --api https://api.<your-domain>)'); return finish(); }
      let email = args.email || io.env.SYNACL_EMAIL || null;
      if (!email && io.stdin && io.stdin.isTTY) {
        email = (await d.promptLine('Synacl account e-mail (Enter to skip the platform checks): ', io)).trim() || null;
      }
      if (!email) { info('cloud', 'skipped: pass --email <address> to sign in and check what the platform sees'); return finish(); }
      const password = io.env.SYNACL_PASSWORD || await d.promptHidden(`Password for ${email}: `, io);
      if (!password) { info('cloud', 'skipped: no password given'); return finish(); }

      info('login-note', `signing in as ${email}: this is recorded like any sign-in on the account (login history, sign-in notification)`);
      const api = createCloudApi({ base: apiBase, fetch: d.fetch });
      let who;
      try {
        who = await api.login(email, password);
      } catch (err) {
        const msg = /EMAIL_UNVERIFIED/.test(err.message) ? 'the account\'s e-mail address is not verified yet' : err.message;
        bad('login', `sign-in failed: ${clip(msg)}`, err.status === 401 ? 'Check the e-mail and password (the account password — not the gateway\'s broker password).' : 'Check --api and this machine\'s internet access.');
        return finish();
      }
      const tenant = who.tenant || config.tenant;
      if (who.tenant && who.tenant !== config.tenant) {
        bad('account', `you signed in to account ${who.tenant}, but config.json is for account ${config.tenant}`, 'Sign in with the account that owns this gateway, or fix --tenant with the Connection Info line.');
      } else ok('login', `signed in (account ${tenant})`);

      // Gateway record — whitelisted fields only.
      let gw = null;
      try {
        const list = await api.gateways(tenant);
        gw = list.find((g) => g && g.esp_chip_id === config.gateway) || null;
      } catch (err) {
        bad('gateway', `could not list gateways: ${clip(err.message)}`);
      }
      const gwView = gw ? {
        id: String(gw._id), name: gw.name, type: gw.type, online: !!gw.online, degraded: !!gw.degraded, firmware: gw.firmware || null,
        configCurrent: gw.configCurrent ?? null, configHash: gw.configHash ?? null, gatewayConfigHash: gw.gatewayConfigHash ?? null,
        updating: gw.updating ? gw.updating.reason || true : null,
        protocols: gw.capabilities && Array.isArray(gw.capabilities.protocols) ? gw.capabilities.protocols : null,
      } : null;
      if (!gw) {
        bad('gateway', `the platform has no gateway "${config.gateway}" in account ${tenant}`, 'Create it in the app (Gateways → Add gateway → Software gateway) and copy its Connection Info line.');
        return finish({ gateway: null });
      }
      ok('gateway', `gateway "${clip(gwView.name, 60)}" found (type ${gwView.type || '?'}, firmware ${gwView.firmware || 'not reported yet'})`);
      if (gwView.type === 'esp32') bad('gateway-type', 'the gateway is registered as an ESP32, so the app offers firmware updates for it', 'Register it as a Software gateway (Gateways → Add gateway → Software gateway).');
      if (gwView.online) ok('gateway-online', `the platform shows the gateway online${gwView.degraded ? ' (degraded: a device is unreachable)' : ''}`);
      else bad('gateway-online', 'the platform shows the gateway offline', running ? 'It runs here but the platform does not see it: check the broker checks above and the gateway log.' : 'Start it: `synacl-gateway run`, or `synacl-gateway service install`.');
      if (gwView.configCurrent === true) ok('gateway-config', `configuration current (hash ${gwView.configHash})`);
      else if (gwView.configCurrent === false) bad('gateway-config', `the gateway is not on the latest configuration (gateway ${gwView.gatewayConfigHash}, platform ${gwView.configHash})`, 'Press Resend config on the gateway page, or restart the gateway: it then fetches the latest configuration.');
      else info('gateway-config', 'the gateway has not asked for its configuration yet');
      if (gwView.updating) info('gateway-busy', `the platform marks the gateway busy (${gwView.updating}) — restart/reset are refused until it confirms`);
      if (!gwView.protocols) bad('gateway-caps', 'no capability report stored for this gateway', 'The gateway sends one on every connect; if it is connected, restart it.');
      else ok('gateway-caps', `capabilities: ${gwView.protocols.join(', ') || 'no protocols'}`);

      // Feature flags (public endpoint).
      let features = {};
      try {
        const st = await api.platformStatus(tenant);
        features = (st && st.features) || {};
        const on = (k) => !!(features[k] && (features[k].enabled ?? features[k]));
        const enabled = PROTOCOL_FLAGS.filter(([k]) => on(k)).map(([, p]) => p);
        const disabled = PROTOCOL_FLAGS.filter(([k]) => !on(k)).map(([, p]) => p);
        if (enabled.length) ok('features', `enabled for this account: ${enabled.join(', ')}`);
        if (disabled.length) info('features', `not enabled for this account: ${disabled.join(', ')} (devices of these protocols cannot be added)`);
        if (on('gateway_buffering')) ok('feature-buffering', 'store-and-forward replay is enabled');
        else if (runtime && runtime.buffer && runtime.buffer.records > 0) bad('feature-buffering', 'store-and-forward replay is not enabled for this account, so replayed readings are discarded', 'Ask Synacl support to enable gateway buffering for the account.');
        else info('feature-buffering', 'store-and-forward replay is not enabled for this account (replayed readings would be discarded)');
      } catch (err) {
        info('features', `feature flags not checked: ${clip(err.message)}`);
      }

      // Devices of this gateway — never print conn.
      let mine = [];
      try {
        mine = (await api.devices(tenant)).filter((x) => x && String(x.gateway) === gwView.id && x.status !== -1);
      } catch (err) {
        bad('devices', `could not list devices: ${clip(err.message)}`);
      }
      const deviceViews = [];
      if (!mine.length) info('devices', 'no devices attached to this gateway', 'Add a device to this gateway in the app; the platform sends it to the gateway automatically.');
      else say(`  ${mine.length} device(s) on this gateway${mine.length > MAX_DEVICE_CHECKS ? ` (checking the first ${MAX_DEVICE_CHECKS})` : ''}:\n`);
      for (const dev of mine.slice(0, MAX_DEVICE_CHECKS)) {
        const id = String(dev._id);
        const v = { id, name: dev.name, protocol: dev.protocol };
        deviceViews.push(v);
        const label = `${id} ${dev.protocol}${dev.name ? ` "${clip(dev.name, 40)}"` : ''}`;
        try {
          const s = await api.deviceStatus(id);
          v.online = !!s.online; v.fault = !!s.fault; v.paused = !!(s.read_paused && s.read_paused.active);
        } catch (err) { v.statusError = clip(err.message, 80); }
        try {
          const r = await api.rateStats(id);
          v.suspended = !!r.suspended; v.suspendedUntil = r.suspendedUntil || null; v.banned = !!r.banned;
          v.violations24h = Number(r.violations24h) || 0; v.planMinIntervalMs = Number(r.intervalMs) || 0;
        } catch (err) { v.rateError = clip(err.message, 80); }
        v.intervalMs = deviceIntervalMs(dev);
        if (gwView.protocols && !gwView.protocols.includes(dev.protocol)) bad(`device:${id}`, `${label}: this gateway does not support protocol "${dev.protocol}"`, 'Attach it to a gateway that lists the protocol, or install a driver for it (see docs/writing-a-driver.md).');
        else if (v.banned) bad(`device:${id}`, `${label}: banned by the platform`, 'Contact Synacl support.');
        else if (v.suspended) bad(`device:${id}`, `${label}: suspended for publishing too fast${v.suspendedUntil ? ` (until ${v.suspendedUntil})` : ''}`, 'The platform suspends a device that keeps publishing faster than the plan allows. Check that nothing else publishes for this device (only one gateway instance!), then wait for it to lift.');
        else if (v.intervalMs && v.planMinIntervalMs && v.intervalMs < v.planMinIntervalMs) bad(`device:${id}`, `${label}: interval ${v.intervalMs} ms is below the plan's minimum ${v.planMinIntervalMs} ms`, 'Raise the device interval in the app to at least the plan minimum, then press Resend config.');
        else if (v.violations24h > 0) bad(`device:${id}`, `${label}: ${v.violations24h} rate violation(s) in the last 24 h`, 'Messages arrived closer together than the plan allows. Only one gateway process may run per gateway id.');
        else if (v.statusError) info(`device:${id}`, `${label}: status not checked (${v.statusError})`);
        else if (v.online) ok(`device:${id}`, `${label}: online${v.paused ? ' (reads paused)' : ''}`);
        else bad(`device:${id}`, `${label}: offline${v.fault ? ' (the gateway reports it unreachable)' : ''}`, v.fault ? 'The gateway cannot read it: check the device, its address and the reason in the gateway\'s device status.' : 'The gateway has not reported it for 90 s. Is the gateway running and on the latest config?');
      }

      // Events of the last 24 h that point at a cause.
      const since = d.now() - DAY_MS;
      const ids = new Set([gwView.id, config.gateway, ...mine.map((x) => String(x._id))]);
      const recent = {};
      for (const type of EVENT_TYPES) {
        try {
          recent[type] = (await api.events(tenant, { type, limit: 50 }))
            .filter((e) => e && Date.parse(e.createdAt || e.ts) >= since && (!e.source || !e.source.id || ids.has(String(e.source.id))));
        } catch (err) {
          recent[type] = null;
          info(`events:${type}`, `${type} events not checked: ${clip(err.message, 80)}`);
        }
      }
      const n = (t) => (recent[t] ? recent[t].length : 0);
      const latest = (t) => (recent[t] && recent[t][0] ? ` — latest: "${clip(recent[t][0].message, 120)}"` : '');
      if (recent['gateway/config-too-large']) {
        if (n('gateway/config-too-large')) bad('events:config-too-large', `${n('gateway/config-too-large')} config-too-large event(s) in 24 h${latest('gateway/config-too-large')}`, 'The platform refuses (silently, to the gateway) a config larger than the gateway said it can take. Remove devices/tags, or reconnect so the gateway re-sends its capabilities.');
        else ok('events:config-too-large', 'no config-too-large events in 24 h');
      }
      if (recent['gateway/config-sync']) {
        if (n('gateway/config-sync')) ok('events:config-sync', `${n('gateway/config-sync')} config sync(s) in 24 h${latest('gateway/config-sync')}`);
        else info('events:config-sync', 'no config syncs in 24 h (the gateway asks on every connect)');
      }
      const quota = n('quota/suspended') + n('quota/rate-limited');
      if (recent['quota/suspended'] && recent['quota/rate-limited']) {
        if (quota) bad('events:quota', `${quota} rate-limit event(s) in 24 h${latest('quota/suspended') || latest('quota/rate-limited')}`, 'Only one process may publish for a gateway id, and device intervals must respect the plan minimum.');
        else ok('events:quota', 'no rate-limit events in 24 h');
      }
      if (recent['modbus/timeout']) {
        if (n('modbus/timeout')) bad('events:modbus', `${n('modbus/timeout')} Modbus timeout(s) in 24 h${latest('modbus/timeout')}`, 'Check the Modbus device address, port and unit id, and the network path to it.');
        else ok('events:modbus', 'no Modbus timeouts in 24 h');
      }
      if (recent['device/offline']) {
        if (n('device/offline') > 3) bad('events:offline', `${n('device/offline')} device/offline events in 24 h — devices are flapping${latest('device/offline')}`, 'Frequent offline events usually mean the gateway process restarts or loses the broker; look at the gateway log.');
        else info('events:offline', `${n('device/offline')} device/offline event(s) in 24 h`);
      }
      api.logout();
      return finish({ gateway: gwView, devices: deviceViews });
    } catch (err) {
      if (err && err.code === 'ABORTED') { io.stderr.write('\ncancelled\n'); return EXIT.RUNTIME; }
      io.stderr.write(`error: doctor failed: ${err && err.message}\n`);
      return EXIT.RUNTIME;
    }
  };
}

export default createDoctorCommand();
