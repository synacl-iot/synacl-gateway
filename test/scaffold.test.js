import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { version } from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('version is plain semver (the platform parses it as a firmware version)', () => {
  assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

test('the vendored protocol has its 24 schemas, 65 examples and the topic table', () => {
  assert.equal(readdirSync(`${root}protocol/v1/schemas`).filter((f) => f.endsWith('.json')).length, 24);
  assert.equal(readdirSync(`${root}protocol/v1/examples`).filter((f) => f.endsWith('.json')).length, 65);
  const topics = JSON.parse(readFileSync(`${root}protocol/v1/topics.json`, 'utf8'));
  assert.equal(topics.topics.length, 28);
  assert.equal(topics.prefix, 'tenants/{tenantId}/sources/gateway/{chipId}');
});
