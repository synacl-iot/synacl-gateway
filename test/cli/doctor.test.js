import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoctorCommand } from '../../src/cli/doctor.js';
import {
  ACCESS_TOKEN, ACCOUNT_PASSWORD, BROKER_PASSWORD, CONN_SECRET, GATEWAY, GATEWAY_RECORD_PASSWORD, NOW,
  collectIO, doctorDeps, fileConfig, platformState,
} from '../_support/verify/doctor-fakes.js';

const SECRETS = [BROKER_PASSWORD, ACCOUNT_PASSWORD, GATEWAY_RECORD_PASSWORD, CONN_SECRET, ACCESS_TOKEN, 'refresh-token-DO-NOT-PRINT', 'accesskey-DO-NOT-PRINT'];

function assertNoSecrets(text) {
  for (const s of SECRETS) assert.ok(!text.includes(s), `output leaked a secret: ${s.slice(0, 12)}…`);
}

async function runDoctor(st, { argv = ['--email', 'a@example.test'], env = { SYNACL_PASSWORD: ACCOUNT_PASSWORD }, over = {}, tty = false } = {}) {
  const c = collectIO({ env, tty });
  const code = await createDoctorCommand(doctorDeps(st, over))(argv, c.io);
  return { code, out: c.stdout(), err: c.stderr() };
}

test('a healthy setup: every check ok, exit 0, no secrets printed', async () => {
  const st = platformState();
  const { code, out, err } = await runDoctor(st);
  assert.equal(code, 0, out);
  assert.match(out, /\[ok\] Node\.js 22\.9\.0/);
  assert.match(out, /\[ok\] config\.json is private \(mode 0600\)/);
  assert.match(out, /\[ok\] 7\/7 subscriptions granted/);
  assert.match(out, /\[ok\] synacl-gateway is running \(pid 4242\), connected, config current/);
  assert.match(out, /\[ok\] configuration current \(hash 111\)/);
  assert.match(out, /\[ok\] 64b7a10000000000000000d1 host "CPU": online/);
  assert.match(out, /recorded like any sign-in on the account/);
  assert.doesNotMatch(out, /\[!!\]/);
  assert.doesNotMatch(out, /Other gw/, 'devices of other gateways are not listed');
  assertNoSecrets(out + err);
  assert.equal(st.probeClientId, `${GATEWAY}-doctor-beef`, 'the broker probe uses its own client id');
  // Routes and shapes the platform actually serves.
  const paths = st.calls.map((c) => `${c.method} ${c.path}`);
  assert.ok(paths.includes('POST /auth/login'));
  assert.ok(paths.includes('GET /gateway/userid/64b7a1000000000000000001'));
  assert.ok(paths.includes('GET /platform/status'));
  assert.ok(paths.includes('GET /devices/user/64b7a1000000000000000001'));
  assert.ok(paths.includes('GET /devices/64b7a10000000000000000d1/status'));
  assert.ok(paths.includes('GET /devices/64b7a10000000000000000d1/rate-stats'));
  assert.ok(st.calls.filter((c) => c.path.startsWith('/events/user/')).length === 6);
  assert.equal(st.calls.find((c) => c.path === '/platform/status').query.sid, '64b7a1000000000000000001');
  assert.equal(st.calls.find((c) => c.path === '/platform/status').auth, false, 'platform status is public');
});

test('problems are reported with fixes and exit 5', async () => {
  const st = platformState();
  st.gateways[0].online = false;
  st.gateways[0].configCurrent = false;
  st.gateways[0].gatewayConfigHash = 99;
  st.rateById['64b7a10000000000000000d2'] = { violations24h: 25, suspended: true, suspendedUntil: '2026-09-26T13:00:00.000Z', banned: false, intervalMs: 5000 };
  st.events['gateway/config-too-large'] = [{ type: 'gateway/config-too-large', createdAt: new Date(NOW - 3_600_000).toISOString(), source: { kind: 'gateway', id: '64b7a10000000000000000a1' }, message: 'Configuration is 5000 bytes but …' }];
  st.events['quota/suspended'] = [{ type: 'quota/suspended', createdAt: new Date(NOW - 2 * 86_400_000).toISOString(), source: { kind: 'device', id: '64b7a10000000000000000d2' }, message: 'old' }];
  const { code, out } = await runDoctor(st);
  assert.equal(code, 5);
  assert.match(out, /\[!!\] the platform shows the gateway offline/);
  assert.match(out, /\[!!\] the gateway is not on the latest configuration \(gateway 99, platform 111\)/);
  assert.match(out, /→ Press Resend config/);
  assert.match(out, /\[!!\] 64b7a10000000000000000d2 mqtt-bridge "Plug": suspended for publishing too fast \(until 2026-09-26T13:00:00.000Z\)/);
  assert.match(out, /\[!!\] 1 config-too-large event\(s\) in 24 h/);
  assert.match(out, /\[ok\] no rate-limit events in 24 h/, 'events older than 24 h are ignored');
  assertNoSecrets(out);
});

test('a wrong password is a problem, and nothing else is fetched with auth', async () => {
  const st = platformState();
  const { code, out } = await runDoctor(st, { env: { SYNACL_PASSWORD: 'nope' } });
  assert.equal(code, 5);
  assert.match(out, /\[!!\] sign-in failed: POST \/auth\/login: wrong password/);
  assert.ok(!st.calls.some((c) => c.auth));
  assert.ok(!out.includes('nope'));
});

test('the account in config.json must be the one signed in to', async () => {
  const st = platformState();
  const other = platformState().loginBody;
  const payload = { _id: '64b7a10000000000000000ee', tenantId: '64b7a10000000000000000ee' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  other.tokens.access = `${b64({ alg: 'HS256' })}.${b64(payload)}.x`;
  st.loginBody = other;
  const { code, out } = await runDoctor(st, { over: {} });
  assert.equal(code, 5);
  assert.match(out, /\[!!\] you signed in to account 64b7a10000000000000000ee, but config\.json is for account 64b7a1000000000000000001/);
});

test('--skip-cloud and a missing e-mail never sign in', async () => {
  const st = platformState();
  const a = await runDoctor(st, { argv: ['--skip-cloud'] });
  assert.equal(a.code, 0);
  assert.match(a.out, /\[--\] skipped \(--skip-cloud\)/);
  const b = await runDoctor(st, { argv: [] });
  assert.equal(b.code, 0);
  assert.match(b.out, /skipped: pass --email/);
  assert.ok(!st.calls.some((c) => c.path === '/auth/login'));
});

test('the password is never a flag', async () => {
  const st = platformState();
  const r = await runDoctor(st, { argv: ['--email', 'a@example.test', '--password', 'x'] });
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --password/);
});

test('the password prompt is used when SYNACL_PASSWORD is not set', async () => {
  const st = platformState();
  let asked = null;
  const r = await runDoctor(st, { env: {}, over: { promptHidden: async (q) => { asked = q; return ACCOUNT_PASSWORD; } } });
  assert.equal(r.code, 0, r.out);
  assert.match(asked, /Password for a@example\.test/);
});

test('local problems: world-readable config, broker refusing subscriptions, gateway not running', async () => {
  const st = platformState();
  const r = await runDoctor(st, {
    argv: ['--skip-cloud'],
    over: {
      stat: () => ({ mode: 0o100644 }),
      verifyConnection: async () => ({ ok: false, stage: 'suback', code: 128, grants: [128, 128, 128, 128, 128, 128, 128], deniedFilters: ['a'], message: 'the broker accepted the credentials but refused 7 of 7 subscriptions', hint: '--tenant and --gateway do not match' }),
      openState: async () => ({ lockHolder: () => null, readRuntime: () => null }),
      probeSkew: async () => 7_400,
    },
  });
  assert.equal(r.code, 5);
  assert.match(r.out, /\[!!\] .*config\.json is readable by other users \(mode 0644\)/);
  assert.match(r.out, /→ chmod 600/);
  assert.match(r.out, /\[!!\] clock is 7\.4 s ahead/);
  assert.match(r.out, /\[ok\] broker accepted the credentials \(CONNACK\)/);
  assert.match(r.out, /\[!!\] the broker accepted the credentials but refused 7 of 7 subscriptions/);
  assert.match(r.out, /\[--\] synacl-gateway is not running here/);
});

test('no configuration is a problem with the init hint', async () => {
  const st = platformState();
  const err = Object.assign(new Error('no configuration at /x/config.json'), { hint: 'Copy the line from Gateways → Connection Info' });
  const r = await runDoctor(st, { over: { loadFileConfig: () => { throw err; } } });
  assert.equal(r.code, 5);
  assert.match(r.out, /\[!!\] no configuration at \/x\/config\.json/);
  assert.match(r.out, /→ Copy the line/);
});

test('--json: whitelisted fields only', async () => {
  const st = platformState();
  const r = await runDoctor(st, { argv: ['--email', 'a@example.test', '--json'] });
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.out);
  assert.equal(doc.problems, 0);
  assert.deepEqual(Object.keys(doc.gateway).sort(), ['configCurrent', 'configHash', 'degraded', 'firmware', 'gatewayConfigHash', 'id', 'name', 'online', 'protocols', 'type', 'updating'].sort());
  assert.ok(doc.devices.every((x) => !('conn' in x)));
  assert.ok(doc.checks.every((c) => ['ok', 'problem', 'info'].includes(c.status)));
  assertNoSecrets(r.out);
});

test('--help prints usage and exits 0', async () => {
  const r = await runDoctor(platformState(), { argv: ['--help'] });
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage: synacl-gateway doctor/);
  assert.match(r.out, /SYNACL_PASSWORD/);
  void fileConfig;
});
