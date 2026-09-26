// Validators for every schema in protocol/v1/schemas.
//
// A dedicated, PLAIN Ajv instance: no removeAdditional and no useDefaults. Both mutate the value
// while Ajv tries `oneOf` branches, so a validator configured like that can pass a message on
// one branch after corrupting it on another — and it would hide undeclared keys we are about to
// send, which the platform silently strips. allowUnionTypes is needed only because `values`
// maps declare `type: [number, boolean, string]`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv';

const Ajv = AjvModule.default ?? AjvModule;

const DEFAULT_DIR = fileURLToPath(new URL('../../protocol/v1', import.meta.url));

/**
 * @param {string} [protocolDir]  Directory holding `schemas/*.json` (default: the vendored protocol/v1).
 * @returns {{validate(schema: string, value: unknown): {ok: boolean, errors: string[]}, names(): string[]}}
 */
export function createValidators(protocolDir = DEFAULT_DIR) {
  // logger:false — library code never writes to the console; strict-mode problems still throw.
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, logger: false });
  const compiled = new Map();
  const dir = join(protocolDir, 'schemas');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const schema = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    compiled.set(file.slice(0, -'.json'.length), ajv.compile(schema));
  }

  return {
    validate(schema, value) {
      const fn = compiled.get(schema);
      if (!fn) return { ok: false, errors: [`unknown schema "${schema}"`] };
      if (fn(value)) return { ok: true, errors: [] };
      return { ok: false, errors: (fn.errors ?? []).map(formatError) };
    },
    names() {
      return [...compiled.keys()];
    },
  };
}

/** One readable line per Ajv error, e.g. `/batch/0/values/t: must be number,boolean,string`. */
function formatError(e) {
  const where = e.instancePath || '/';
  const extra = e.keyword === 'additionalProperties' ? ` (${e.params.additionalProperty})` : '';
  return `${where}: ${e.message}${extra}`;
}
