// Turns a config/push document into DeviceSpec[] (see types.js).
//
// The platform omits every tag key whose value equals the reference firmware's default, so an
// absent key MEANS that default. Filling them back in here, once, keeps every driver from
// guessing — and the non-zero defaults (isIntervalRead TRUE, gpioPin -1, readBytes 2,
// bigEndian TRUE) are exactly the ones a naive `?? 0` would get wrong.

/** @typedef {import('./types.js').DeviceSpec} DeviceSpec */
/** @typedef {import('./types.js').TagSpec} TagSpec */

export const DEFAULT_INTERVAL_MS = 10000;
export const MAX_INTERVAL_MS = 3600000;
export const MIN_INTERVAL_FLOOR_MS = 250;

const DEVICE_ID_RE = /^[0-9a-fA-F]{24}$/;
const REGISTER_TYPES = ['holding', 'input', 'coil', 'discrete'];
const MB_FORMATS = ['u16', 's16', 'u32', 's32', 'f32'];
const WORD_ORDERS = ['big', 'little'];

/** Tag fallbacks, key → default. Order follows the platform's tag key order. */
const TAG_DEFAULTS = {
  mbAddress: 0,
  registerType: 'holding',
  mbFormat: 'u16',
  mbWordOrder: 'big',
  isIntervalRead: true,
  scaleFactor: 1,
  offset: 0,
  thresholdStart: 0,
  thresholdEnd: 0,
  i2cAddress: 0,
  sensorModel: '',
  gpioPin: -1,
  canId: 0,
  mbusRecord: 0,
  jsonPath: '',
  bleField: '',
  metric: '',
  topic: '',
  cmdTopic: '',
  initByte: 0,
  readBytes: 2,
  bigEndian: true,
};

const ENUMS = { registerType: REGISTER_TYPES, mbFormat: MB_FORMATS, mbWordOrder: WORD_ORDERS };
const INTEGER_KEYS = new Set(['mbAddress', 'i2cAddress', 'gpioPin', 'canId', 'mbusRecord', 'initByte', 'readBytes']);

/** A finite number, or a numeric string coerced to one; otherwise undefined. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A positive interval in ms, or undefined when absent / zero / not numeric. */
function positive(v) {
  const n = toNumber(v);
  return n !== undefined && n > 0 ? n : undefined;
}

export function clampInterval(ms, minIntervalMs) {
  const floor = Math.max(MIN_INTERVAL_FLOOR_MS, toNumber(minIntervalMs) ?? 1000);
  return Math.round(Math.min(MAX_INTERVAL_MS, Math.max(floor, ms)));
}

/**
 * Effective publish interval for a device: override ?? sampleIntervalMs ?? tickDuration ?? 10 s,
 * clamped to [max(250, minIntervalMs), 1 h].
 * @param {Object} conn
 * @param {number|undefined} overrideMs
 * @param {number} minIntervalMs
 */
export function intervalFor(conn, overrideMs, minIntervalMs) {
  const c = conn && typeof conn === 'object' ? conn : {};
  const ms = positive(overrideMs) ?? positive(c.sampleIntervalMs) ?? positive(c.tickDuration) ?? DEFAULT_INTERVAL_MS;
  return clampInterval(ms, minIntervalMs);
}

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * @param {Object} raw  one tag object as received
 * @param {string[]} warnings
 * @param {string} where  for messages
 * @returns {TagSpec}
 */
function normalizeTag(raw, warnings, where) {
  /** @type {any} */
  const tag = { name: raw.name };
  for (const [key, def] of Object.entries(TAG_DEFAULTS)) {
    const v = raw[key];
    if (v === undefined || v === null) {
      tag[key] = def;
    } else if (typeof def === 'boolean') {
      if (typeof v === 'boolean') tag[key] = v;
      else { tag[key] = def; warnings.push(`${where}: ${key} is not a boolean; using ${def}`); }
    } else if (typeof def === 'number') {
      const n = toNumber(v);
      if (n !== undefined && (!INTEGER_KEYS.has(key) || Number.isInteger(n))) tag[key] = n;
      else { tag[key] = def; warnings.push(`${where}: ${key} is not a valid number; using ${def}`); }
    } else if (ENUMS[key]) {
      if (ENUMS[key].includes(v)) tag[key] = v;
      else { tag[key] = def; warnings.push(`${where}: unknown ${key} ${JSON.stringify(v)}; using "${def}"`); }
    } else {
      tag[key] = typeof v === 'string' ? v : def;
      if (typeof v !== 'string') warnings.push(`${where}: ${key} is not a string; ignored`);
    }
  }
  tag.raw = raw;
  return tag;
}

/**
 * @param {Object} doc  a FULL config/push document ({devices, success})
 * @param {{overrides?: Object, minIntervalMs?: number, receivedAt?: number}} [opts]
 *   overrides: overrides.json content ({devices: {id: {intervalMs, intervalSetAt}}}).
 *   receivedAt: when this config arrived; an interval override set BEFORE it is ignored,
 *   because the platform writes the new interval into the device's conn as well — the newer
 *   config is authoritative.
 * @returns {{devices: DeviceSpec[], errors: string[]}}
 */
export function normalizeConfig(doc, { overrides, minIntervalMs = 1000, receivedAt } = {}) {
  /** @type {string[]} */
  const errors = [];
  /** @type {DeviceSpec[]} */
  const devices = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.devices)) {
    errors.push('configuration has no devices array');
    return { devices, errors };
  }
  const ov = (overrides && typeof overrides === 'object' && overrides.devices && typeof overrides.devices === 'object')
    ? overrides.devices : {};
  const seen = new Set();

  doc.devices.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`device #${i}: not an object; skipped`);
      return;
    }
    const id = raw._id;
    if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) {
      errors.push(`device #${i}: missing or invalid _id ${JSON.stringify(id ?? null)}; skipped`);
      return;
    }
    if (typeof raw.protocol !== 'string' || raw.protocol === '') {
      errors.push(`device ${id}: missing protocol; skipped`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`device ${id}: listed twice; the second entry is skipped`);
      return;
    }
    seen.add(id);

    const conn = raw.conn && typeof raw.conn === 'object' && !Array.isArray(raw.conn) ? raw.conn : {};
    const tags = [];
    const names = new Set();
    (Array.isArray(raw.tags) ? raw.tags : []).forEach((t, j) => {
      if (!t || typeof t !== 'object' || typeof t.name !== 'string' || t.name === '') {
        errors.push(`device ${id}: tag #${j} has no name; skipped`);
        return;
      }
      if (names.has(t.name)) {
        errors.push(`device ${id}: tag "${t.name}" listed twice; the second entry is skipped`);
        return;
      }
      names.add(t.name);
      tags.push(normalizeTag(t, errors, `device ${id} tag "${t.name}"`));
    });

    const o = ov[id];
    const overrideMs = o && (receivedAt === undefined || Number(o.intervalSetAt) >= receivedAt) ? o.intervalMs : undefined;
    const intervalMs = intervalFor(conn, overrideMs, minIntervalMs);

    // Read cadence faster than the publish interval is a modbus-tcp feature (fresh samples for
    // local alarm bands); anything at or above the interval means "once per interval".
    let readIntervalMs = 0;
    if (raw.protocol === 'modbus-tcp') {
      const r = positive(conn.readIntervalMs);
      if (r !== undefined) {
        const clamped = Math.round(Math.max(MIN_INTERVAL_FLOOR_MS, r));
        readIntervalMs = clamped < intervalMs ? clamped : 0;
      }
    }

    devices.push({
      id,
      protocol: raw.protocol,
      conn,
      tags,
      intervalMs,
      readIntervalMs,
      fingerprint: canonicalJson({ protocol: raw.protocol, conn, tags: raw.tags ?? [] }),
      raw,
    });
  });

  return { devices, errors };
}

/**
 * Drop interval overrides set before a newly received config (see normalizeConfig). Read-pause
 * state is kept: the platform does not mirror it into the config.
 * @param {Object} overrides  overrides.json content
 * @param {number} receivedAt
 * @returns {{overrides: Object, changed: boolean}}
 */
export function pruneOverrides(overrides, receivedAt) {
  const src = overrides && typeof overrides === 'object' && overrides.devices && typeof overrides.devices === 'object'
    ? overrides.devices : {};
  const devices = {};
  let changed = false;
  for (const [id, entry] of Object.entries(src)) {
    if (!entry || typeof entry !== 'object') { changed = true; continue; }
    const next = { ...entry };
    if ('intervalMs' in next && !(Number(next.intervalSetAt) >= receivedAt)) {
      delete next.intervalMs;
      delete next.intervalSetAt;
      changed = true;
    }
    if (Object.keys(next).length > 0) devices[id] = next;
    else changed = true;
  }
  return { overrides: { ...(overrides && typeof overrides === 'object' ? overrides : {}), v: 1, devices }, changed };
}
