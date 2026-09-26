import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createValidators } from '../../src/core/schemas.js';

const dir = fileURLToPath(new URL('../../protocol/v1/', import.meta.url));
const v = createValidators();

test('every schema compiles', () => {
  const files = readdirSync(`${dir}schemas`).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual([...v.names()].sort(), files);
  assert.equal(files.length, 24);
});

test('every vendored example validates against its schema', () => {
  const examples = readdirSync(`${dir}examples`).filter((f) => f.endsWith('.json'));
  assert.equal(examples.length, 65);
  for (const f of examples) {
    const schema = f.split('.')[0];
    const r = v.validate(schema, JSON.parse(readFileSync(`${dir}examples/${f}`, 'utf8')));
    assert.ok(r.ok, `${f}: ${r.errors.join('; ')}`);
  }
});

test('the validator is plain: it neither strips nor defaults', () => {
  const value = { ts: 1758801420000, values: { t: 1 }, extra: 1 };
  const r = v.validate('data', value);
  assert.equal(r.ok, false);
  assert.ok(value.extra === 1 && !('q' in value), 'the value was mutated');
  assert.match(r.errors.join(), /additional properties \(extra\)/);
});

test('hand-written negatives are rejected', () => {
  assert.equal(v.validate('data', { ts: 1, values: { t: null } }).ok, false, 'null value');
  assert.equal(v.validate('data', { ts: 1.5, values: { t: 1 } }).ok, false, 'float ts');
  assert.equal(v.validate('data', { ts: 1, values: {} }).ok, false, 'empty values');
  const rec = { deviceId: '66f1a2b3c4d5e6f708192a3b', ts: 1758801420000, values: { t: 1 } };
  assert.equal(v.validate('data-backfill', { batch: Array(40).fill(rec) }).ok, true, '40 records');
  assert.equal(v.validate('data-backfill', { batch: Array(41).fill(rec) }).ok, false, '41 records');
  assert.equal(v.validate('data-backfill', { batch: [] }).ok, false, 'empty batch');
  assert.equal(v.validate('source-status', { online: true, ts: 1, paused: true }).ok, false, 'undeclared key');
  assert.equal(v.validate('debug-log', { ts: 1, seq: 1, lines: ['x'.repeat(513)] }).ok, false, '513-char log line');
  assert.equal(v.validate('config-push', { unchanged: false }).ok, false);
  assert.equal(v.validate('config-push', { devices: [], success: false }).ok, false);
});

test('gateway uplinks this module set builds are valid', () => {
  assert.ok(v.validate('source-status', { online: false }).ok);
  assert.ok(v.validate('config-request', { hash: 0 }).ok);
  assert.ok(v.validate('config-request', { hash: 3420619844 }).ok);
  assert.ok(v.validate('config-request', { hash: 3420619844, cap: 120, part: 3 }).ok);
});

test('unknown schema names fail loudly instead of passing', () => {
  const r = v.validate('nope', {});
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /unknown schema/);
});
