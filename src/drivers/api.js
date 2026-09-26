// synacl-gateway/driver — the public driver plugin API, version 1.
//
// A driver package default-exports `defineDriver({...})`. Validation happens here, at import
// time of the driver, so a malformed package fails with a message naming the problem instead
// of misbehaving later inside the scheduler. See docs/ARCHITECTURE.md ("Drivers").

/** @typedef {import('../core/types.js').DriverDefinition} DriverDefinition */

/** The driver API version this gateway implements. */
export const apiVersion = 1;

/**
 * An error a driver can throw (or reject with) to control what the gateway reports.
 * `reason` becomes the device status reason (≤128 chars, e.g. 'modbus/timeout');
 * `code` is a short machine-readable tag for logs and tests.
 */
export class DriverError extends Error {
  /**
   * @param {string} message
   * @param {{reason?: string, code?: string, cause?: unknown}} [opts]
   */
  constructor(message, { reason, code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DriverError';
    this.reason = reason ?? message;
    if (code !== undefined) this.code = code;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Check a driver definition against the v1 contract without throwing.
 * @param {unknown} def
 * @returns {string[]} Problems found; empty when the definition is valid.
 */
export function validateDriverDefinition(def) {
  if (!isPlainObject(def)) return ['a driver definition must be an object (did the package default-export defineDriver({...})?)'];
  const d = /** @type {Record<string, unknown>} */ (def);
  const problems = [];
  if (d.apiVersion !== apiVersion) {
    problems.push(`apiVersion must be ${apiVersion} (got ${JSON.stringify(d.apiVersion)}); this gateway implements driver API ${apiVersion}`);
  }
  if (typeof d.name !== 'string' || d.name.trim() === '') problems.push('name must be a non-empty string');
  if (!Array.isArray(d.protocols) || d.protocols.length === 0) {
    problems.push('protocols must be a non-empty array of protocol names');
  } else {
    const seen = new Set();
    for (const p of d.protocols) {
      if (typeof p !== 'string' || p.trim() === '') problems.push(`protocols contains an invalid entry ${JSON.stringify(p)}`);
      else if (seen.has(p)) problems.push(`protocols lists "${p}" twice`);
      else seen.add(p);
    }
  }
  if (typeof d.create !== 'function') problems.push('create must be a function (ctx) => DriverInstance');
  if (d.capabilities !== undefined) {
    if (!isPlainObject(d.capabilities)) {
      problems.push('capabilities must be an object when present');
    } else {
      const caps = /** @type {Record<string, unknown>} */ (d.capabilities);
      if (caps.modbusFormats !== undefined && typeof caps.modbusFormats !== 'boolean') problems.push('capabilities.modbusFormats must be a boolean');
      if (caps.sensorModels !== undefined) {
        if (!isPlainObject(caps.sensorModels)) problems.push('capabilities.sensorModels must be an object of {bus: string[]}');
        else {
          for (const [bus, models] of Object.entries(caps.sensorModels)) {
            if (!Array.isArray(models) || models.some((m) => typeof m !== 'string')) problems.push(`capabilities.sensorModels.${bus} must be an array of strings`);
          }
        }
      }
    }
  }
  return problems;
}

/**
 * Validate and freeze a driver definition. Throws a DriverError listing every problem.
 * @param {DriverDefinition} def
 * @returns {Readonly<DriverDefinition>}
 */
export function defineDriver(def) {
  const problems = validateDriverDefinition(def);
  if (problems.length) {
    const name = isPlainObject(def) && typeof def.name === 'string' && def.name ? `"${def.name}"` : '(unnamed)';
    throw new DriverError(`invalid driver ${name}: ${problems.join('; ')}`, { code: 'invalid-driver' });
  }
  const caps = def.capabilities ?? {};
  const capabilities = {};
  if (caps.modbusFormats !== undefined) capabilities.modbusFormats = caps.modbusFormats;
  if (caps.sensorModels !== undefined) {
    capabilities.sensorModels = Object.freeze(
      Object.fromEntries(Object.entries(caps.sensorModels).map(([bus, models]) => [bus, Object.freeze([...models])])),
    );
  }
  return Object.freeze({
    ...def,
    protocols: Object.freeze([...def.protocols]),
    capabilities: Object.freeze(capabilities),
  });
}
