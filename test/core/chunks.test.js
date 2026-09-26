// Chunked config transfer: the platform's slicing (re-implemented in test/_support) against the
// gateway's reassembly in config-sync.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fnv1a32 } from '../../src/core/fnv.js';
import { createTopics } from '../../src/core/topics.js';
import { createValidators } from '../../src/core/schemas.js';
import { createConfigSync, SLOW_RETRY_MS } from '../../src/core/config-sync.js';
import {
  createFakeClock, sliceConfig, createRecordingTransport, createScriptedPlatform, autoAnswer, createMemoryLogger, flush,
} from '../_support/core-sync/helpers.js';

const FIXTURE = readFileSync(new URL('../fixtures/chunk-537.bin', import.meta.url));
const TENANT = '64b7a1000000000000000004';
const validators = createValidators();

function bigConfig(minBytes) {
  const devices = [];
  for (let d = 0; JSON.stringify({ devices, success: true }).length < minBytes; d++) {
    devices.push({
      _id: `66a1b2c3d4e5f60718${String(d).padStart(6, '0')}`,
      protocol: 'modbus-tcp',
      conn: { modbusId: 1, ip: '10.0.0.5', port: 502, sampleIntervalMs: 30000 },
      tags: Array.from({ length: 10 }, (_, t) => ({ name: `voltage_l${t}`, mbAddress: 40001 + t, thresholdStart: 200, thresholdEnd: 250 })),
    });
  }
  return Buffer.from(JSON.stringify({ devices, success: true }));
}

function setup({ bytes = FIXTURE, cap = 120, initialHash = 0 } = {}) {
  const clock = createFakeClock();
  const transport = createRecordingTransport();
  const log = createMemoryLogger();
  const platform = createScriptedPlatform(bytes);
  const applied = [];
  const saved = [];
  const sync = createConfigSync({
    transport,
    topics: createTopics({ tenant: TENANT, gateway: 'gw_test_01' }),
    state: { writeConfigRaw: (b, meta) => saved.push({ bytes: Buffer.from(b), meta }), readConfigRaw: () => null },
    clock, log, validators, configCap: cap, initialHash,
    onApply: async (b, doc, hash) => { applied.push({ bytes: Buffer.from(b), doc, hash }); },
  });
  autoAnswer(transport, platform, (reply) => sync.onMessage(reply));
  return { clock, transport, log, platform, applied, saved, sync };
}

/** Run the request/reply ping-pong until nothing new is published. */
async function settle(t) {
  for (let i = 0; i < 2000; i++) {
    const n = t.transport.published.length;
    await flush(10);
    await t.sync.idle();
    if (t.transport.published.length === n) return;
  }
  throw new Error('config-sync never settled');
}

async function connectAndSettle(t) {
  t.sync.onConnected();
  await t.clock.advance(2000);
  await settle(t);
}

test('the 537-byte vector: cap 120 → 13 parts of 56 base64 chars, the last 44, FNV 1657896004', () => {
  assert.equal(FIXTURE.length, 537);
  assert.equal(fnv1a32(FIXTURE), 1657896004);
  const parts = sliceConfig(FIXTURE, 120);
  assert.equal(parts.length, 13);
  parts.slice(0, -1).forEach((p) => assert.equal(p.d.length, 56));
  assert.equal(parts.at(-1).d.length, 44);
  for (const p of parts) {
    assert.equal(p.h, 1657896004);
    assert.equal(p.n, 13);
    const r = validators.validate('config-push', p);
    assert.ok(r.ok, r.errors.join());
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 120);
  }
  assert.deepEqual(Buffer.concat(parts.map((p) => Buffer.from(p.d, 'base64'))), FIXTURE);
});

test('config-sync pulls all 13 parts with the OLD hash, applies the exact bytes, then re-requests with the new hash', async () => {
  const t = setup();
  await connectAndSettle(t);
  assert.equal(t.applied.length, 1);
  assert.deepEqual(t.applied[0].bytes, FIXTURE);
  assert.equal(t.applied[0].hash, 1657896004);
  assert.deepEqual(t.saved[0].bytes, FIXTURE);
  assert.equal(t.saved[0].meta.via, 'chunked');
  const reqs = t.transport.requests();
  assert.deepEqual(reqs[0], { hash: 0, cap: 120 });
  assert.deepEqual(reqs.slice(1, 13).map((r) => r.part), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  for (const r of reqs.slice(0, 13)) assert.equal(r.hash, 0, 'every part request carries the old hash');
  assert.deepEqual(reqs[13], { hash: 1657896004, cap: 120 });
  assert.equal(reqs.length, 14);
  for (const r of reqs) assert.ok(validators.validate('config-request', r).ok);
  assert.equal(t.sync.synced(), true);
  assert.equal(t.sync.currentHash(), 1657896004);
});

test('a payload over 64 KiB reassembles with cap 4096', async () => {
  const big = bigConfig(70 * 1024);
  assert.ok(big.length > 65536);
  const t = setup({ bytes: big, cap: 4096 });
  await connectAndSettle(t);
  assert.equal(t.applied.length, 1);
  assert.ok(t.applied[0].bytes.equals(big));
  assert.equal(t.applied[0].hash, fnv1a32(big));
  assert.ok(t.platform.served.length > 20);
  assert.equal(t.sync.synced(), true);
});

test('a 4-byte emoji straddling a slice boundary reassembles byte-exact', async () => {
  // cap 120 → 56 base64 chars = 42 bytes per slice. Put U+1F321 (4 UTF-8 bytes) at bytes 40..43.
  const pre = '{"devices":[],"success":true,"x":"';
  const pad = 'a'.repeat(40 - Buffer.byteLength(pre));
  const s = `${pre}${pad}🌡${'b'.repeat(30)}"}`;
  const bytes = Buffer.from(s);
  assert.equal(bytes.indexOf(Buffer.from('🌡')), 40);
  const parts = sliceConfig(bytes, 120);
  // The seam really does split the character: part 0 decodes to half of it.
  assert.equal(Buffer.from(parts[0].d, 'base64').length, 42);
  assert.notEqual(Buffer.from(parts[0].d, 'base64').toString('utf8').at(-1), '🌡');
  const t = setup({ bytes });
  await connectAndSettle(t);
  assert.equal(t.applied.length, 1);
  assert.ok(t.applied[0].bytes.equals(bytes));
  assert.equal(t.applied[0].doc.x, `${pad}🌡${'b'.repeat(30)}`);
});

test('a tampered part fails the hash check and restarts the transfer at part 0', async () => {
  const t = setup();
  let tampered = false;
  t.platform.tamper = (part) => {
    if (part.p === 5 && !tampered) { tampered = true; return { ...part, d: `QUFB${part.d.slice(4)}` }; }
    return part;
  };
  await connectAndSettle(t);
  assert.equal(t.applied.length, 1, 'applied once, after the clean second transfer');
  assert.deepEqual(t.applied[0].bytes, FIXTURE);
  const served = t.platform.served;
  assert.deepEqual(served.slice(0, 13), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(served.slice(13, 26), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.match(t.log.text(), /failed its hash check; restarting/);
});

test('restarts are bounded: a part that is always corrupt ends in the slow 10-minute cadence', async () => {
  const t = setup();
  t.platform.tamper = (part) => (part.p === 2 ? { ...part, d: `QUFB${part.d.slice(4)}` } : part);
  await connectAndSettle(t);
  assert.equal(t.applied.length, 0);
  const transfers = t.platform.served.filter((p) => p === 0).length;
  assert.equal(transfers, 4, '1 transfer + 3 restarts');
  const before = t.transport.requests().length;
  await t.clock.advance(SLOW_RETRY_MS - 10000);
  assert.equal(t.transport.requests().length, before, 'quiet until the slow retry');
  t.platform.tamper = null;
  await t.clock.advance(20000);
  await settle(t);
  assert.equal(t.applied.length, 1);
});

test('the config changing mid-transfer (new h and n) restarts at part 0 and applies the new one', async () => {
  const t = setup();
  const next = Buffer.from(FIXTURE.toString('utf8').replace('"sdaPin":21', '"sdaPin":21,"note":"a longer config than before"'));
  assert.notEqual(sliceConfig(next, 120).length, 13);
  const origAnswer = t.platform.answer;
  t.platform.answer = (req) => {
    if (req.part === 5 && t.platform.bytes !== next) t.platform.bytes = next; // the user edits mid-transfer
    return origAnswer(req);
  };
  await connectAndSettle(t);
  assert.equal(t.applied.length, 1);
  assert.ok(t.applied[0].bytes.equals(next));
  assert.equal(t.applied[0].hash, fnv1a32(next));
  const reqs = t.transport.requests();
  const i = reqs.findIndex((r) => r.part === 5);
  assert.equal(reqs[i + 1].part, 0, 'part 5 of the new config (p≠0) → ask for part 0');
  assert.equal(reqs[i + 1].hash, 0, 'still the old hash');
});

test('duplicate parts are ignored; an out-of-order part re-requests the expected one', async () => {
  const clock = createFakeClock();
  const transport = createRecordingTransport();
  const applied = [];
  const sync = createConfigSync({
    transport, topics: createTopics({ tenant: TENANT, gateway: 'gw_test_01' }),
    state: { writeConfigRaw() {}, readConfigRaw: () => null },
    clock, log: createMemoryLogger(), configCap: 120, initialHash: 0,
    onApply: async (b) => { applied.push(Buffer.from(b)); },
  });
  const parts = sliceConfig(FIXTURE, 120).map((p) => Buffer.from(JSON.stringify(p)));
  sync.onConnected();
  await clock.advance(2000);
  sync.onMessage(parts[0]);
  sync.onMessage(parts[1]);
  sync.onMessage(parts[1]); // duplicate
  sync.onMessage(parts[3]); // out of order: part 2 is expected
  await sync.idle();
  const reqs = transport.requests();
  assert.deepEqual(reqs.map((r) => r.part ?? null), [null, 1, 2, 2]);
  for (let i = 2; i < parts.length; i++) sync.onMessage(parts[i]);
  await sync.idle();
  assert.equal(applied.length, 1);
  assert.ok(applied[0].equals(FIXTURE));
});

test('a part that never arrives is re-requested 3 times, then the transfer is abandoned', async () => {
  const t = setup();
  const origAnswer = t.platform.answer;
  t.platform.answer = (req) => (req.part === 7 ? null : origAnswer(req));
  await connectAndSettle(t);
  const seven = () => t.transport.requests().filter((r) => r.part === 7).length;
  assert.equal(seven(), 1);
  await t.clock.advance(10000);
  assert.equal(seven(), 2);
  await t.clock.advance(20000);
  assert.equal(seven(), 4, 'initial + 3 retries');
  await t.clock.advance(10000);
  assert.equal(seven(), 4);
  assert.match(t.log.text(), /abandoning the transfer/);
  assert.equal(t.applied.length, 0);
});

test('a full push during a transfer aborts the transfer and applies the full payload', async () => {
  const clock = createFakeClock();
  const transport = createRecordingTransport();
  const applied = [];
  const sync = createConfigSync({
    transport, topics: createTopics({ tenant: TENANT, gateway: 'gw_test_01' }),
    state: { writeConfigRaw() {}, readConfigRaw: () => null },
    clock, log: createMemoryLogger(), configCap: 120, initialHash: 0,
    onApply: async (b) => { applied.push(Buffer.from(b)); },
  });
  const parts = sliceConfig(FIXTURE, 120).map((p) => Buffer.from(JSON.stringify(p)));
  sync.onConnected();
  await clock.advance(2000);
  sync.onMessage(parts[0]);
  sync.onMessage(parts[1]);
  const full = Buffer.from('{"devices":[],"success":true}');
  sync.onMessage(full);
  sync.onMessage(parts[2]); // stale part of the abandoned transfer
  await sync.idle();
  assert.equal(applied.length, 1);
  assert.ok(applied[0].equals(full));
  const last = transport.requests().at(-1);
  // No transfer is running and the straggler is not part 0: ask for part 0 (with the new hash,
  // which the platform answers with `unchanged`).
  assert.deepEqual(last, { hash: fnv1a32(full), cap: 120, part: 0 });
});
