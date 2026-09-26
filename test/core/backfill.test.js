import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackfill, MAX_BATCH_BYTES, MAX_BATCH_RECORDS } from '../../src/core/backfill.js';
import { createValidators } from '../../src/core/schemas.js';
import { createFakeClock, createMemoryLogger } from '../_support/core-sync/helpers.js';

const validators = createValidators();
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sgw-bf-')); dirs.push(d); return d; };

const DEV_A = '66f1a2b3c4d5e6f708192a3b';
const DEV_B = '66f1a2b3c4d5e6f708192a3d';
const T0 = Date.UTC(2026, 0, 1);

function open(dir, clock, limits) {
  return createBackfill({ dir, clock, log: createMemoryLogger(), limits });
}

/** Drain everything, checking every batch against the protocol limits. */
async function drainAll(bf) {
  const batches = [];
  for (;;) {
    const n = await bf.drainTick(async (batch) => {
      const body = JSON.stringify({ batch });
      assert.ok(Buffer.byteLength(body) <= MAX_BATCH_BYTES, `batch of ${Buffer.byteLength(body)} bytes`);
      assert.ok(batch.length <= MAX_BATCH_RECORDS);
      const v = validators.validate('data-backfill', { batch });
      assert.ok(v.ok, v.errors.join());
      batches.push(batch);
    });
    if (n === 0) return batches;
  }
}

test('oldest first, ≤40 records per batch, schema-valid, then the buffer is empty and tidy', async () => {
  const clock = createFakeClock(T0);
  const dir = tmp();
  const bf = open(dir, clock);
  for (let i = 0; i < 100; i++) {
    assert.equal(bf.append({ deviceId: i % 2 ? DEV_A : DEV_B, ts: T0 + i * 1000, values: { t: i }, seq: i }), true);
  }
  assert.equal(bf.stats().records, 100);
  const batches = await drainAll(bf);
  assert.deepEqual(batches.map((b) => b.length), [40, 40, 20]);
  assert.deepEqual(batches.flat().map((r) => r.seq), Array.from({ length: 100 }, (_, i) => i));
  assert.deepEqual(bf.stats(), { records: 0, bytes: 0, dropped: 0, writeErrors: 0 });
  assert.deepEqual(readdirSync(dir), ['cursor.json'], 'drained segments are deleted');
});

test('the whole {"batch":[…]} body stays ≤ 3500 bytes with large records', async () => {
  const clock = createFakeClock(T0);
  const bf = open(tmp(), clock);
  for (let i = 0; i < 60; i++) bf.append({ deviceId: DEV_A, ts: T0 + i, values: { note: 'x'.repeat(200), v: i } });
  const batches = await drainAll(bf);
  assert.ok(batches.length > 3);
  assert.equal(batches.flat().length, 60);
  // Greedy: a batch is only cut when the next record would not fit.
  const sizes = batches.map((b) => Buffer.byteLength(JSON.stringify({ batch: b })));
  for (const s of sizes.slice(0, -1)) assert.ok(s > MAX_BATCH_BYTES - 260, `${s}`);
});

test('the cursor only advances after send resolves', async () => {
  const clock = createFakeClock(T0);
  const bf = open(tmp(), clock);
  for (let i = 0; i < 5; i++) bf.append({ deviceId: DEV_A, ts: T0 + i, values: { v: i } });
  await assert.rejects(bf.drainTick(async () => { throw new Error('socket closed'); }), /socket closed/);
  assert.equal(bf.stats().records, 5);
  const got = [];
  assert.equal(await bf.drainTick(async (b) => { got.push(...b); }), 5);
  assert.deepEqual(got.map((r) => r.values.v), [0, 1, 2, 3, 4]);
});

test('a drain is never concurrent with another', async () => {
  const clock = createFakeClock(T0);
  const bf = open(tmp(), clock);
  bf.append({ deviceId: DEV_A, ts: T0, values: { v: 1 } });
  let release;
  const first = bf.drainTick(() => new Promise((r) => { release = r; }));
  assert.equal(await bf.drainTick(async () => assert.fail('concurrent drain')), 0);
  release();
  assert.equal(await first, 1);
});

test('empty buffer: drainTick does not call send', async () => {
  const bf = open(tmp(), createFakeClock(T0));
  assert.equal(await bf.drainTick(async () => assert.fail('nothing to send')), 0);
});

test('persistence: a restart resumes after the last sent batch (with or without close)', async () => {
  const clock = createFakeClock(T0);
  const dir = tmp();
  let bf = open(dir, clock);
  for (let i = 0; i < 50; i++) bf.append({ deviceId: DEV_A, ts: T0 + i, values: { v: i }, seq: i });
  assert.equal(await bf.drainTick(async () => {}), 40);
  // No close(): the cursor is saved on every batch, so a crash loses nothing that was not sent.
  bf = open(dir, clock);
  assert.equal(bf.stats().records, 10);
  bf.append({ deviceId: DEV_A, ts: T0 + 50, values: { v: 50 }, seq: 50 });
  bf.close();
  bf = open(dir, clock);
  const rest = (await drainAll(bf)).flat();
  assert.deepEqual(rest.map((r) => r.seq), [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
});

test('overflow: over maxBytes the oldest segment is dropped and counted', async () => {
  const clock = createFakeClock(T0);
  const log = createMemoryLogger();
  const bf = createBackfill({ dir: tmp(), clock, log, limits: { maxBytes: 8192, segmentBytes: 1024 } });
  for (let i = 0; i < 400; i++) bf.append({ deviceId: DEV_A, ts: T0 + i, values: { v: i }, seq: i });
  const s = bf.stats();
  assert.ok(s.bytes <= 8192, `${s.bytes}`);
  assert.ok(s.dropped > 0);
  assert.equal(s.records + s.dropped, 400);
  const got = (await drainAll(bf)).flat();
  assert.equal(got.length, s.records);
  assert.equal(got.at(-1).seq, 399, 'the newest readings survive');
  assert.equal(got[0].seq, s.dropped, 'exactly the oldest ones were dropped');
  assert.ok(log.lines.some((l) => l.level === 'warn' && /dropped/.test(l.msg)));
});

test('age: segments older than maxAgeHours are dropped', async () => {
  const clock = createFakeClock(T0);
  const bf = open(tmp(), clock, { maxAgeHours: 1, maxBytes: 64 * 1024, segmentBytes: 4096 });
  for (let i = 0; i < 10; i++) bf.append({ deviceId: DEV_A, ts: clock.now(), values: { v: i } });
  await clock.advance(2 * 3600 * 1000);
  bf.append({ deviceId: DEV_A, ts: clock.now(), values: { v: 'new' } });
  const got = (await drainAll(bf)).flat();
  assert.deepEqual(got.map((r) => r.values.v), ['new']);
  assert.equal(bf.stats().dropped, 10);
});

test('year guard: nothing is buffered while the clock says < 2025', () => {
  const bf = open(tmp(), createFakeClock(Date.UTC(1970, 0, 2)));
  assert.equal(bf.append({ deviceId: DEV_A, ts: Date.UTC(1970, 0, 2), values: { v: 1 } }), false);
  assert.deepEqual(bf.stats(), { records: 0, bytes: 0, dropped: 1, writeErrors: 0 });
  const ok = open(tmp(), createFakeClock(T0));
  assert.equal(ok.append({ deviceId: DEV_A, ts: Date.UTC(2024, 11, 31), values: { v: 1 } }), false, 'a record stamped before 2025');
  assert.equal(ok.stats().dropped, 1);
});

test('records are rebuilt to the schema; unusable ones are refused', () => {
  const bf = open(tmp(), createFakeClock(T0));
  const bad = [
    { deviceId: 'nope', ts: T0, values: { v: 1 } },
    { deviceId: DEV_A, ts: T0 + 0.5, values: { v: 1 } },
    { deviceId: DEV_A, ts: T0, values: {} },
    { deviceId: DEV_A, ts: T0, values: { v: null, w: NaN, x: Infinity } },
    { deviceId: DEV_A, ts: T0, values: { big: 'x'.repeat(4000) } },
    null,
  ];
  for (const r of bad) assert.equal(bf.append(r), false, JSON.stringify(r));
  assert.equal(bf.stats().dropped, bad.length);
  assert.equal(bf.append({ deviceId: DEV_A, ts: T0, values: { v: 1, n: null }, seq: 3, q: 'stale', extra: 'x' }), true);
});

test('stored records carry only schema keys and keep good values', async () => {
  const bf = open(tmp(), createFakeClock(T0));
  bf.append({ deviceId: DEV_A, ts: T0, values: { v: 1, n: null, b: false }, seq: 3, q: 'stale', extra: 'x' });
  const [batch] = await drainAll(bf);
  assert.deepEqual(batch, [{ deviceId: DEV_A, ts: T0, values: { v: 1, b: false }, q: 'stale', seq: 3 }]);
});

test('a corrupt line is skipped and counted; a torn trailing line is cut on open', async () => {
  const clock = createFakeClock(T0);
  const dir = tmp();
  let bf = open(dir, clock);
  for (let i = 0; i < 3; i++) bf.append({ deviceId: DEV_A, ts: T0 + i, values: { v: i } });
  bf.close();
  const seg = join(dir, readdirSync(dir).find((f) => f.startsWith('seg-')));
  appendFileSync(seg, 'this is not json\n{"deviceId":"x"}\n');
  bf = open(dir, clock);
  bf.append({ deviceId: DEV_A, ts: T0 + 9, values: { v: 9 } });
  bf.close();
  appendFileSync(seg, '{"deviceId":"66f1a2b3c4d5e6f708192a3b","ts":17'); // crash mid-append
  bf = open(dir, clock);
  const got = (await drainAll(bf)).flat();
  assert.deepEqual(got.map((r) => r.values.v), [0, 1, 2, 9]);
  assert.equal(bf.stats().dropped, 3, 'two corrupt lines + one torn line');
});

test('a write failure counts as a write error and a drop', () => {
  const dir = tmp();
  const bf = open(dir, createFakeClock(T0));
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, 'a file where the directory was');
  assert.equal(bf.append({ deviceId: DEV_A, ts: T0, values: { v: 1 } }), false);
  assert.deepEqual(bf.stats(), { records: 0, bytes: 0, dropped: 1, writeErrors: 1 });
  rmSync(dir, { force: true });
});
