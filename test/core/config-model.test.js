import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeConfig, pruneOverrides, canonicalJson, intervalFor } from '../../src/core/config-model.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/config-3420619844.bin', import.meta.url), 'utf8'));
const ID = '66f1a2b3c4d5e6f708192a3b';
const ID2 = '66f1a2b3c4d5e6f708192a3c';
const dev = (extra = {}) => ({ _id: ID, protocol: 'host', conn: {}, tags: [{ name: 't' }], ...extra });

test('the pinned fixture: oil_temp keeps isIntervalRead:false and its 10..80 band; everything else defaults', () => {
  const { devices, errors } = normalizeConfig(FIXTURE, { minIntervalMs: 1000 });
  assert.deepEqual(errors, []);
  assert.equal(devices.length, 1);
  const d = devices[0];
  assert.equal(d.id, '64b7a1000000000000000002');
  assert.equal(d.protocol, 'rs485');
  assert.deepEqual(d.conn, { baudRate: 9600, modbusId: 1 });
  assert.equal(d.intervalMs, 10000);
  const t = d.tags[0];
  assert.equal(t.name, 'oil_temp');
  assert.equal(t.isIntervalRead, false);
  assert.equal(t.thresholdStart, 10);
  assert.equal(t.thresholdEnd, 80);
  assert.equal(t.registerType, 'holding');
  assert.equal(t.mbFormat, 'u16');
  assert.equal(t.scaleFactor, 1);
  assert.deepEqual(t.raw, FIXTURE.devices[0].tags[0]);
  assert.equal(d.raw, FIXTURE.devices[0]);
});

test('every omitted tag key gets the firmware default', () => {
  const { devices } = normalizeConfig({ devices: [dev()], success: true });
  const t = devices[0].tags[0];
  assert.deepEqual({ ...t, raw: undefined }, {
    name: 't', mbAddress: 0, registerType: 'holding', mbFormat: 'u16', mbWordOrder: 'big', isIntervalRead: true,
    scaleFactor: 1, offset: 0, thresholdStart: 0, thresholdEnd: 0, i2cAddress: 0, sensorModel: '', gpioPin: -1,
    canId: 0, mbusRecord: 0, jsonPath: '', bleField: '', metric: '', topic: '', cmdTopic: '', initByte: 0,
    readBytes: 2, bigEndian: true, raw: undefined,
  });
});

test('present keys win over defaults (including the non-zero ones), unknown keys are ignored', () => {
  const tag = {
    name: 'x', mbAddress: 7, registerType: 'coil', mbFormat: 'f32', mbWordOrder: 'little', isIntervalRead: false,
    scaleFactor: 0.01, offset: -5, thresholdStart: -1e9, thresholdEnd: 50, gpioPin: 0, readBytes: 4, bigEndian: false,
    metric: 'cpu.temp', topic: 'tele/+/SENSOR', jsonPath: 'ENERGY.Power', futureKey: 'ignored',
  };
  const { devices, errors } = normalizeConfig({ devices: [dev({ tags: [tag] })], success: true });
  assert.deepEqual(errors, []);
  const t = devices[0].tags[0];
  for (const [k, v] of Object.entries(tag)) if (k !== 'futureKey') assert.equal(t[k], v, k);
  assert.equal('futureKey' in t, false);
  assert.equal(t.raw.futureKey, 'ignored');
});

test('bad tag values fall back to the default with an error line; enum typos are caught', () => {
  const { devices, errors } = normalizeConfig({
    devices: [dev({ tags: [{ name: 'x', registerType: 'Holding', mbFormat: 'x16', scaleFactor: 'abc', isIntervalRead: 'yes', mbAddress: 1.5 }] })],
    success: true,
  });
  const t = devices[0].tags[0];
  assert.equal(t.registerType, 'holding');
  assert.equal(t.mbFormat, 'u16');
  assert.equal(t.scaleFactor, 1);
  assert.equal(t.isIntervalRead, true);
  assert.equal(t.mbAddress, 0);
  assert.equal(errors.length, 5);
});

test('numeric strings are coerced for numeric keys', () => {
  const { devices } = normalizeConfig({ devices: [dev({ tags: [{ name: 'x', scaleFactor: '0.5', mbAddress: '12' }] })], success: true });
  assert.equal(devices[0].tags[0].scaleFactor, 0.5);
  assert.equal(devices[0].tags[0].mbAddress, 12);
});

test('interval: override ?? sampleIntervalMs ?? tickDuration ?? 10 s', () => {
  assert.equal(intervalFor({}, undefined, 1000), 10000);
  assert.equal(intervalFor({ tickDuration: 5000 }, undefined, 1000), 5000);
  assert.equal(intervalFor({ tickDuration: 5000, sampleIntervalMs: 30000 }, undefined, 1000), 30000);
  assert.equal(intervalFor({ tickDuration: 5000, sampleIntervalMs: 30000 }, 2000, 1000), 2000);
  assert.equal(intervalFor({ sampleIntervalMs: '15000' }, undefined, 1000), 15000, 'numeric string');
  assert.equal(intervalFor({ sampleIntervalMs: 'soon', tickDuration: 7000 }, undefined, 1000), 7000, 'garbage falls through');
  assert.equal(intervalFor({ sampleIntervalMs: 0, tickDuration: 7000 }, undefined, 1000), 7000, 'zero falls through');
  assert.equal(intervalFor(null, undefined, 1000), 10000);
});

test('interval clamp: [max(250, minIntervalMs), 1 h]', () => {
  assert.equal(intervalFor({ sampleIntervalMs: 100 }, undefined, 1000), 1000);
  assert.equal(intervalFor({ sampleIntervalMs: 100 }, undefined, 100), 250, 'never below 250');
  assert.equal(intervalFor({ sampleIntervalMs: 300 }, undefined, 250), 300);
  assert.equal(intervalFor({ sampleIntervalMs: 9e9 }, undefined, 1000), 3600000);
  assert.equal(intervalFor({ sampleIntervalMs: 1500 }, 200, 2000), 2000, 'the override is clamped too');
  assert.equal(normalizeConfig({ devices: [dev({ conn: { sampleIntervalMs: 500 } })] }).devices[0].intervalMs, 1000, 'default floor 1000');
});

test('overrides apply per device; one set before the config arrived is ignored', () => {
  const overrides = { v: 1, devices: { [ID]: { intervalMs: 5000, intervalSetAt: 2000 } } };
  const doc = { devices: [dev({ conn: { sampleIntervalMs: 30000 } }), dev({ _id: ID2 })], success: true };
  const a = normalizeConfig(doc, { overrides, minIntervalMs: 1000 });
  assert.equal(a.devices[0].intervalMs, 5000);
  assert.equal(a.devices[1].intervalMs, 10000);
  assert.equal(normalizeConfig(doc, { overrides, receivedAt: 1000 }).devices[0].intervalMs, 5000, 'set after the config');
  assert.equal(normalizeConfig(doc, { overrides, receivedAt: 3000 }).devices[0].intervalMs, 30000, 'superseded by a newer config');
});

test('pruneOverrides drops superseded intervals but keeps read-pause state', () => {
  const o = { v: 1, devices: {
    a: { intervalMs: 5000, intervalSetAt: 100 },
    b: { intervalMs: 5000, intervalSetAt: 900, read: { enabled: false, mode: 'manual' } },
    c: { intervalMs: 5000, intervalSetAt: 5000 },
    d: { read: { enabled: false, mode: 'timed', until: 9999 } },
  } };
  const { overrides, changed } = pruneOverrides(o, 1000);
  assert.equal(changed, true);
  assert.deepEqual(overrides, { v: 1, devices: {
    b: { read: { enabled: false, mode: 'manual' } },
    c: { intervalMs: 5000, intervalSetAt: 5000 },
    d: { read: { enabled: false, mode: 'timed', until: 9999 } },
  } });
  assert.equal(pruneOverrides(overrides, 1000).changed, false);
  assert.deepEqual(pruneOverrides(undefined, 1).overrides, { v: 1, devices: {} });
});

test('readIntervalMs is honoured for modbus-tcp only, and only below the publish interval', () => {
  const mk = (protocol, conn) => normalizeConfig({ devices: [dev({ protocol, conn })] }).devices[0].readIntervalMs;
  assert.equal(mk('modbus-tcp', { sampleIntervalMs: 10000, readIntervalMs: 2000 }), 2000);
  assert.equal(mk('modbus-tcp', { sampleIntervalMs: 10000, readIntervalMs: 100 }), 250);
  assert.equal(mk('modbus-tcp', { sampleIntervalMs: 10000, readIntervalMs: 10000 }), 0);
  assert.equal(mk('modbus-tcp', { sampleIntervalMs: 10000 }), 0);
  assert.equal(mk('host', { sampleIntervalMs: 10000, readIntervalMs: 2000 }), 0);
});

test('bad devices are skipped with an error; good ones survive', () => {
  const { devices, errors } = normalizeConfig({
    devices: [
      null, 'x', [],
      { protocol: 'host', conn: {}, tags: [] },
      { _id: 'not-hex', protocol: 'host' },
      { _id: ID, conn: {}, tags: [] },
      dev({ _id: ID2 }),
      dev({ _id: ID2, protocol: 'modbus-tcp' }),
      dev({ _id: '66f1a2b3c4d5e6f708192a3d', tags: [{ name: '' }, { nope: 1 }, { name: 'ok' }, { name: 'ok' }] }),
    ],
    success: true,
  });
  assert.deepEqual(devices.map((d) => d.id), [ID2, '66f1a2b3c4d5e6f708192a3d']);
  assert.equal(devices[0].protocol, 'host', 'the first entry for a duplicated id wins');
  assert.deepEqual(devices[1].tags.map((t) => t.name), ['ok']);
  assert.equal(errors.length, 10);
  for (const e of errors) assert.equal(typeof e, 'string');
});

test('a document without a devices array yields no devices and one error', () => {
  for (const doc of [null, {}, { devices: 'x' }]) {
    const r = normalizeConfig(doc);
    assert.deepEqual(r.devices, []);
    assert.equal(r.errors.length, 1);
  }
});

test('missing conn / tags are tolerated', () => {
  const { devices, errors } = normalizeConfig({ devices: [{ _id: ID, protocol: 'host' }] });
  assert.deepEqual(errors, []);
  assert.deepEqual(devices[0].conn, {});
  assert.deepEqual(devices[0].tags, []);
});

test('fingerprint: canonical JSON of {protocol, conn, tags} — key order does not matter, content does', () => {
  const a = normalizeConfig({ devices: [dev({ conn: { ip: '1.2.3.4', port: 502 }, tags: [{ name: 't', mbAddress: 1 }] })] }).devices[0];
  const b = normalizeConfig({ devices: [dev({ conn: { port: 502, ip: '1.2.3.4' }, tags: [{ mbAddress: 1, name: 't' }] })] }).devices[0];
  const c = normalizeConfig({ devices: [dev({ conn: { port: 503, ip: '1.2.3.4' }, tags: [{ mbAddress: 1, name: 't' }] })] }).devices[0];
  const d = normalizeConfig({ devices: [dev({ conn: { port: 502, ip: '1.2.3.4', sampleIntervalMs: 5000 }, tags: [{ mbAddress: 1, name: 't' }] })] }).devices[0];
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.notEqual(a.fingerprint, d.fingerprint, 'conn is compared whole');
  assert.equal(canonicalJson({ b: [1, { d: 2, c: 3 }], a: null }), '{"a":null,"b":[1,{"c":3,"d":2}]}');
});
