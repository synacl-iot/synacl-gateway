// C22 — the vendored protocol is self-consistent: every example validates against its schema,
// under the verifier's strict validators and under the gateway's own validators.
import { loadProtocol, createStrictValidators } from '../protocol.js';

export const id = 'C22';
export const title = 'Every vendored example validates against its schema (strict, and with the gateway\'s own validators)';
export const level = 'core';

export default async function run(h) {
  const { examples, schemas } = loadProtocol();
  const strict = createStrictValidators();
  h.check('present', examples.length >= 1 && Object.keys(schemas).length >= 1, `${examples.length} examples, ${Object.keys(schemas).length} schemas`);
  const bad = examples.filter((e) => !strict.validate(e.schema, e.body).ok);
  h.check('strict', bad.length === 0, bad.length ? `invalid: ${bad.map((e) => `${e.file} (${strict.validate(e.schema, e.body).errors.join('; ')})`).join(', ')}` : 'every example is valid under plain Ajv');
  let core = null;
  try { core = await import('../../core/schemas.js'); } catch { /* reported below */ }
  if (!core || typeof core.createValidators !== 'function') {
    h.check('core-validators', false, 'the gateway core does not expose createValidators(protocolDir)');
    return;
  }
  const { PROTOCOL_DIR } = await import('../protocol.js');
  const v = core.createValidators(PROTOCOL_DIR);
  const coreBad = examples.filter((e) => !v.validate(e.schema, structuredClone(e.body)).ok);
  h.check('core', coreBad.length === 0, coreBad.length ? `the gateway's validators reject: ${coreBad.map((e) => e.file).join(', ')}` : "every example is valid under the gateway's own validators");
  const unchanged = examples.every((e) => { const c = structuredClone(e.body); v.validate(e.schema, c); return JSON.stringify(c) === JSON.stringify(e.body); });
  h.check('core-no-mutation', unchanged, "the gateway's validators never modify what they validate (no removeAdditional/useDefaults)");
}
