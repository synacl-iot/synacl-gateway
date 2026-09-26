// Rewrites the vendored protocol/v1/ from the public mirror at synacl.com/protocol/v1/.
//
//   node scripts/schemas-sync.js [--base <url>] [--dir <path>] [--dry-run]
//
// The protocol is defined upstream; this repository never edits protocol/v1 by hand. Files
// whose parsed JSON is unchanged are left byte-for-byte alone (the mirror is re-serialised,
// so rewriting them would only produce whitespace churn); changed and new files are written
// exactly as served; files the index no longer lists are deleted.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_BASE, DEFAULT_DIR, compare, fetchMirror, formatReport, readLocal } from './schemas-check.js';

/**
 * @param {{base?: string, dir?: string, dryRun?: boolean, fetch?: typeof fetch}} [opts]
 * @returns {Promise<ReturnType<typeof compare>>}
 */
export async function syncMirror({ base = DEFAULT_BASE, dir = DEFAULT_DIR, dryRun = false, fetch: fetchImpl } = {}) {
  const remote = await fetchMirror({ base, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const result = compare(readLocal(dir), remote);
  if (dryRun) return result;
  for (const rel of [...result.added, ...result.changed.map((c) => c.file)]) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    const { text } = remote.get(rel);
    writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`);
  }
  for (const rel of result.removed) rmSync(join(dir, rel), { force: true });
  return result;
}

async function main() {
  const { values } = parseArgs({ options: { base: { type: 'string' }, dir: { type: 'string' }, 'dry-run': { type: 'boolean' } }, strict: true });
  const base = values.base ?? process.env.SYNACL_PROTOCOL_BASE ?? DEFAULT_BASE;
  const result = await syncMirror({ base, dir: values.dir ? resolve(values.dir) : DEFAULT_DIR, dryRun: Boolean(values['dry-run']) });
  process.stdout.write(formatReport(result, { base }).replace(/\nUpdate the vendored copy.*\n/, '\n'));
  if (!result.inSync) process.stdout.write(values['dry-run'] ? 'Dry run: nothing written.\n' : 'protocol/v1 updated. Run npm test and npm run conformance, and note the change in CHANGELOG.md.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`schemas-sync: ${err.message}\n`);
    process.exitCode = 2;
  });
}
