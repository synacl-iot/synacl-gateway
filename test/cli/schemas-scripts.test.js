// scripts/schemas-check.js + schemas-sync.js against a fake mirror built from the vendored copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DIR, compare, fetchMirror, formatReport, jsonDiff, readLocal } from '../../scripts/schemas-check.js';
import { syncMirror } from '../../scripts/schemas-sync.js';
import { tmpHome } from '../_support/cli/helpers.js';

const BASE = 'https://mirror.test/protocol/v1/';

/** Serves the vendored files re-serialised (compact), the way a site build might. */
function fakeMirror(edit = (files) => files) {
  const local = readLocal(DEFAULT_DIR);
  const files = new Map([...local].map(([rel, { json }]) => [rel, JSON.stringify(json)]));
  // The real index points at synacl.com; point it at the fake base.
  const index = JSON.parse(files.get('index.json'));
  for (const g of ['schemas', 'examples']) for (const k of Object.keys(index[g])) index[g][k] = index[g][k].replace('https://synacl.com/protocol/v1/', BASE);
  files.set('index.json', JSON.stringify(index));
  edit(files);
  const requested = [];
  const fetch = async (url) => {
    requested.push(url);
    const rel = url.slice(BASE.length);
    return files.has(rel)
      ? { ok: true, status: 200, headers: new Headers(), text: async () => files.get(rel) }
      : { ok: false, status: 404, headers: new Headers(), text: async () => '' };
  };
  return { fetch, requested, files };
}

test('re-serialised but equal JSON is in sync (parsed comparison, never bytes)', async () => {
  const m = fakeMirror();
  const remote = await fetchMirror({ base: BASE, fetch: m.fetch });
  const local = readLocal(DEFAULT_DIR);
  // index.json differs only in its URLs because of the fake base; compare everything else.
  remote.set('index.json', local.get('index.json'));
  const r = compare(local, remote);
  assert.equal(r.inSync, true, formatReport(r));
  assert.equal(m.requested.length, 2 + 24 + 65);
});

test('changed, new and removed files are reported with JSON-pointer paths', async () => {
  const m = fakeMirror((files) => {
    const s = JSON.parse(files.get('schemas/alert.json'));
    s.title = 'Device alert v2';
    files.set('schemas/alert.json', JSON.stringify(s));
    const index = JSON.parse(files.get('index.json'));
    index.examples['alert.extra'] = `${BASE}examples/alert.extra.json`;
    delete index.examples['data.mixed-types'];
    files.set('index.json', JSON.stringify(index));
    files.set('examples/alert.extra.json', '{"ts":1}');
  });
  const remote = await fetchMirror({ base: BASE, fetch: m.fetch });
  const r = compare(readLocal(DEFAULT_DIR), remote);
  assert.equal(r.inSync, false);
  assert.deepEqual(r.added, ['examples/alert.extra.json']);
  assert.deepEqual(r.removed, ['examples/data.mixed-types.json']);
  const alert = r.changed.find((c) => c.file === 'schemas/alert.json');
  assert.deepEqual(alert.diffs, [{ path: '/title', kind: 'changed', from: 'Device alert', to: 'Device alert v2' }]);
  const report = formatReport(r, { base: BASE });
  assert.match(report, /changed  schemas\/alert\.json\n {4}~ \/title: "Device alert" → "Device alert v2"/);
  assert.match(report, /new {6}examples\/alert\.extra\.json/);
  assert.match(report, /gone {5}examples\/data\.mixed-types\.json/);
});

test('an index that points outside the mirror is refused', async () => {
  const m = fakeMirror((files) => {
    const index = JSON.parse(files.get('index.json'));
    index.schemas.evil = `${BASE}../../etc/passwd.json`;
    files.set('index.json', JSON.stringify(index));
  });
  await assert.rejects(fetchMirror({ base: BASE, fetch: m.fetch }), /outside|unexpected file name/);
});

test('429 is retried with backoff; other errors fail', async () => {
  const m = fakeMirror();
  let first = true;
  const flaky = async (url, o) => {
    if (first && url.endsWith('topics.json')) { first = false; return { ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), text: async () => '' }; }
    return m.fetch(url, o);
  };
  const waits = [];
  await fetchMirror({ base: BASE, fetch: flaky, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [1000]);
  const broken = async (url, o) => (url.endsWith('topics.json') ? { ok: false, status: 404, headers: new Headers(), text: async () => '' } : m.fetch(url, o));
  await assert.rejects(fetchMirror({ base: BASE, fetch: broken }), /topics\.json: HTTP 404/);
});

test('sync writes changed and new files as served, deletes removed ones, leaves equal files byte-identical', async (t) => {
  const dir = join(tmpHome(t), 'v1');
  cpSync(DEFAULT_DIR, dir, { recursive: true });
  const untouched = readFileSync(join(dir, 'schemas/data.json'), 'utf8');
  const m = fakeMirror((files) => {
    files.set('schemas/alert.json', files.get('schemas/alert.json').replace('"Device alert"', '"Device alert v2"'));
    const index = JSON.parse(files.get('index.json'));
    delete index.examples['data.mixed-types'];
    files.set('index.json', JSON.stringify(index));
  });
  const r = await syncMirror({ base: BASE, dir, fetch: m.fetch });
  assert.equal(r.inSync, false);
  assert.match(readFileSync(join(dir, 'schemas/alert.json'), 'utf8'), /"Device alert v2"/);
  assert.equal(existsSync(join(dir, 'examples/data.mixed-types.json')), false);
  assert.equal(readFileSync(join(dir, 'schemas/data.json'), 'utf8'), untouched);
  const again = compare(readLocal(dir), await fetchMirror({ base: BASE, fetch: m.fetch }));
  assert.equal(again.inSync, true);
});

test('jsonDiff reports added/removed keys and array changes', () => {
  assert.deepEqual(jsonDiff({ a: 1, b: [1, 2] }, { b: [1, 3], c: 'x' }), [
    { path: '/a', kind: 'removed', from: 1 },
    { path: '/b/1', kind: 'changed', from: 2, to: 3 },
    { path: '/c', kind: 'added', to: 'x' },
  ]);
});
