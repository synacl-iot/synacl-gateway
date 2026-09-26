// Topic names for one gateway, built from the vendored protocol/v1/topics.json so the code and
// the published contract cannot drift apart.
//
// Prefix: tenants/{tenant}/sources/gateway/{gateway}. Uplinks are addressed by their topics.json
// id ('gateway.config-request'), the id without its scope ('config-request') or the suffix
// ('config/request', 'devices/{deviceId}/data'); all three resolve to the same row.

import { readFileSync } from 'node:fs';

const TABLE = JSON.parse(readFileSync(new URL('../../protocol/v1/topics.json', import.meta.url), 'utf8'));

/** @type {Map<string, Object>} gateway-scoped rows by id */
const ROWS = new Map(TABLE.topics.filter((t) => t.scope === 'gateway').map((t) => [t.id, t]));

/**
 * The seven downlink filters, in the order the gateway subscribes. Exactly the gateway-scoped
 * `down` rows of topics.json (a unit test holds the two together).
 */
const SUBSCRIBE_IDS = [
  'gateway.cmd',
  'gateway.device-cmd',
  'gateway.config-push',
  'gateway.firmware-request',
  'gateway.macros-push',
  'gateway.macros-run',
  'gateway.macros-abort',
];

// A topic level must not contain '/', and '+'/'#' would turn a publish topic into a filter.
const LEVEL_RE = /^[^/+#\u0000]+$/;
const TENANT_RE = /^[0-9a-fA-F]{24}$/;
const GATEWAY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,63}$/;

/** @param {string} name */
function resolveRow(name) {
  if (ROWS.has(name)) return ROWS.get(name);
  if (ROWS.has(`gateway.${name}`)) return ROWS.get(`gateway.${name}`);
  for (const row of ROWS.values()) if (row.suffix === name) return row;
  return null;
}

/**
 * @param {{tenant: string, gateway: string}} identity
 */
export function createTopics({ tenant, gateway }) {
  if (typeof tenant !== 'string' || !TENANT_RE.test(tenant)) {
    throw new TypeError(`tenant must be 24 hex characters, got ${JSON.stringify(tenant)}`);
  }
  if (typeof gateway !== 'string' || !GATEWAY_RE.test(gateway)) {
    throw new TypeError(`gateway id must match ${GATEWAY_RE}, got ${JSON.stringify(gateway)}`);
  }
  const prefix = `tenants/${tenant}/sources/gateway/${gateway}`;
  const prefixSlash = `${prefix}/`;

  /** Topic for any gateway-scoped row. */
  function build(name, deviceId) {
    const row = resolveRow(name);
    if (!row) throw new Error(`unknown topic "${name}"`);
    let suffix = row.suffix;
    if (suffix.includes('{deviceId}')) {
      if (typeof deviceId !== 'string' || !LEVEL_RE.test(deviceId)) {
        throw new TypeError(`topic "${row.id}" needs a device id without '/', '+' or '#' (got ${JSON.stringify(deviceId)})`);
      }
      suffix = suffix.replace('{deviceId}', deviceId);
    }
    return prefixSlash + suffix;
  }

  // Split each downlink suffix around {deviceId}: fixed suffixes match exactly, templated ones
  // by head + one level + tail.
  const downRows = [...ROWS.values()].filter((r) => r.direction === 'down')
    .map((r) => {
      const [head, tail] = r.suffix.split('{deviceId}');
      return { row: r, head, tail: tail ?? null };
    });

  return {
    prefix,

    /** @param {string} name  topics.json id, id without 'gateway.', or suffix. @param {string} [deviceId] */
    up(name, deviceId) {
      const row = resolveRow(name);
      if (!row) throw new Error(`unknown topic "${name}"`);
      if (row.direction !== 'up') throw new Error(`topic "${row.id}" is a downlink; the gateway never publishes it`);
      return build(row.id, deviceId);
    },

    build,

    /** The topics.json row (qos, retain, schema…) for an id/suffix, or null. */
    meta(name) {
      return resolveRow(name);
    },

    /** @returns {string[]} the seven filters, `{deviceId}` as '+'. */
    subscriptions() {
      return SUBSCRIBE_IDS.map((id) => prefixSlash + ROWS.get(id).suffix.replace('{deviceId}', '+'));
    },

    /**
     * @param {string} topic
     * @returns {{kind: string, deviceId?: string} | null}  kind = topics.json id.
     */
    parseDown(topic) {
      if (typeof topic !== 'string' || !topic.startsWith(prefixSlash)) return null;
      const rest = topic.slice(prefixSlash.length);
      for (const { row, head, tail } of downRows) {
        if (tail === null) {
          if (rest === head) return { kind: row.id };
          continue;
        }
        if (rest.length > head.length + tail.length && rest.startsWith(head) && rest.endsWith(tail)) {
          const deviceId = rest.slice(head.length, rest.length - tail.length);
          if (LEVEL_RE.test(deviceId)) return { kind: row.id, deviceId };
        }
      }
      return null;
    },
  };
}

/** Exposed for tests and the conformance harness. */
export const topicTable = TABLE;
export const SUBSCRIPTION_IDS = Object.freeze([...SUBSCRIBE_IDS]);
