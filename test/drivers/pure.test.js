// Pure helpers: topic filters, JSON paths, Modbus word decoding, value normalisation, and the
// driver-definition validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicMatches, filterError } from '../../src/drivers/topic-match.js';
import { walkPath } from '../../src/drivers/json-path.js';
import { decodeWords, encodeWords, encodeRegisterWrite, wordCount, exceptionName, registerLabel } from '../../src/drivers/modbus-codec.js';
import { normalizeValue, extractValue } from '../../src/drivers/mqtt-bridge.js';
import { defineDriver, validateDriverDefinition, DriverError, apiVersion } from '../../src/drivers/api.js';

test('topicMatches: exact, +, # (incl. the parent level), and $-topics', () => {
  const yes = [
    ['tele/plug1/SENSOR', 'tele/plug1/SENSOR'],
    ['tele/+/SENSOR', 'tele/plug1/SENSOR'],
    ['tele/#', 'tele/plug1/SENSOR'],
    ['tele/#', 'tele'], // '#' also matches the parent level
    ['#', 'a/b/c'],
    ['+/+', '/finance'], // an empty level is still a level
    ['+', 'a'],
    ['$SYS/#', '$SYS/broker/load'], // an explicit $ prefix matches
    ['a//b', 'a//b'],
  ];
  for (const [f, t] of yes) assert.equal(topicMatches(f, t), true, `${f} should match ${t}`);
  const no = [
    ['tele/+/SENSOR', 'tele/plug1/STATE'],
    ['tele/+', 'tele/plug1/SENSOR'],
    ['tele/+/SENSOR', 'tele/SENSOR'],
    ['a/b', 'a/b/c'],
    ['a/b/c', 'a/b'],
    ['#', '$SYS/broker/load'], // wildcards never reach $-topics from the first level
    ['+/broker/load', '$SYS/broker/load'],
    ['A', 'a'], // case-sensitive
    ['a', 'a/+'], // wildcards are illegal in topic names
  ];
  for (const [f, t] of no) assert.equal(topicMatches(f, t), false, `${f} should not match ${t}`);
});

test('filterError: valid filters pass; misplaced wildcards and empty filters are named', () => {
  for (const f of ['a', 'a/+/c', 'a/#', '#', '+', '/', 'a//b']) assert.equal(filterError(f), null, f);
  for (const f of ['', 'a/#/b', 'a#', 'a/b#', 'a+', 'a/+b/c', '##']) assert.equal(typeof filterError(f), 'string', f);
});

test('walkPath: dot paths, numeric segments index arrays, missing → undefined', () => {
  const doc = { ENERGY: { Power: 42.5, Today: 0 }, list: [{ t: 1 }, { t: 2.5 }], flag: false, nothing: null, s: 'abc' };
  assert.equal(walkPath(doc, 'ENERGY.Power'), 42.5);
  assert.equal(walkPath(doc, 'ENERGY.Today'), 0);
  assert.equal(walkPath(doc, 'list.1.t'), 2.5);
  assert.deepEqual(walkPath(doc, 'list.0'), { t: 1 });
  assert.equal(walkPath(doc, 'list.2.t'), undefined);
  assert.equal(walkPath(doc, 'flag'), false);
  assert.equal(walkPath(doc, 'nothing'), null);
  assert.equal(walkPath(doc, 'nothing.deeper'), undefined);
  assert.equal(walkPath(doc, 'ENERGY.Power.x'), undefined);
  assert.equal(walkPath(doc, 'list.length'), 2); // same answer the platform's walker gives
  assert.equal(walkPath([10, 20], '1'), 20);
  assert.equal(walkPath(doc, 'missing'), undefined);
  assert.equal(walkPath(doc, 's.0'), undefined, 'strings are not indexed');
});

test('walkPath: the bracket form is the same path', () => {
  const doc = { list: [{ t: 1 }, { t: 2.5 }], grid: [[1, 2], [3, 4]] };
  assert.equal(walkPath(doc, 'list[1].t'), 2.5);
  assert.equal(walkPath(doc, 'grid[1][0]'), 3);
  assert.equal(walkPath([{ a: 7 }], '[0].a'), 7);
  assert.equal(walkPath(doc, 'list[9].t'), undefined);
  assert.equal(walkPath({ a: { b: 1 } }, 'a[__proto__]'), undefined, 'only digits inside brackets are rewritten');
});

test('walkPath: prototype keys are never traversed', () => {
  const parsed = JSON.parse('{"__proto__":{"polluted":1},"a":{"constructor":{"prototype":7}}}');
  assert.equal(walkPath(parsed, '__proto__'), undefined);
  assert.equal(walkPath(parsed, '__proto__.polluted'), undefined);
  assert.equal(walkPath(parsed, 'a.constructor'), undefined);
  assert.equal(walkPath(parsed, 'a.constructor.prototype'), undefined);
  assert.equal(walkPath({}, 'constructor'), undefined);
  assert.equal(walkPath({}, 'toString'), undefined, 'inherited properties are not own');
  assert.equal(walkPath({}, 'hasOwnProperty'), undefined);
  assert.equal(({}).polluted, undefined);
});

test('decodeWords: every format, both word orders (230.5 = 0x4366 0x8000)', () => {
  assert.equal(decodeWords(0xfffe, 0, 'u16', 'big'), 65534);
  assert.equal(decodeWords(0xfffe, 0, 's16', 'big'), -2);
  assert.equal(decodeWords(0x7fff, 0, 's16', 'big'), 32767);
  assert.equal(decodeWords(0x0001, 0x0002, 'u32', 'big'), 65538);
  assert.equal(decodeWords(0x0002, 0x0001, 'u32', 'little'), 65538);
  assert.equal(decodeWords(0xffff, 0xffff, 'u32', 'big'), 4294967295, 'exact, not float-rounded');
  assert.equal(decodeWords(0xffff, 0xfffe, 's32', 'big'), -2);
  assert.equal(decodeWords(0xfffe, 0xffff, 's32', 'little'), -2);
  assert.equal(decodeWords(0x4366, 0x8000, 'f32', 'big'), 230.5);
  assert.equal(decodeWords(0x8000, 0x4366, 'f32', 'little'), 230.5);
  assert.equal(decodeWords(0x3dcc, 0xcccd, 'f32', 'big'), 0.1, 'float32 noise trimmed to 7 significant digits');
  assert.equal(decodeWords(0x7fc0, 0x0000, 'f32', 'big'), undefined, 'NaN');
  assert.equal(decodeWords(0x7f80, 0x0000, 'f32', 'big'), undefined, '+Infinity');
  assert.equal(decodeWords(0xff80, 0x0000, 'f32', 'big'), undefined, '-Infinity');
  assert.equal(decodeWords(0x1234, 0x5678, 'bogus', 'big'), 0x1234, 'unknown format decodes as u16 (firmware parity)');
  assert.equal(decodeWords(0x0001, 0x0002, 'u32', 'weird'), 65538, 'unknown word order is big');
  assert.equal(wordCount('f32'), 2);
  assert.equal(wordCount('s16'), 1);
});

test('encodeWords is the inverse of decodeWords', () => {
  for (const [v, fmt] of [[230.5, 'f32'], [-2, 's32'], [4000000000, 'u32'], [-12.25, 'f32']]) {
    for (const order of ['big', 'little']) {
      const [w0, w1] = encodeWords(v, fmt, order);
      assert.equal(decodeWords(w0, w1, fmt, order), v, `${v} ${fmt} ${order}`);
    }
  }
  assert.deepEqual(encodeWords(230.5, 'f32', 'big'), [0x4366, 0x8000]);
});

test('encodeRegisterWrite: -32768..65535 integers, negatives as two\'s complement', () => {
  assert.deepEqual(encodeRegisterWrite(0), { ok: true, word: 0 });
  assert.deepEqual(encodeRegisterWrite(65535), { ok: true, word: 65535 });
  assert.deepEqual(encodeRegisterWrite(-1), { ok: true, word: 65535 });
  assert.deepEqual(encodeRegisterWrite(-32768), { ok: true, word: 32768 });
  for (const bad of [65536, -32769, 1.5, NaN, '5', null]) assert.equal(encodeRegisterWrite(bad).ok, false, String(bad));
});

test('exception names and register labels', () => {
  assert.equal(exceptionName(2), 'illegal data address');
  assert.equal(exceptionName(99), 'unknown exception');
  assert.equal(registerLabel('holding', 40), 'hr40');
  assert.equal(registerLabel('input', 0), 'ir0');
  assert.equal(registerLabel('coil', 3), 'co3');
  assert.equal(registerLabel('discrete', 7), 'di7');
});

test('normalizeValue: booleans and ON/OFF → 1/0, numeric strings → numbers, junk skipped', () => {
  assert.equal(normalizeValue(true), 1);
  assert.equal(normalizeValue(false), 0);
  for (const s of ['ON', 'on', 'On', 'true', 'TRUE', ' on ']) assert.equal(normalizeValue(s), 1, s);
  for (const s of ['OFF', 'off', 'false', 'False']) assert.equal(normalizeValue(s), 0, s);
  assert.equal(normalizeValue('42.5'), 42.5);
  assert.equal(normalizeValue('-3'), -3);
  assert.equal(normalizeValue('1e3'), 1000);
  assert.equal(normalizeValue(' 7 '), 7);
  assert.equal(normalizeValue('0x10'), '0x10', 'hex is not a numeric string');
  assert.equal(normalizeValue('idle'), 'idle');
  assert.equal(normalizeValue('x'.repeat(300)).length, 256);
  assert.equal(normalizeValue(''), undefined);
  assert.equal(normalizeValue('1e999'), undefined);
  for (const junk of [null, undefined, {}, [], [1], NaN, Infinity]) assert.equal(normalizeValue(junk), undefined, String(junk));
});

test('extractValue: whole-payload vs JSON path', () => {
  const p = (t) => {
    try {
      return { ok: true, value: JSON.parse(t) };
    } catch {
      return { ok: false };
    }
  };
  const x = (t, path) => extractValue(t, p(t), path);
  assert.deepEqual(x('ON', ''), { value: 1 });
  assert.deepEqual(x('21.5', ''), { value: 21.5 });
  assert.deepEqual(x('"idle"', ''), { value: 'idle' });
  assert.deepEqual(x('{"a":1}', ''), { skip: 'object-without-path' });
  assert.deepEqual(x('[1,2]', ''), { skip: 'object-without-path' });
  assert.deepEqual(x('null', ''), { skip: 'unusable' });
  assert.deepEqual(x('{"ENERGY":{"Power":42.5}}', 'ENERGY.Power'), { value: 42.5 });
  assert.deepEqual(x('{"ENERGY":{"Power":42.5}}', 'ENERGY.Voltage'), { skip: 'path-missing' });
  assert.deepEqual(x('{"ENERGY":{"Power":42.5}}', 'ENERGY'), { skip: 'unusable' });
  assert.deepEqual(x('ON', 'POWER'), { skip: 'not-json' });
  assert.deepEqual(x('{"POWER":"ON"}', 'POWER'), { value: 1 });
});

test('defineDriver validates, freezes, and refuses other API versions', () => {
  const def = defineDriver({ apiVersion: 1, name: 'x', protocols: ['http'], create: () => ({}) });
  assert.equal(Object.isFrozen(def), true);
  assert.equal(Object.isFrozen(def.protocols), true);
  assert.equal(apiVersion, 1);
  assert.throws(() => defineDriver({ apiVersion: 2, name: 'x', protocols: ['http'], create() {} }), (e) => e instanceof DriverError && /apiVersion must be 1/.test(e.message));
  assert.deepEqual(validateDriverDefinition({ apiVersion: 1, name: 'x', protocols: ['a'], create() {} }), []);
  const problems = validateDriverDefinition({ apiVersion: 1, name: '', protocols: ['a', 'a', ''], create: 5, capabilities: { modbusFormats: 'yes', sensorModels: { i2c: 'BME280' } } });
  assert.equal(problems.length, 6, problems.join('\n'));
  assert.equal(validateDriverDefinition(null).length, 1);
  const e = new DriverError('boom', { reason: 'modbus/timeout', code: 'timeout' });
  assert.equal(e.reason, 'modbus/timeout');
  assert.equal(e.code, 'timeout');
  assert.equal(new DriverError('plain').reason, 'plain');
});
