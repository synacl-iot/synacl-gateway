import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDriver, testDriver } from '../../src/conformance/driver-harness.js';

/** A minimal well-behaved driver; `over` replaces parts of its instance. */
function driver(over = {}, defOver = {}) {
  return {
    apiVersion: 1,
    name: 'harness-test',
    protocols: ['http'],
    create(ctx) {
      return {
        async open(device) {
          if (device.conn.password) ctx.log.redact(device.conn.password);
          ctx.log.info(`opening with ${device.conn.password || 'no password'}`);
          return { closed: false };
        },
        async read(_h, tags) { return { values: Object.fromEntries(tags.map((t) => [t.name, 1.5])), reachable: true }; },
        async close(h) { h.closed = true; },
        ...over(ctx),
      };
    },
    ...defOver,
  };
}
const ok = (fn) => driver((ctx) => fn(ctx));

test('a well-behaved driver passes every check', async () => {
  const r = await assertDriver(driver(() => ({})), { device: { conn: { password: 'hunter2-secret' }, tags: [{ name: 'a' }, { name: 'b' }] } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => c.id), ['shape', 'api-version', 'create', 'open', 'read.1', 'read.2', 'read-tags', 'abort', 'close', 'close-idempotent', 'secrets']);
});

test('the module namespace form (default export) is accepted', async () => {
  const r = await testDriver({ default: driver(() => ({})) });
  assert.equal(r.ok, true);
});

test('null, NaN and unrequested values fail the read check', async () => {
  const r = await testDriver(ok(() => ({ async read() { return { values: { a: null, b: Number.NaN, zzz: 1 }, reachable: true }; } })), { device: { tags: [{ name: 'a' }, { name: 'b' }] } });
  const read = r.checks.find((c) => c.id === 'read.1');
  assert.equal(read.ok, false);
  assert.match(read.message, /values\.a is null/);
  assert.match(read.message, /values\.b is NaN/);
  assert.match(read.message, /values\.zzz was not requested/);
});

test('a long reason and a missing reachable flag fail', async () => {
  const r = await testDriver(ok(() => ({ async read() { return { values: {}, reason: 'x'.repeat(200) }; } })));
  const read = r.checks.find((c) => c.id === 'read.1');
  assert.match(read.message, /reachable/);
  assert.match(read.message, /128/);
});

test('a secret logged before it is registered is caught', async () => {
  const leaky = driver(() => ({}));
  const orig = leaky.create;
  leaky.create = (ctx) => { const inst = orig(ctx); const open = inst.open; inst.open = async (d) => { ctx.log.info(`connecting to broker as u:${d.conn.password}`); return open(d); }; return inst; };
  const r = await testDriver(leaky, { device: { conn: { password: 'hunter2-secret' } } });
  const s = r.checks.find((c) => c.id === 'secrets');
  assert.equal(s.ok, false);
  assert.match(s.message, /redact/);
});

test('close must be idempotent', async () => {
  const r = await testDriver(ok(() => ({ async close(h) { if (h.closed) throw new Error('already closed'); h.closed = true; } })));
  assert.equal(r.checks.find((c) => c.id === 'close-idempotent').ok, false);
});

test('a read that ignores its abort signal and hangs is reported', async () => {
  const r = await testDriver(ok(() => ({ read: () => new Promise(() => {}) })), { timeoutMs: 200, reads: 1 });
  assert.equal(r.checks.find((c) => c.id === 'read.1').ok, false);
  assert.equal(r.checks.find((c) => c.id === 'abort').ok, false);
});

test('wrong apiVersion and a bad shape fail early; assertDriver throws with the list', async () => {
  const bad = { ...driver(() => ({})), apiVersion: 2, protocols: [] };
  const r = await testDriver(bad);
  assert.equal(r.checks.find((c) => c.id === 'api-version').ok, false);
  assert.equal(r.checks.find((c) => c.id === 'shape').ok, false);
  await assert.rejects(assertDriver(bad), /api-version/);
});

test('write results are checked when a write op is given', async () => {
  const r = await testDriver(ok(() => ({ async write() { return { ok: 'yes' }; } })), { write: { kind: 'modbus', registerType: 'holding', address: 1, value: 2 } });
  assert.equal(r.checks.find((c) => c.id === 'write').ok, false);
});

test('the built-in host driver honours the contract', async () => {
  const { hostDriver } = await import('../../src/drivers/index.js');
  await assertDriver(hostDriver, { device: { conn: { sampleIntervalMs: 10_000 }, tags: [{ name: 'uptime', metric: 'uptime_s' }, { name: 'mem', metric: 'mem.used_pct' }] } });
});
