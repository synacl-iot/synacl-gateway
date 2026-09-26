// A small client for the Synacl REST API, used by `doctor` only.
//
// The access token lives in this closure and nowhere else: it is never logged, never written to
// disk and never part of an error message. Every call has a timeout. Responses are returned as
// the platform sends them; callers whitelist what they print (a gateway record carries its own
// broker password, and a device record carries its `conn`, which can hold credentials).

const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  /** @param {string} message @param {{status?: number, code?: string, path?: string}} [info] */
  constructor(message, { status, code, path } = {}) {
    super(message);
    this.name = 'ApiError';
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
    if (path !== undefined) this.path = path;
  }
}

/** The payload of a JWT, without verifying it (only used to learn our own account id). */
export function decodeJwtPayload(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {{base: string, fetch?: typeof fetch, timeoutMs?: number, userAgent?: string}} opts
 */
export function createCloudApi({ base, fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = 'synacl-gateway-doctor' }) {
  if (!base) throw new ApiError('no API URL (set "api" in config.json or pass --api)', { code: 'ENOAPI' });
  if (typeof fetchImpl !== 'function') throw new ApiError('this Node.js has no fetch()', { code: 'ENOFETCH' });
  const root = String(base).replace(/\/+$/, '');
  let token = null;

  async function call(method, path, { body, auth = true, query } = {}) {
    const url = new URL(root + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { accept: 'application/json', 'user-agent': userAgent };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      if (!token) throw new ApiError('not signed in', { code: 'ENOAUTH', path });
      headers.authorization = `Bearer ${token}`;
    }
    let res;
    // A ref'd timer, not AbortSignal.timeout() (unref'd): doctor is short-lived, and on Node
    // 20/22 an unref'd timer lets the process exit mid-request instead of timing out.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
    try {
      res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, redirect: 'follow' });
    } catch (err) {
      const code = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'ETIMEDOUT' : (err && err.cause && err.cause.code) || 'ENETWORK';
      throw new ApiError(`${method} ${path}: ${code === 'ETIMEDOUT' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : `request failed (${code})`}`, { code, path });
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    const text = await res.text().catch(() => '');
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (!res.ok) {
      // Only the platform's own short message is repeated — never the request.
      const msg = data && typeof data.message === 'string' ? data.message.slice(0, 200)
        : data && data.error && typeof data.error.code === 'string' ? data.error.code : `HTTP ${res.status}`;
      throw new ApiError(`${method} ${path}: ${msg}`, { status: res.status, code: data && data.error && data.error.code, path });
    }
    return data;
  }

  return {
    get signedIn() { return token !== null; },

    /**
     * POST /auth/login. Resolves to who we are; the token is kept in memory only.
     * @returns {Promise<{tenant: string|null, userId: string|null}>}
     */
    async login(email, password) {
      const data = await call('POST', '/auth/login', { body: { email, password }, auth: false });
      const access = data && data.tokens && data.tokens.access;
      if (!access) throw new ApiError('POST /auth/login: no access token in the answer', { code: 'EPROTO' });
      token = access;
      const claims = decodeJwtPayload(access) || {};
      const id = (v) => (v == null ? null : String(v));
      return { tenant: id(claims.tenantId ?? claims._id), userId: id(claims._id) };
    },

    /** Forget the token. */
    logout() { token = null; },

    /** GET /gateway/userid/:tenant → the account's gateways (records include secrets: whitelist!). */
    async gateways(tenant) {
      const data = await call('GET', `/gateway/userid/${encodeURIComponent(tenant)}`);
      return Array.isArray(data && data.gateways) ? data.gateways : [];
    },

    /** GET /platform/status?sid=… (public) → {version, maintenance, features: {key: {enabled}}}. */
    async platformStatus(sid) {
      return call('GET', '/platform/status', { auth: false, query: { sid } });
    },

    /** GET /devices/user/:tenant?kind=device → the account's devices (records include `conn`: whitelist!). */
    async devices(tenant) {
      const data = await call('GET', `/devices/user/${encodeURIComponent(tenant)}`, { query: { kind: 'device' } });
      return Array.isArray(data && data.devices) ? data.devices : [];
    },

    /** GET /devices/:id/status → {online, in_alert, fault, read_paused, poll_disabled}. */
    async deviceStatus(id) {
      return call('GET', `/devices/${encodeURIComponent(id)}/status`);
    },

    /** GET /devices/:id/rate-stats → {violations24h, suspended, suspendedUntil, banned, intervalMs, …}. */
    async rateStats(id) {
      const data = await call('GET', `/devices/${encodeURIComponent(id)}/rate-stats`);
      return data && data.data ? data.data : data;
    },

    /** GET /events/user/:tenant?type=…&limit=… → newest first, within the account's retention. */
    async events(tenant, { type, limit = 50, deviceId } = {}) {
      const data = await call('GET', `/events/user/${encodeURIComponent(tenant)}`, { query: { type, limit, deviceId } });
      return Array.isArray(data && data.data) ? data.data : [];
    },
  };
}
