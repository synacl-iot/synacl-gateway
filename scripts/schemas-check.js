// Compares the vendored protocol/v1/ with the public mirror at synacl.com/protocol/v1/.
//
//   node scripts/schemas-check.js [--base <url>] [--dir <path>] [--json]
//
// Exit 0 in sync · 1 drift (a readable summary on stdout) · 2 the mirror could not be read.
// Files are compared as PARSED JSON: the mirror is re-serialised when the site is built, so a
// byte comparison would report drift that isn't there. Also exports the pieces
// scripts/schemas-sync.js uses.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, isDeepStrictEqual } from 'node:util';

export const DEFAULT_BASE = 'https://synacl.com/protocol/v1/';
export const DEFAULT_DIR = fileURLToPath(new URL('../protocol/v1/', import.meta.url));

// A mirror can only ever name files inside these two folders (or the two top-level files):
// a path like ../../x from a compromised index must never become a write in `sync`.
const REL_RE = /^(index\.json|topics\.json|(schemas|examples)\/[A-Za-z0-9][A-Za-z0-9._-]*\.json)$/;

// The site's edge rate-limits bursts (HTTP 429): fetch a few at a time and back off politely.
async function getText(url, fetchImpl, { retries = 6, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
    if (res.ok) return res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 500 * 2 ** attempt);
      continue;
    }
    throw new Error(`${url}: HTTP ${res.status}`);
  }
}

function relPath(base, url) {
  const u = new URL(url, base);
  const b = new URL(base);
  if (u.origin !== b.origin || !u.pathname.startsWith(b.pathname)) throw new Error(`${url} is outside ${base}`);
  const rel = decodeURIComponent(u.pathname.slice(b.pathname.length));
  if (!REL_RE.test(rel)) throw new Error(`unexpected file name in the mirror index: ${rel}`);
  return rel;
}

/**
 * Downloads index.json, topics.json and every schema/example the index lists.
 * @returns {Promise<Map<string, {text: string, json: unknown}>>} keyed by path relative to v1/
 */
export async function fetchMirror({ base = DEFAULT_BASE, fetch: fetchImpl = globalThis.fetch, concurrency = 2, sleep } = {}) {
  const b = base.endsWith('/') ? base : `${base}/`;
  const files = new Map();
  const load = async (rel, url) => {
    const text = await getText(url, fetchImpl, sleep ? { sleep } : undefined);
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`${url}: not valid JSON`); }
    files.set(rel, { text, json });
  };
  await load('index.json', new URL('index.json', b).href);
  const index = /** @type {any} */ (files.get('index.json').json);
  const jobs = [['topics.json', new URL('topics.json', b).href]];
  for (const group of ['schemas', 'examples']) {
    const entries = index?.[group];
    if (!entries || typeof entries !== 'object') throw new Error(`index.json has no "${group}" map`);
    for (const url of Object.values(entries)) jobs.push([relPath(b, url), new URL(url, b).href]);
  }
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const [rel, url] = jobs[next++]; await load(rel, url); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return files;
}

/** Every vendored file, as the same relative paths. */
export function readLocal(dir = DEFAULT_DIR) {
  const files = new Map();
  const add = (rel) => {
    const text = readFileSync(join(dir, rel), 'utf8');
    let json;
    try { json = JSON.parse(text); } catch { json = Symbol('invalid JSON'); }
    files.set(rel, { text, json });
  };
  for (const top of ['index.json', 'topics.json']) if (existsSync(join(dir, top))) add(top);
  for (const group of ['schemas', 'examples']) {
    if (!existsSync(join(dir, group))) continue;
    for (const f of readdirSync(join(dir, group)).sort()) if (f.endsWith('.json')) add(`${group}/${f}`);
  }
  return files;
}

/** Where two JSON values differ, as JSON-pointer paths (at most `limit`). */
export function jsonDiff(a, b, path = '', out = [], limit = 10) {
  if (out.length >= limit || isDeepStrictEqual(a, b)) return out;
  const isObj = (v) => v !== null && typeof v === 'object';
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      if (out.length >= limit) break;
      const p = `${path}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!(k in a)) out.push({ path: p, kind: 'added', to: b[k] });
      else if (!(k in b)) out.push({ path: p, kind: 'removed', from: a[k] });
      else jsonDiff(a[k], b[k], p, out, limit);
    }
    return out;
  }
  out.push({ path: path || '/', kind: 'changed', from: a, to: b });
  return out;
}

/**
 * @param {Map<string, {json: unknown}>} local
 * @param {Map<string, {json: unknown}>} remote
 */
export function compare(local, remote) {
  const added = [...remote.keys()].filter((k) => !local.has(k)).sort();
  const removed = [...local.keys()].filter((k) => !remote.has(k)).sort();
  const changed = [...remote.keys()].filter((k) => local.has(k) && !isDeepStrictEqual(local.get(k).json, remote.get(k).json)).sort()
    .map((file) => ({ file, diffs: jsonDiff(local.get(file).json, remote.get(file).json) }));
  return { added, removed, changed, inSync: !added.length && !removed.length && !changed.length };
}

const preview = (v) => {
  const s = v === undefined ? 'undefined' : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
};

/** A plain-text / Markdown-friendly report (it becomes the body of the drift issue). */
export function formatReport(result, { base = DEFAULT_BASE } = {}) {
  if (result.inSync) return `protocol/v1 is in sync with ${base}\n`;
  const lines = [
    `protocol/v1 differs from ${base}: ${result.changed.length} changed, ${result.added.length} new upstream, ${result.removed.length} gone upstream.`,
    '',
  ];
  for (const { file, diffs } of result.changed) {
    lines.push(`changed  ${file}`);
    for (const d of diffs) {
      if (d.kind === 'added') lines.push(`    + ${d.path}: ${preview(d.to)}`);
      else if (d.kind === 'removed') lines.push(`    - ${d.path}: ${preview(d.from)}`);
      else lines.push(`    ~ ${d.path}: ${preview(d.from)} → ${preview(d.to)}`);
    }
  }
  for (const f of result.added) lines.push(`new      ${f}`);
  for (const f of result.removed) lines.push(`gone     ${f}`);
  lines.push('', 'Update the vendored copy with `npm run schemas:sync`, then run `npm test` and `npm run conformance`.', '');
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { base: { type: 'string' }, dir: { type: 'string' }, json: { type: 'boolean' } }, strict: true });
  const base = values.base ?? process.env.SYNACL_PROTOCOL_BASE ?? DEFAULT_BASE;
  const dir = values.dir ? resolve(values.dir) : DEFAULT_DIR;
  let remote;
  try {
    remote = await fetchMirror({ base });
  } catch (err) {
    process.stderr.write(`schemas-check: could not read the mirror: ${err.message}\n`);
    return 2;
  }
  const result = compare(readLocal(dir), remote);
  process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result, { base }));
  return result.inSync ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`schemas-check: ${err.stack ?? err}\n`); process.exitCode = 2; });
}
