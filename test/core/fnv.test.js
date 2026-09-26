import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fnv1a32 } from '../../src/core/fnv.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

test('FNV-1a 32-bit reference vectors', () => {
  assert.equal(fnv1a32(''), 2166136261);
  assert.equal(fnv1a32('a'), 3826002220);
  assert.equal(fnv1a32('foobar'), 3214735720);
});

test('the platform payload vectors', () => {
  assert.equal(fnv1a32('{"devices":[],"success":true}'), 2928945295);
  assert.equal(fnv1a32('{"unchanged":true}'), 2193177828);
});

test('the pinned 210-byte config hashes to 3420619844', () => {
  const bytes = fixture('config-3420619844.bin');
  assert.equal(bytes.length, 210);
  assert.equal(fnv1a32(bytes), 3420619844);
});

test('Buffer, Uint8Array and string (as UTF-8) agree, including multi-byte characters', () => {
  for (const s of ['foobar', 'température_°C', '🌡️ 21.5', fixture('chunk-537.bin').toString('utf8')]) {
    const b = Buffer.from(s, 'utf8');
    assert.equal(fnv1a32(s), fnv1a32(b));
    assert.equal(fnv1a32(new Uint8Array(b)), fnv1a32(b));
  }
});

test('always an unsigned 32-bit integer', () => {
  for (const s of ['', 'x', 'foobar', '{"a":1}', 'z'.repeat(1000)]) {
    const h = fnv1a32(s);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `${h}`);
  }
});
