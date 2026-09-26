// The capability report (`firmware/response`), sent on every connect and in reply to a
// `firmware/request` that carries no `type`.
//
// The platform REPLACES its stored copy wholesale and gates the app on it: a protocol missing
// from `protocols` cannot be configured on this gateway, and a flag that is absent reads as
// unsupported. It only stores a report that has `protocols` or `sensorModels`, so
// `sensorModels` is always present, even when empty.

/** @typedef {import('./types.js').DriverRegistry} DriverRegistry */

/** Capability-report shape version (the firmware's current one). */
export const SCHEMA_VERSION = 2;
/** Largest configuration this gateway accepts and parses (the schema's ceiling). */
export const MAX_CONFIG_BYTES = 1048576;
/** One MQTT packet can carry this much here (the schema's ceiling; Node has no small buffer). */
export const MQTT_PAYLOAD_BYTES = 65535;

/**
 * @param {Object} opts
 * @param {string} opts.version  Plain semver — the same string the heartbeat reports as `fw`.
 * @param {string} opts.gatewayId  The chip id in the topic prefix.
 * @param {Pick<DriverRegistry, 'protocols'|'capabilities'>} opts.drivers
 * @param {number|null} [opts.configCap]
 * @param {string} [opts.platform]  Defaults to process.platform (tests pin it).
 * @param {string} [opts.arch]  Defaults to process.arch.
 * @returns {Object}
 */
export function buildCapabilities({ version, gatewayId, drivers, configCap = null, platform = process.platform, arch = process.arch }) {
  const merged = drivers?.capabilities?.() || {};
  const protocols = [...new Set(drivers?.protocols?.() || [])];
  // configCap only shapes our own config/request (opt-in chunked pull). It must not lower
  // mqttPayloadBytes: the platform uses that to decide whether macros/push and job/config
  // fit in one packet, and Node receives packets of any size.
  void configCap;
  return {
    version: String(version),
    schemaVersion: SCHEMA_VERSION,
    board: `node-${platform}-${arch}`,
    mac: String(gatewayId),
    protocols,
    sensorModels: merged.sensorModels && typeof merged.sensorModels === 'object' ? merged.sensorModels : {},
    debug: true,
    ethernet: false,
    buffering: true,
    jobs: false,
    modbusFormats: merged.modbusFormats === true,
    configChunked: true,
    maxConfigBytes: MAX_CONFIG_BYTES,
    mqttPayloadBytes: MQTT_PAYLOAD_BYTES,
  };
}
