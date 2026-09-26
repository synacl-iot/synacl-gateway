import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/cli/args.js';
import { createServiceCommand, renderUnit, serviceEnv, systemdQuote, versionManagerWarnings } from '../../src/cli/service.js';
import { PASSWORD, makeIo, sampleConfig, tmpHome } from '../_support/cli/helpers.js';

const BIN = '/usr/lib/node_modules/synacl-gateway/bin/synacl-gateway.js';

function setup(t, { env = {}, script = BIN, execPath = '/usr/bin/node', user = 'pi', root = false, withConfig = true, platform = 'linux', systemd = true, ioEnv = {} } = {}) {
  const base = tmpHome(t);
  const home = join(base, '.synacl-gateway');
  if (withConfig) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify(sampleConfig()));
  }
  const io = makeIo({ home, env: ioEnv });
  const ran = [];
  let tempText = null;
  const cmd = createServiceCommand({
    env: { execPath, script, home: env.home ?? home, user, root, userHome: base },
    exec: (c, args) => { ran.push([c, ...args]); return 0; },
    capture: () => ({ status: 0, stdout: 'Linger=no\n' }),
    isSystemd: () => systemd,
    platform,
    writeTemp: (text) => { tempText = text; const p = join(base, 'unit.tmp'); writeFileSync(p, text); return p; },
  });
  return { io, cmd, ran, home, base, temp: () => tempText };
}

test('the unit runs this Node binary with the real path of this bin, as the invoking user', () => {
  const unit = renderUnit({ execPath: '/usr/bin/node', script: BIN, home: '/home/pi/.synacl-gateway', user: 'pi' });
  assert.match(unit, new RegExp(`^ExecStart=/usr/bin/node ${BIN} run --log-format json$`, 'm'));
  assert.match(unit, /^User=pi$/m);
  assert.match(unit, /^Environment=SYNACL_GATEWAY_HOME=\/home\/pi\/\.synacl-gateway$/m);
  assert.match(unit, /^Wants=network-online\.target time-sync\.target$/m);
  assert.match(unit, /^After=network-online\.target time-sync\.target$/m);
  for (const line of ['ExecReload=/bin/kill -HUP $MAINPID', 'Restart=always', 'RestartSec=5', 'TimeoutStopSec=20', 'NoNewPrivileges=true', 'ProtectSystem=strict',
    'ProtectHome=read-only', 'ReadWritePaths=/home/pi/.synacl-gateway', 'PrivateTmp=true', 'ProtectControlGroups=true',
    'RestrictSUIDSGID=true', 'LockPersonality=true', 'WantedBy=multi-user.target']) {
    assert.ok(unit.split('\n').includes(line), line);
  }
  assert.doesNotMatch(unit, /^MemoryDenyWriteExecute/m, 'V8 needs W+X memory');
});

test('--user: default.target, no User= and no system-only dependencies or mount sandboxing', () => {
  const unit = renderUnit({ execPath: '/usr/bin/node', script: BIN, home: '/home/pi/.synacl-gateway', user: 'pi', userUnit: true });
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /^User=/m);
  assert.doesNotMatch(unit, /network-online|time-sync|ProtectSystem|ReadWritePaths/);
  assert.match(unit, /^NoNewPrivileges=true$/m);
});

test('paths with spaces and specifiers are quoted for systemd', () => {
  assert.equal(systemdQuote('/opt/my node/bin/node'), '"/opt/my node/bin/node"');
  assert.equal(systemdQuote('/a/100%/x'), '/a/100%%/x');
  assert.equal(systemdQuote('/a/$HOME'), '/a/$$HOME');
  const unit = renderUnit({ execPath: '/opt/my node/node', script: BIN, home: '/srv/gw home', user: 'pi' });
  assert.match(unit, /^ExecStart="\/opt\/my node\/node" /m);
  assert.match(unit, /^Environment="SYNACL_GATEWAY_HOME=\/srv\/gw home"$/m);
});

test('print renders the unit; the password never appears in it', async (t) => {
  const { io, cmd } = setup(t);
  assert.equal(await cmd(['print'], io), EXIT.OK);
  assert.match(io.out(), /^\[Service\]$/m);
  assert.ok(!io.all().includes(PASSWORD));
});

test('running from the npx cache is refused', async (t) => {
  const { io, cmd, ran } = setup(t, { script: '/home/pi/.npm/_npx/9f86d081/node_modules/synacl-gateway/bin/synacl-gateway.js' });
  assert.equal(await cmd(['install'], io), EXIT.USAGE);
  assert.match(io.err(), /npx cache/);
  assert.match(io.err(), /npm i -g synacl-gateway/);
  assert.deepEqual(ran, []);
  const p = setup(t, { script: '/home/pi/.npm/_npx/9f86/node_modules/.bin/synacl-gateway' });
  assert.equal(await p.cmd(['print'], p.io), EXIT.USAGE);
});

test('a version-manager Node is warned about', async (t) => {
  assert.equal(versionManagerWarnings('/home/pi/.nvm/versions/node/v22.9.0/bin/node').length, 1);
  assert.equal(versionManagerWarnings('/home/pi/.volta/tools/image/node/22/bin/node').length, 1);
  assert.equal(versionManagerWarnings('/home/pi/.local/share/fnm/node-versions/v22/installation/bin/node').length, 1);
  assert.equal(versionManagerWarnings('/home/linuxbrew/.linuxbrew/Cellar/node/24.1.0/bin/node').length, 1);
  assert.equal(versionManagerWarnings('/usr/bin/node').length, 0);
  const { io, cmd } = setup(t, { execPath: '/home/pi/.nvm/versions/node/v22.9.0/bin/node' });
  assert.equal(await cmd(['print'], io), EXIT.OK);
  assert.match(io.err(), /version manager/);
});

test('install: prints the commands, then installs with sudo, reloads and enables', async (t) => {
  const { io, cmd, ran, temp } = setup(t);
  assert.equal(await cmd(['install'], io), EXIT.OK, io.all());
  assert.deepEqual(ran, [
    ['sudo', 'install', '-m', '0644', ran[0][4], '/etc/systemd/system/synacl-gateway.service'],
    ['sudo', 'systemctl', 'daemon-reload'],
    ['sudo', 'systemctl', 'enable', '--now', 'synacl-gateway'],
  ]);
  const printed = io.out();
  assert.ok(printed.indexOf('Running:') < printed.indexOf('Installed'), 'commands shown before running');
  assert.match(printed, /sudo systemctl enable --now synacl-gateway/);
  assert.match(temp(), /^User=pi$/m);
  assert.ok(!temp().includes(PASSWORD));
});

test('install as root (sudo) drops the sudo prefix and runs as SUDO_USER with their home', { skip: process.platform === 'win32' && '/etc/passwd paths' }, async (t) => {
  const base = tmpHome(t);
  const userHome = join(base, 'home', 'pi');
  mkdirSync(join(userHome, '.synacl-gateway'), { recursive: true });
  writeFileSync(join(userHome, '.synacl-gateway', 'config.json'), JSON.stringify(sampleConfig()));
  const io = makeIo({ home: '/root/.synacl-gateway', env: { SUDO_USER: 'pi' } });
  const env = serviceEnv(io, { env: { root: true, execPath: '/usr/bin/node', script: BIN }, passwd: () => `root:x:0:0:root:/root:/bin/bash\npi:x:1000:1000:,,,:${userHome}:/bin/bash\n` });
  assert.equal(env.user, 'pi');
  assert.equal(env.home, join(userHome, '.synacl-gateway'));
  const ran = [];
  let unit = '';
  const cmd = createServiceCommand({
    env, exec: (c, a) => { ran.push([c, ...a]); return 0; }, isSystemd: () => true, platform: 'linux',
    writeTemp: (text) => { unit = text; return join(base, 'u'); },
  });
  assert.equal(await cmd(['install'], io), EXIT.OK, io.all());
  assert.equal(ran[0][0], 'install');
  assert.equal(ran[1].join(' '), 'systemctl daemon-reload');
  assert.match(unit, /^User=pi$/m);
  assert.ok(unit.includes(`ReadWritePaths=${join(userHome, '.synacl-gateway')}`));
});

test('install --user: user unit dir, no sudo, linger hint', async (t) => {
  const { io, cmd, ran, base } = setup(t);
  assert.equal(await cmd(['install', '--user'], io), EXIT.OK, io.all());
  const unitFile = join(base, '.config', 'systemd', 'user', 'synacl-gateway.service');
  assert.deepEqual(ran.map((c) => c[0]), ['mkdir', 'install', 'systemctl', 'systemctl']);
  assert.equal(ran[1][4], unitFile);
  assert.deepEqual(ran[3], ['systemctl', '--user', 'enable', '--now', 'synacl-gateway']);
  assert.match(io.out(), /sudo loginctl enable-linger pi/);
  const r = setup(t, { root: true });
  assert.equal(await r.cmd(['install', '--user'], r.io), EXIT.USAGE);
});

test('install without a config.json asks for init first', async (t) => {
  const { io, cmd, ran } = setup(t, { withConfig: false });
  assert.equal(await cmd(['install'], io), EXIT.USAGE);
  assert.match(io.err(), /Run the init line/);
  assert.deepEqual(ran, []);
});

test('--dry-run prints the unit and the commands without running anything', async (t) => {
  const { io, cmd, ran } = setup(t, { platform: 'darwin', systemd: false });
  assert.equal(await cmd(['install', '--dry-run'], io), EXIT.OK, io.all());
  assert.deepEqual(ran, []);
  assert.match(io.out(), /Would run:/);
  assert.match(io.out(), /ExecStart=/);
});

test('not Linux / no systemd: exit 2 with guidance; print still works', async (t) => {
  for (const [platform, systemd, re] of [['darwin', false, /macOS/], ['win32', false, /Windows/], ['linux', false, /systemd is not running/]]) {
    const { io, cmd } = setup(t, { platform, systemd });
    assert.equal(await cmd(['install'], io), EXIT.USAGE, platform);
    assert.match(io.err(), re);
    const p = setup(t, { platform, systemd });
    assert.equal(await p.cmd(['print'], p.io), EXIT.OK);
  }
});

test('uninstall disables, removes and reloads; status passes through systemctl', async (t) => {
  const { io, cmd, ran } = setup(t);
  assert.equal(await cmd(['uninstall'], io), EXIT.OK);
  assert.deepEqual(ran.map((c) => c.join(' ')), [
    'sudo systemctl disable --now synacl-gateway',
    'sudo rm -f /etc/systemd/system/synacl-gateway.service',
    'sudo systemctl daemon-reload',
  ]);
  assert.match(io.out(), /were kept/);
  const s = setup(t);
  assert.equal(await s.cmd(['status'], s.io), EXIT.OK);
  assert.deepEqual(s.ran[0], ['sudo', 'systemctl', 'status', 'synacl-gateway', '--no-pager']);
});

test('usage errors: no action, unknown action, unknown flag', async (t) => {
  const { io, cmd } = setup(t);
  assert.equal(await cmd([], io), EXIT.USAGE);
  assert.equal(await cmd(['start'], io), EXIT.USAGE);
  assert.equal(await cmd(['print', '--system'], io), EXIT.USAGE);
  assert.equal(await cmd(['--help'], io), EXIT.OK);
});

test('the reference unit in examples/ matches what print renders for a standard Pi install', () => {
  const ref = readFileSync(new URL('../../examples/systemd/synacl-gateway.service', import.meta.url), 'utf8');
  const rendered = renderUnit({ execPath: '/usr/bin/node', script: BIN, home: '/home/pi/.synacl-gateway', user: 'pi' });
  const body = (s) => s.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(body(ref), body(rendered));
});
