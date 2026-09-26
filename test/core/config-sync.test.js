import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fnv1a32 } from '../../src/core/fnv.js';
import { createTopics } from '../../src/core/topics.js';
import { createValidators } from '../../src/core/schemas.js';
import { createConfigSync } from '../../src/core/config-sync.js';
import {
  createFakeClock, createRecordingTransport, createScriptedPlatform, autoAnswer, createMemoryLogger, flush,
} from '../_support/core-sync/helpers.js';

const FIXTURE = readFileSync(new URL('../fixtures/config-3420619844.bin', import.meta.url));
const TENANT = '64b7a1000000000000000004';
const GW = 'gw_test_01';
const validators = createValidators();

function setup({ bytes = FIXTURE, cap = null, initialHash = 0, answer = true, onApply } = {}) {
  const clock = createFakeClock();
  const transport = createRecordingTransport();
  const log = createMemoryLogger();
  const platform = createScriptedPlatform(bytes);
  const calls = [];
  const sync = createConfigSync({
    transport,
    topics: createTopics({ tenant: TENANT, gateway: GW }),
    state: {
      writeConfigRaw: (b, meta) => calls.push({ kind: 'persist', bytes: Buffer.from(b), meta }),
      readConfigRaw: () => null,
    },
    clock, log, validators, configCap: cap, initialHash,
    onApply: onApply ?? (async (b, doc, hash) => { calls.push({ kind: 'apply', bytes: Buffer.from(b), doc, hash }); }),
  });
  if (answer) autoAnswer(transport, platform, (reply) => sync.onMessage(reply));
  const applied = () => calls.filter((c) => c.kind === 'apply');
  return { clock, transport, log, platform, calls, applied, sync };
}

async function settle(t) {
  for (let i = 0; i < 200; i++) {
    const n = t.transport.published.length;
    await flush(10);
    await t.sync.idle();
    if (t.transport.published.length === n) return;
  }
}

test('the first request goes out 2 s after onConnected, carrying the current hash and no cap', async () => {
  const t = setup({ initialHash: 12345, answer: false });
  t.sync.onConnected();
  await t.clock.advance(1999);
  assert.equal(t.transport.requests().length, 0);
  await t.clock.advance(1);
  assert.deepEqual(t.transport.requests(), [{ hash: 12345 }]);
  const msg = t.transport.published[0];
  assert.equal(msg.topic, `tenants/${TENANT}/sources/gateway/${GW}/config/request`);
  assert.equal(msg.opts.qos, 0);
});

test('first boot: {hash:0} → full payload → exact bytes persisted, applied, re-requested with the new hash → unchanged → synced', async () => {
  const t = setup();
  t.sync.onConnected();
  await t.clock.advance(2000);
  await settle(t);
  assert.deepEqual(t.transport.requests(), [{ hash: 0 }, { hash: 3420619844 }]);
  const [persist, apply] = t.calls;
  assert.equal(persist.kind, 'persist', 'bytes are persisted BEFORE the apply');
  assert.ok(persist.bytes.equals(FIXTURE));
  assert.equal(persist.meta.hash, 3420619844);
  assert.equal(persist.meta.bytes, 210);
  assert.equal(persist.meta.via, 'reply');
  assert.equal(apply.kind, 'apply');
  assert.ok(apply.bytes.equals(FIXTURE));
  assert.equal(apply.hash, 3420619844);
  assert.equal(apply.doc.devices[0].tags[0].name, 'oil_temp');
  assert.equal(t.sync.currentHash(), 3420619844);
  assert.equal(t.sync.synced(), true);
});

test('the hash is over the RAW bytes, not a re-serialisation', async () => {
  const raw = Buffer.from('{ "devices" : [ ], "success" : true, "x": 1e-2 }');
  assert.notEqual(fnv1a32(raw), fnv1a32(JSON.stringify(JSON.parse(raw.toString()))));
  const t = setup({ bytes: raw });
  t.sync.onConnected();
  await t.clock.advance(2000);
  await settle(t);
  assert.equal(t.applied()[0].hash, fnv1a32(raw));
  assert.deepEqual(t.transport.requests().at(-1), { hash: fnv1a32(raw) });
  assert.equal(t.sync.synced(), true);
});

test('a matching hash gets {"unchanged":true}: synced, nothing applied, no further request', async () => {
  const t = setup({ initialHash: 3420619844 });
  t.sync.onConnected();
  await t.clock.advance(2000);
  await settle(t);
  await t.clock.advance(3600_000);
  assert.deepEqual(t.transport.requests(), [{ hash: 3420619844 }]);
  assert.equal(t.applied().length, 0);
  assert.equal(t.sync.synced(), true);
});

test('silence: retries at +10, +20, +40, +80 s, then every 10 minutes; ≤5 requests in the first 5 minutes', async () => {
  const t = setup({ answer: false });
  t.sync.onConnected();
  const times = [];
  const start = t.clock.now();
  const orig = t.transport.publish.bind(t.transport);
  t.transport.publish = (topic, p, o) => { times.push((t.clock.now() - start) / 1000); return orig(topic, p, o); };
  await t.clock.advance(2000 + 300_000);
  assert.deepEqual(times, [2, 12, 32, 72, 152]);
  await t.clock.advance(1_200_000);
  assert.deepEqual(times, [2, 12, 32, 72, 152, 752, 1352]);
  assert.match(t.log.text(), /no reply to config\/request/);
  assert.match(t.log.text(), /config-too-large/);
});

test('a reconnect resets the retry counter and cancels pending retries', async () => {
  const t = setup({ answer: false });
  t.sync.onConnected();
  await t.clock.advance(2000 + 10000 + 20000 + 40000); // 4 requests, next in 80 s
  assert.equal(t.transport.requests().length, 4);
  t.sync.onDisconnected();
  await t.clock.advance(600_000);
  assert.equal(t.transport.requests().length, 4, 'nothing while disconnected');
  t.sync.onConnected();
  await t.clock.advance(2000);
  assert.equal(t.transport.requests().length, 5);
  await t.clock.advance(10000);
  assert.equal(t.transport.requests().length, 6, 'back to the 10 s first retry');
});

test('an answer that arrives late (during the retry window) still syncs and stops the retries', async () => {
  const t = setup({ answer: false });
  t.sync.onConnected();
  await t.clock.advance(2000 + 10000);
  t.sync.onMessage(Buffer.from('{"unchanged":true}'));
  await t.sync.idle();
  await t.clock.advance(3600_000);
  assert.equal(t.transport.requests().length, 2);
  assert.equal(t.sync.synced(), true);
});

test('invalid payloads keep the old config and are NOT re-requested', async () => {
  for (const bad of ['not json', '[]', '{"devices":[]}', '{"devices":[],"success":false}', '{"devices":{},"success":true}', '{"success":true}']) {
    const t = setup({ initialHash: 777, answer: false });
    t.sync.onConnected();
    await t.clock.advance(2000);
    t.sync.onMessage(Buffer.from(bad));
    await t.sync.idle();
    await t.clock.advance(3600_000);
    assert.equal(t.transport.requests().length, 1, bad);
    assert.equal(t.calls.length, 0, bad);
    assert.equal(t.sync.currentHash(), 777, bad);
    assert.ok(t.log.lines.some((l) => l.level === 'error'), bad);
  }
});

test('a schema mismatch is only a warning: the config is still applied', async () => {
  const odd = Buffer.from('{"devices":[{"_id":"66f1a2b3c4d5e6f708192a3b","protocol":"host","conn":{},"tags":[{"name":"t","mbFormat":"x16"}]}],"success":true}');
  const t = setup({ bytes: odd });
  t.sync.onConnected();
  await t.clock.advance(2000);
  await settle(t);
  assert.equal(t.applied().length, 1);
  assert.ok(t.log.lines.some((l) => l.level === 'warn' && /published schema/.test(l.msg)));
  assert.equal(t.sync.synced(), true);
});

test('an unprompted push is applied without reconnecting and re-requested', async () => {
  const t = setup();
  t.sync.onConnected();
  await t.clock.advance(2000);
  await settle(t);
  const next = Buffer.from(FIXTURE.toString().replace('"thresholdEnd":80', '"thresholdEnd":90'));
  t.platform.bytes = next;
  t.sync.onMessage(next);
  await settle(t);
  assert.equal(t.applied().length, 2);
  assert.equal(t.applied()[1].hash, fnv1a32(next));
  assert.equal(t.calls.filter((c) => c.kind === 'persist')[1].meta.via, 'push');
  assert.deepEqual(t.transport.requests().at(-1), { hash: fnv1a32(next) });
  assert.equal(t.sync.synced(), true);
});

test('an unprompted push with identical bytes is not re-applied but is still re-requested', async () => {
  const t = setup();
  t.sync.onConnected();
  await t.clock.advance(2000);
  await settle(t);
  const before = t.transport.requests().length;
  t.sync.onMessage(Buffer.from(FIXTURE));
  await settle(t);
  assert.equal(t.applied().length, 1);
  assert.equal(t.calls.filter((c) => c.kind === 'persist').length, 1);
  assert.equal(t.transport.requests().length, before + 1);
  assert.deepEqual(t.transport.requests().at(-1), { hash: 3420619844 });
});

test('a failing apply is logged and the new hash is still reported', async () => {
  const t = setup({ onApply: async () => { throw new Error('driver exploded'); } });
  t.sync.onConnected();
  await t.clock.advance(2000);
  await settle(t);
  assert.match(t.log.text(), /driver exploded/);
  assert.deepEqual(t.transport.requests(), [{ hash: 0 }, { hash: 3420619844 }]);
});

test('applies are serialised: a second push waits for the first apply', async () => {
  let release;
  const order = [];
  const t = setup({
    answer: false,
    onApply: async (b, doc, hash) => {
      order.push(`start ${hash}`);
      if (!release) await new Promise((r) => { release = r; });
      order.push(`end ${hash}`);
    },
  });
  t.sync.onConnected();
  const a = Buffer.from('{"devices":[],"success":true}');
  const b = Buffer.from(FIXTURE);
  t.sync.onMessage(a);
  t.sync.onMessage(b);
  await flush();
  assert.deepEqual(order, [`start ${fnv1a32(a)}`]);
  release();
  await t.sync.idle();
  assert.deepEqual(order, [`start ${fnv1a32(a)}`, `end ${fnv1a32(a)}`, `start ${fnv1a32(b)}`, `end ${fnv1a32(b)}`]);
});

test('requestNow sends at once; cap is sent only when configCap is set', async () => {
  const t = setup({ answer: false, initialHash: 5 });
  t.sync.onConnected();
  t.sync.requestNow('sighup');
  assert.deepEqual(t.transport.requests(), [{ hash: 5 }]);
  await t.clock.advance(2000);
  assert.equal(t.transport.requests().length, 1, 'the pending 2 s request was superseded');
  const c = setup({ answer: false, initialHash: 5, cap: 4096 });
  c.sync.onConnected();
  await c.clock.advance(2000);
  assert.deepEqual(c.transport.requests(), [{ hash: 5, cap: 4096 }]);
});

test('nothing is sent while the transport is disconnected, and stop() silences everything', async () => {
  const t = setup({ answer: false });
  t.transport.connected = false;
  t.sync.onConnected();
  await t.clock.advance(60_000);
  assert.equal(t.transport.published.length, 0);
  t.transport.connected = true;
  t.sync.stop();
  t.sync.requestNow();
  await t.clock.advance(3600_000);
  assert.equal(t.transport.published.length, 0);
  assert.equal(t.clock.pending(), 0);
});

test('the initial hash is read from state when not given', () => {
  const sync = createConfigSync({
    transport: createRecordingTransport(), topics: createTopics({ tenant: TENANT, gateway: GW }),
    state: { readConfigRaw: () => ({ bytes: FIXTURE, meta: { hash: 3420619844 } }), writeConfigRaw() {} },
    clock: createFakeClock(), log: createMemoryLogger(), onApply: async () => {},
  });
  assert.equal(sync.currentHash(), 3420619844);
});
