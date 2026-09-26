// Fakes for doctor tests: a scripted platform API behind a stub fetch, and CliIO collectors.
import { PassThrough } from 'node:stream';

export const TENANT = '64b7a1000000000000000001';
export const GATEWAY = 'gw_doctor_01';
export const GW_ID = '64b7a10000000000000000a1';
export const BROKER_PASSWORD = 'Brk-pass-DO-NOT-PRINT-1';
export const ACCOUNT_PASSWORD = 'acct-pass-DO-NOT-PRINT-2';
export const GATEWAY_RECORD_PASSWORD = 'gwrec-pass-DO-NOT-PRINT-3';
export const CONN_SECRET = 'bridge-pass-DO-NOT-PRINT-4';
export const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);

export function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.c2lnbmF0dXJl`;
}
export const ACCESS_TOKEN = jwt({ _id: TENANT, tenantId: TENANT, roles: ['user'] });

export function fileConfig(overrides = {}) {
  return {
    schema: 1, broker: 'mqtts://mqtt.example.test:8883', tenant: TENANT, gateway: GATEWAY,
    username: '123456', password: BROKER_PASSWORD, api: 'https://api.example.test',
    tls: { caFile: null, rejectUnauthorized: true }, drivers: [], driverDir: null, configCap: null, minIntervalMs: 1000,
    backfill: { maxBytes: 1, maxAgeHours: 1, batchIntervalMs: 1000 }, host: { diskPath: '/' }, bridge: { rejectUnauthorized: true },
    log: { level: 'info', format: 'auto' }, createdAt: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}

/** The platform's answers; tests mutate a copy. */
export function platformState() {
  return {
    loginStatus: 200,
    loginBody: { tokens: { access: ACCESS_TOKEN, refresh: 'refresh-token-DO-NOT-PRINT' }, user: { email: 'a@example.test', password: 'hash' }, success: true },
    gateways: [{
      _id: GW_ID, name: 'Plant PC', type: 'software', esp_chip_id: GATEWAY, user_id: TENANT, username: '123456', password: GATEWAY_RECORD_PASSWORD,
      accesskey: 'accesskey-DO-NOT-PRINT', firmware: '0.1.0', online: true, degraded: false, configHash: 111, gatewayConfigHash: 111, configCurrent: true, updating: null,
      capabilities: { protocols: ['host', 'mqtt-bridge', 'modbus-tcp'], sensorModels: {} },
    }],
    features: { protocol_host: { enabled: true }, protocol_mqtt_bridge: { enabled: true }, protocol_modbus_tcp: { enabled: true }, gateway_buffering: { enabled: true } },
    devices: [
      { _id: '64b7a10000000000000000d1', name: 'CPU', protocol: 'host', gateway: GW_ID, status: 1, conn: { sampleIntervalMs: 10000 } },
      { _id: '64b7a10000000000000000d2', name: 'Plug', protocol: 'mqtt-bridge', gateway: GW_ID, status: 1, conn: { brokerUrl: 'mqtt://192.168.1.5', username: 'u', password: CONN_SECRET, sampleIntervalMs: 10000 } },
      { _id: '64b7a10000000000000000d9', name: 'Other gw', protocol: 'rs485', gateway: '64b7a10000000000000000a2', status: 1, conn: {} },
    ],
    status: { online: true, in_alert: false, fault: false, read_paused: { active: false } },
    statusById: {},
    rate: { violations24h: 0, suspended: false, suspendedUntil: null, banned: false, intervalMs: 5000 },
    rateById: {},
    events: {},
    calls: [],
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date: new Date(NOW).toUTCString() } });

/** A fetch that answers like the platform, from `st`. Records every call (without bodies). */
export function stubFetch(st) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const auth = init.headers && init.headers.authorization;
    st.calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: !!auth });
    const authed = auth === `Bearer ${ACCESS_TOKEN}`;
    const p = url.pathname;
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { date: new Date(NOW).toUTCString() } });
    if (p === '/auth/login' && method === 'POST') {
      const body = JSON.parse(init.body);
      if (st.loginStatus !== 200 || body.password !== ACCOUNT_PASSWORD) return json(401, { message: 'wrong password' });
      return json(200, st.loginBody);
    }
    if (p === '/platform/status') return json(200, { version: '1.21.0', maintenance: { enabled: false }, announcements: [], features: st.features });
    if (!authed) return json(401, { message: 'not authenticated' });
    let m;
    if ((m = /^\/gateway\/userid\/([^/]+)$/.exec(p))) return json(200, { gateways: m[1] === TENANT ? st.gateways : [], betaEligible: false });
    if ((m = /^\/devices\/user\/([^/]+)$/.exec(p))) return json(200, { devices: m[1] === TENANT ? st.devices : [] });
    if ((m = /^\/devices\/([^/]+)\/status$/.exec(p))) return json(200, st.statusById[m[1]] || st.status);
    if ((m = /^\/devices\/([^/]+)\/rate-stats$/.exec(p))) return json(200, { success: true, data: { deviceId: m[1], ...(st.rateById[m[1]] || st.rate) } });
    if ((m = /^\/events\/user\/([^/]+)$/.exec(p))) {
      const type = url.searchParams.get('type');
      return json(200, { success: true, data: st.events[type] || [], total: 0, page: 1, limit: 50, retentionHours: 24 });
    }
    return json(404, { message: 'not found' });
  };
}

export function collectIO({ env = {}, home = '/nonexistent-home', tty = false } = {}) {
  const out = [];
  const err = [];
  const stdin = new PassThrough();
  stdin.isTTY = tty;
  return {
    io: {
      stdout: { write: (s) => { out.push(String(s)); return true; }, isTTY: false },
      stderr: { write: (s) => { err.push(String(s)); return true; }, isTTY: false },
      stdin,
      env,
      home,
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    stdin,
  };
}

/** Deps for createDoctorCommand with every side effect stubbed. */
export function doctorDeps(st, over = {}) {
  return {
    fetch: stubFetch(st),
    now: () => NOW,
    platform: 'linux',
    nodeVersion: '22.9.0',
    loadFileConfig: () => ({ config: fileConfig(), path: '/home/pi/.synacl-gateway/config.json', fromFile: true, envKeys: [] }),
    stat: () => ({ mode: 0o100600 }),
    verifyConnection: async ({ clientId }) => { st.probeClientId = clientId; return { ok: true, stage: 'suback', grants: [1, 1, 1, 1, 1, 1, 1], message: 'connected; 7/7 subscriptions granted' }; },
    openState: async () => ({
      lockHolder: () => ({ pid: 4242, startedAt: NOW - 3_600_000, hostname: 'pi', alive: true }),
      readRuntime: () => ({ updatedAt: NOW - 5_000, connected: true, configSynced: true, configHash: 111, buffer: { records: 0 } }),
    }),
    probeSkew: async () => 300,
    clientSuffix: () => 'beef',
    promptHidden: async () => { throw new Error('prompted for a password'); },
    promptLine: async () => '',
    ...over,
  };
}
