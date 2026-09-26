// `synacl-gateway service` — a systemd unit that keeps the gateway running across reboots.
//
// The unit pins the exact Node binary and package that ran this command (not whatever `node`
// is on PATH at boot), so it only makes sense for a real install: running from the npx cache
// is refused, because npm deletes that cache whenever it likes.

/** @typedef {import('../core/types.js').CliIO} CliIO */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EXIT, UsageError, parseCommandArgs } from './args.js';
import { createOutput } from './output.js';
import { version } from '../index.js';

const OPTIONS = { user: { type: 'boolean' }, 'dry-run': { type: 'boolean' } };
const UNIT = 'synacl-gateway';
const ACTIONS = ['print', 'install', 'uninstall', 'status'];

export const USAGE = `Usage: synacl-gateway service <print|install|uninstall|status> [--user] [--dry-run]

Runs the gateway as a systemd service (Linux), so it starts at boot and restarts on failure.

  print       show the unit file that install would write
  install     write it to /etc/systemd/system and start it (asks for sudo)
  uninstall   stop and remove it (config.json and state are kept)
  status      systemctl status of the service

Options:
  --user      a per-user unit in ~/.config/systemd/user instead (no sudo; needs lingering to
              start at boot without a login)
  --dry-run   print the commands instead of running them
  -h, --help  show this help

Install synacl-gateway first (npm i -g synacl-gateway) and run "synacl-gateway init" as the
user the service should run as. Logs: journalctl -u synacl-gateway -f
`;

/**
 * Everything the unit depends on, gathered from the running process (tests pass their own).
 * @typedef {Object} ServiceEnv
 * @property {string} execPath  process.execPath
 * @property {string} script  realpath of the running bin
 * @property {string} home  SYNACL_GATEWAY_HOME the service will use
 * @property {string} user  account the service runs as
 * @property {boolean} root  whether this process is root
 */

/**
 * @param {{env?: Partial<ServiceEnv>, exec?: (cmd: string, args: string[]) => number,
 *   capture?: (cmd: string, args: string[]) => {status: number|null, stdout: string},
 *   isSystemd?: () => boolean, platform?: string, writeTemp?: (text: string) => string,
 *   passwd?: () => string}} [deps]
 */
export function createServiceCommand(deps = {}) {
  /** @param {string[]} argv @param {CliIO} io */
  return async function service(argv, io) {
    const out = createOutput(io);
    let values;
    let positionals;
    try {
      ({ values, positionals } = parseCommandArgs(argv, OPTIONS, { positionals: true }));
      if (!values.help && (positionals.length !== 1 || !ACTIONS.includes(positionals[0]))) {
        throw new UsageError(positionals.length ? 'unknown action — use print, install, uninstall or status' : 'missing action — use print, install, uninstall or status');
      }
    } catch (err) {
      out.error(err.message, 'Run "synacl-gateway service --help" for details.');
      return EXIT.USAGE;
    }
    if (values.help) { io.stdout.write(USAGE); return EXIT.OK; }
    const action = positionals[0];
    const userUnit = Boolean(values.user);
    const dryRun = Boolean(values['dry-run']);
    const platform = deps.platform ?? process.platform;
    const isSystemd = deps.isSystemd ?? (() => existsSync('/run/systemd/system'));

    if (action !== 'print' && !dryRun && (platform !== 'linux' || !isSystemd())) {
      out.error(platform === 'linux' ? 'systemd is not running on this machine' : `service ${action} needs Linux with systemd`, notSystemdHint(platform));
      return EXIT.USAGE;
    }

    let env;
    try {
      env = serviceEnv(io, deps);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      out.error(err.message, err.hint);
      return EXIT.USAGE;
    }

    if (userUnit && env.root) {
      out.error('--user installs a unit for the account running this command; run it without sudo, as the user the gateway should run as.');
      return EXIT.USAGE;
    }
    const paths = unitPaths(env, userUnit);
    const sudo = !userUnit && !env.root ? ['sudo'] : [];
    const systemctl = userUnit ? ['systemctl', '--user'] : [...sudo, 'systemctl'];
    const exec = deps.exec ?? ((cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1);

    if (action === 'status') {
      const code = runAll([[...systemctl, 'status', UNIT, '--no-pager']], { exec, out, dryRun, quiet: true });
      out.line('Gateway details (connection, devices, buffer): synacl-gateway status');
      return code === 0 ? EXIT.OK : EXIT.RUNTIME;
    }

    if (action === 'uninstall') {
      const cmds = [
        [...systemctl, 'disable', '--now', UNIT],
        [...sudo, 'rm', '-f', paths.unitFile],
        [...systemctl, 'daemon-reload'],
      ];
      const code = runAll(cmds, { exec, out, dryRun, keepGoing: true });
      if (code === 0 && !dryRun) out.line(`Removed. config.json and the gateway's state in ${env.home} were kept.`);
      return code === 0 ? EXIT.OK : EXIT.RUNTIME;
    }

    // print / install
    for (const w of versionManagerWarnings(env.execPath)) out.warn(w);
    if (isNpxPath(env.script)) {
      out.error('synacl-gateway is running from the npx cache, which npm cleans up — a service pointing there would break.',
        'Install it first: npm i -g synacl-gateway, then run: synacl-gateway service install');
      return EXIT.USAGE;
    }
    if (!userUnit && env.user === 'root') out.warn('the service will run as root; running it as a normal user is safer (run this command as that user, with sudo if needed).');
    const unit = renderUnit({ ...env, userUnit });

    if (action === 'print') {
      io.stdout.write(unit);
      return EXIT.OK;
    }

    const configFile = join(env.home, 'config.json');
    if (!existsSync(configFile)) {
      out.error(`no configuration at ${configFile}`, `Run the init line from Gateways → Connection Info as ${env.user} first${env.root ? ' (without sudo)' : ''}.`);
      return EXIT.USAGE;
    }

    const tmp = dryRun ? join(tmpdir(), `${UNIT}.service`) : (deps.writeTemp ?? writeTemp)(unit);
    const existed = existsSync(paths.unitFile);
    const cmds = userUnit
      ? [
        ['mkdir', '-p', paths.unitDir],
        ['install', '-m', '0644', tmp, paths.unitFile],
        [...systemctl, 'daemon-reload'],
        [...systemctl, 'enable', '--now', UNIT],
      ]
      : [
        [...sudo, 'install', '-m', '0644', tmp, paths.unitFile],
        [...systemctl, 'daemon-reload'],
        [...systemctl, 'enable', '--now', UNIT],
      ];
    // enable --now leaves an already running service on the old unit; restart picks up the new one.
    if (existed) cmds.push([...systemctl, 'restart', UNIT]);

    if (dryRun) {
      out.line(`Would write ${paths.unitFile}:\n`);
      out.line(unit);
    }
    let code;
    try {
      code = runAll(cmds, { exec, out, dryRun });
    } finally {
      if (!dryRun) rmSync(tmp, { force: true });
    }
    if (code !== 0) return EXIT.RUNTIME;
    if (dryRun) return EXIT.OK;

    out.line();
    out.line(`Installed and started ${UNIT} (${paths.unitFile}).`);
    out.line(`  status:  ${userUnit ? 'systemctl --user' : 'systemctl'} status ${UNIT}   ·   synacl-gateway status`);
    out.line(`  logs:    journalctl ${userUnit ? '--user-unit' : '-u'} ${UNIT} -f`);
    if (userUnit) {
      const capture = deps.capture ?? ((cmd, args) => {
        const r = spawnSync(cmd, args, { encoding: 'utf8' });
        return { status: r.status, stdout: r.stdout ?? '' };
      });
      const linger = capture('loginctl', ['show-user', env.user, '-p', 'Linger']);
      if (!/Linger=yes/.test(linger.stdout)) {
        out.line(`  To start it at boot without logging in:  sudo loginctl enable-linger ${env.user}`);
      }
    }
    return EXIT.OK;
  };
}

export default createServiceCommand();

/** The account and home the service runs with. Under sudo that is the invoking user, not root. */
export function serviceEnv(io, deps = {}) {
  const e = deps.env ?? {};
  const root = e.root ?? (typeof process.getuid === 'function' && process.getuid() === 0);
  let user = e.user;
  let userHome = null;
  if (!user) {
    const sudoUser = io.env.SUDO_USER;
    if (root && sudoUser && sudoUser !== 'root') {
      user = sudoUser;
      userHome = lookupHome(sudoUser, deps.passwd);
      if (!userHome && !io.env.SYNACL_GATEWAY_HOME) {
        throw new UsageError(`cannot find the home directory of ${sudoUser}`, { hint: 'Set SYNACL_GATEWAY_HOME explicitly (sudo --preserve-env=SYNACL_GATEWAY_HOME …).' });
      }
    } else {
      const me = userInfo();
      user = me.username;
      userHome = me.homedir;
    }
  }
  // Without an explicit SYNACL_GATEWAY_HOME, sudo may have pointed HOME at /root: use the
  // invoking user's home, which is where their `init` wrote config.json.
  const sudoHome = root && io.env.SUDO_USER && userHome && !io.env.SYNACL_GATEWAY_HOME ? join(userHome, '.synacl-gateway') : null;
  const home = e.home ?? sudoHome ?? io.home;
  let script = e.script;
  if (!script) {
    script = process.argv[1] ?? '';
    try { script = realpathSync(script); } catch { /* keep as given */ }
  }
  return { execPath: e.execPath ?? process.execPath, script, home: resolve(home), user, root, userHome: e.userHome ?? userHome };
}

function lookupHome(user, passwd) {
  const find = (text) => {
    for (const line of String(text ?? '').split('\n')) {
      const f = line.split(':');
      if (f[0] === user && f.length >= 7) return f[5] || null;
    }
    return null;
  };
  try {
    const home = find(passwd ? passwd() : readFileSync('/etc/passwd', 'utf8'));
    if (home) return home;
  } catch { /* fall through to getent */ }
  if (passwd) return null;
  const r = spawnSync('getent', ['passwd', user], { encoding: 'utf8' }); // LDAP / SSSD accounts
  return r.status === 0 ? find(r.stdout) : null;
}

function unitPaths(env, userUnit) {
  if (!userUnit) return { unitDir: '/etc/systemd/system', unitFile: `/etc/systemd/system/${UNIT}.service` };
  const unitDir = join(env.userHome ?? userInfo().homedir, '.config', 'systemd', 'user');
  return { unitDir, unitFile: join(unitDir, `${UNIT}.service`) };
}

export function isNpxPath(p) {
  return String(p).split(/[\\/]/).includes('_npx');
}

/** Warnings for a Node that lives inside a version manager: switching versions breaks the unit. */
export function versionManagerWarnings(execPath) {
  // Homebrew's Cellar path changes on every `brew upgrade node`, like a version manager's.
  const m = /[\\/](\.nvm|\.volta|\.fnm|fnm|\.asdf|\.nodenv|\.local[\\/]share[\\/]fnm|Cellar)[\\/]/.exec(execPath);
  if (!m) return [];
  return [`Node runs from a version manager (${execPath}). The unit pins this exact binary: after switching or removing this Node version, run "synacl-gateway service install" again — or install Node system-wide.`];
}

/** Quotes one argument for a systemd unit file (ExecStart/Environment/…). */
export function systemdQuote(arg) {
  const escaped = String(arg).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return /[\s"'\\;]/.test(String(arg)) ? `"${escaped}"` : escaped;
}

/**
 * The unit. A system unit runs as the invoking user with a read-only view of the system and of
 * /home except the gateway's own directory. A user unit can't depend on system targets or use
 * mount-namespace sandboxing without privileges, so it keeps only the options that are
 * enforced by the kernel (no_new_privs, seccomp).
 * @param {ServiceEnv & {userUnit?: boolean}} env
 */
export function renderUnit({ execPath, script, home, user, userUnit = false }) {
  const exec = [execPath, script, 'run', '--log-format', 'json'].map(systemdQuote).join(' ');
  const lines = [
    `# Generated by "synacl-gateway service" ${version}. Regenerate with: synacl-gateway service print${userUnit ? ' --user' : ''}`,
    '[Unit]',
    'Description=Synacl gateway',
    'Documentation=https://github.com/synacl-iot/synacl-gateway',
  ];
  if (!userUnit) {
    // Wait for the network and for NTP: a Pi without an RTC boots with a wrong clock.
    lines.push('Wants=network-online.target time-sync.target', 'After=network-online.target time-sync.target');
  }
  lines.push(
    '',
    '[Service]',
    'Type=simple',
    ...(userUnit ? [] : [`User=${user}`]),
    `Environment=${systemdQuote(`SYNACL_GATEWAY_HOME=${home}`)}`,
    `ExecStart=${exec}`,
    // `systemctl reload` → SIGHUP → run re-reads config.json without dropping the connection.
    'ExecReload=/bin/kill -HUP $MAINPID',
    'SyslogIdentifier=synacl-gateway',
    'Restart=always',
    'RestartSec=5',
    // The gateway publishes online:false and saves its state on SIGTERM; give it time.
    'TimeoutStopSec=20',
    'NoNewPrivileges=true',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
  );
  if (!userUnit) {
    lines.push(
      'ProtectSystem=strict',
      'ProtectHome=read-only',
      `ReadWritePaths=${systemdQuote(home)}`,
      'PrivateTmp=true',
      'ProtectControlGroups=true',
      // No MemoryDenyWriteExecute: V8's JIT needs writable+executable memory.
    );
  }
  lines.push('', '[Install]', `WantedBy=${userUnit ? 'default.target' : 'multi-user.target'}`, '');
  return lines.join('\n');
}

function writeTemp(text) {
  const p = join(tmpdir(), `${UNIT}.${randomBytes(4).toString('hex')}.service`);
  writeFileSync(p, text, { mode: 0o644, flag: 'wx' });
  return p;
}

function shellWords(cmd) {
  return cmd.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** Prints every command first (so the user knows what sudo is for), then runs them in order. */
function runAll(cmds, { exec, out, dryRun, keepGoing = false, quiet = false }) {
  if (!quiet || dryRun) {
    out.line(dryRun ? 'Would run:' : 'Running:');
    for (const c of cmds) out.line(`  ${shellWords(c)}`);
    if (!dryRun) out.line();
  }
  if (dryRun) return 0;
  let failed = 0;
  for (const c of cmds) {
    const code = exec(c[0], c.slice(1));
    if (code !== 0) {
      failed = code || 1;
      if (!quiet) out.error(`"${shellWords(c)}" failed (exit ${code})`);
      if (!keepGoing) break;
    }
  }
  return failed;
}

function notSystemdHint(platform) {
  if (platform === 'darwin') return 'On macOS, keep it running with Docker, or with launchd / a terminal multiplexer running "synacl-gateway run". "synacl-gateway service print" still shows the Linux unit.';
  if (platform === 'win32') return 'On Windows, run it with Docker, or as a scheduled task / NSSM service that starts "synacl-gateway run".';
  return 'Keep "synacl-gateway run" running with your init system, or use the Docker image.';
}
