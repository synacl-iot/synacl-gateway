// Identities, device builders and byte-exact payload fixtures shared by the scenarios.

export const TENANT = '64b7a1000000000000000001';
export const OTHER_TENANT = '64b7a10000000000000000ff';
export const GATEWAY = 'gw_conformance_01';
export const USERNAME = '482913';
// Distinctive so a leak is unambiguous in any log line or payload.
export const PASSWORD = 'Cf9-conformance-broker-secret-7Qx2';

/** A 24-hex device id: deviceId(2) → '64b7a1000000000000000002'. */
export const deviceId = (n) => `64b7a1${n.toString(16).padStart(18, '0')}`;

/**
 * One device entry with the platform's key order (_id, protocol, conn, tags).
 * @param {number|string} id
 * @param {{protocol?: string, tickDuration?: number, sampleIntervalMs?: number, conn?: Object, tags?: Object[]}} [o]
 */
export function device(id, o = {}) {
  const conn = { ...(o.conn || { modbusId: 1, baudRate: 9600 }) };
  if (o.tickDuration != null) conn.tickDuration = o.tickDuration;
  if (o.sampleIntervalMs != null) conn.sampleIntervalMs = o.sampleIntervalMs;
  return {
    _id: typeof id === 'number' ? deviceId(id) : id,
    protocol: o.protocol || 'rs485',
    conn,
    tags: o.tags || [{ name: 'temperature' }],
  };
}

/** The full config/push payload string the platform would emit for these devices. */
export function configPayload(devices, { net } = {}) {
  const sorted = [...devices].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  const doc = { devices: sorted, success: true };
  if (net) doc.net = net;
  return JSON.stringify(doc);
}

/** Pinned vector: these exact 210 bytes hash (FNV-1a 32) to 3420619844. */
export const FIXTURE_3420619844 = '{"devices":[{"_id":"64b7a1000000000000000002","protocol":"rs485","conn":{"baudRate":9600,"modbusId":1},"tags":[{"name":"oil_temp","isIntervalRead":false,"thresholdStart":10,"thresholdEnd":80}]}],"success":true}';
export const FIXTURE_3420619844_HASH = 3420619844;

/** Pinned vector: 537 bytes, FNV-1a 32 1657896004; with cap 120 it travels as 13 parts of 56 base64 chars (last 44). */
export const FIXTURE_537 = '{"devices":[{"_id":"66f1a2b3c4d5e6f708192a3b","protocol":"rs485","conn":{"modbusId":1,"baudRate":9600,"tickDuration":10000},"tags":[{"name":"voltage","registerType":"input","mbFormat":"f32"},{"name":"energy","mbAddress":342,"registerType":"input","mbFormat":"u32","isIntervalRead":false,"scaleFactor":0.01,"thresholdEnd":500}]},{"_id":"66f1a2b3c4d5e6f708192a3d","protocol":"i2c","conn":{"sdaPin":21,"sclPin":22},"tags":[{"name":"raw","i2cAddress":72,"sensorModel":"generic","gpioPin":0,"readBytes":4,"bigEndian":false}]}],"success":true}';
export const FIXTURE_537_HASH = 1657896004;
