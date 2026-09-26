// The verifier's own view of the vendored protocol: topic table, strict validators, FNV-1a.
//
// Deliberately independent of src/core: a conformance suite that validated the gateway with
// the gateway's own schema loader or hash function could not catch a bug in either.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

export const PROTOCOL_DIR = fileURLToPath(new URL('../../protocol/v1/', import.meta.url));

let cached = null;

/** topics.json, schemas and examples, loaded once. */
export function loadProtocol() {
  if (cached) return cached;
  const topics = JSON.parse(readFileSync(`${PROTOCOL_DIR}topics.json`, 'utf8'));
  const schemas = {};
  for (const f of readdirSync(`${PROTOCOL_DIR}schemas`).filter((n) => n.endsWith('.json')).sort()) {
    schemas[f.slice(0, -5)] = JSON.parse(readFileSync(`${PROTOCOL_DIR}schemas/${f}`, 'utf8'));
  }
  const examples = readdirSync(`${PROTOCOL_DIR}examples`).filter((n) => n.endsWith('.json')).sort().map((f) => ({
    file: f,
    // `config-push.chunk.json` documents schema `config-push`.
    schema: f.slice(0, f.indexOf('.')),
    body: JSON.parse(readFileSync(`${PROTOCOL_DIR}examples/${f}`, 'utf8')),
  }));
  cached = { topics, schemas, examples };
  return cached;
}

/**
 * Plain Ajv — no removeAdditional, no useDefaults, no coercion — so an undeclared key FAILS
 * here even though the platform would strip it silently. Strict on purpose: a key the
 * platform strips is a key the gateway author thinks is doing something and is not.
 */
export function createStrictValidators() {
  const { schemas } = loadProtocol();
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const compiled = {};
  for (const [name, schema] of Object.entries(schemas)) compiled[name] = ajv.compile(schema);
  return {
    names: () => Object.keys(compiled),
    /** @returns {{ok: boolean, errors: string[]}} */
    validate(name, value) {
      const fn = compiled[name];
      if (!fn) return { ok: false, errors: [`no schema named "${name}"`] };
      const ok = fn(value);
      return { ok, errors: ok ? [] : (fn.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params && e.params.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`) };
    },
  };
}

/** FNV-1a 32-bit over raw bytes (seed 0x811c9dc5, prime 0x01000193), as an unsigned integer. */
export function fnv1a32(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Topic helper for one gateway. `classify` maps an uplink topic to its topics.json entry.
 * @param {{tenant: string, gateway: string}} id
 */
export function gatewayTopics({ tenant, gateway }) {
  const { topics } = loadProtocol();
  const prefix = topics.prefix.replace('{tenantId}', tenant).replace('{chipId}', gateway);
  const gw = topics.topics.filter((t) => t.scope === 'gateway');
  const matchers = gw.map((t) => {
    const re = new RegExp(`^${t.suffix.split('/').map((s) => (s === '{deviceId}' ? '([^/]+)' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
    return { entry: t, re };
  });
  return {
    prefix,
    topic: (suffix, deviceId) => `${prefix}/${suffix.replace('{deviceId}', deviceId ?? '')}`,
    byId: (id) => gw.find((t) => t.id === id),
    /** The seven downlink filters a gateway must subscribe to, in topics.json order. */
    downlinkFilters: () => gw.filter((t) => t.direction === 'down').map((t) => `${prefix}/${t.suffix.replace('{deviceId}', '+')}`),
    /** @returns {{entry: Object, deviceId?: string}|null} */
    classify(topic) {
      if (!topic.startsWith(`${prefix}/`)) return null;
      const rest = topic.slice(prefix.length + 1);
      for (const { entry, re } of matchers) {
        const m = re.exec(rest);
        if (m) return { entry, deviceId: m[1] };
      }
      return null;
    },
  };
}
