import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pidReused, processStart, startTicksFromStat } from '../../src/core/process-start.js';

const known = process.platform !== 'win32';
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

test('processStart: one answer per process, every time; Windows has none', () => {
  const a = processStart(process.pid);
  if (!known) { assert.equal(a, null); return; }
  assert.ok(a, 'this process has a start record');
  assert.equal(a.kind, process.platform === 'linux' ? 'linux' : 'ps');
  assert.deepEqual(processStart(process.pid), a);
  // pid 1 started long before this test: a different process, a different record.
  assert.notDeepEqual(processStart(1), a);
});

test('processStart: null for an exited pid and for anything that is not a pid', () => {
  assert.equal(processStart(deadPid()), null);
  for (const pid of [0, -1, 1.5, NaN, '7', null, undefined]) assert.equal(processStart(/** @type {any} */ (pid)), null, String(pid));
});

test('startTicksFromStat: field 22, counted from the last ")" because the command name may contain spaces and parentheses', () => {
  const tail = 'S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 1000 5 18446744073709551615';
  assert.equal(startTicksFromStat(`1234 (node) ${tail}`), '98765');
  assert.equal(startTicksFromStat(`1234 (we ird) (x)) ${tail}`), '98765');
  assert.equal(startTicksFromStat(`1234 (node)\n${tail}\n`), '98765');
  assert.equal(startTicksFromStat('1234 (node) S 1 2 3'), null, 'truncated');
  assert.equal(startTicksFromStat(`1234 node ${tail}`), null, 'no command name');
  assert.equal(startTicksFromStat(''), null);
});

test('pidReused: only a record of the same kind that differs proves the pid is someone else\'s now', () => {
  const linux = (ticks, boot = 'b-1') => () => ({ kind: 'linux', boot, ticks });
  assert.equal(pidReused(7, { kind: 'linux', boot: 'b-1', ticks: '500' }, linux('500')), false, 'same process');
  assert.equal(pidReused(7, { kind: 'linux', boot: 'b-1', ticks: '500' }, linux('9000')), true, 'restarted container: same pid, later start');
  assert.equal(pidReused(7, { kind: 'linux', boot: 'b-0', ticks: '500' }, linux('500')), true, 'a reboot that repeated the pid and the tick');
  assert.equal(pidReused(7, { kind: 'linux', boot: null, ticks: '500' }, linux('500')), false, 'no boot id on one side: the ticks decide');
  assert.equal(pidReused(7, { kind: 'linux', boot: null, ticks: '500' }, linux('501', null)), true);
  const ps = (lstart) => () => ({ kind: 'ps', lstart });
  assert.equal(pidReused(7, { kind: 'ps', lstart: 'Sun Oct 4 10:05:55 2026' }, ps('Sun Oct 4 10:05:55 2026')), false);
  assert.equal(pidReused(7, { kind: 'ps', lstart: 'Sun Oct 4 10:05:55 2026' }, ps('Sun Oct 4 11:00:00 2026')), true);
  // Not provable → false, and the caller's pid check stands (a live holder must never be called dead).
  for (const recorded of [undefined, null, 'junk', 42, {}, { kind: 'linux' }, { kind: 'linux', ticks: 500 }, { kind: 'ps' }, { kind: 'from-a-later-version', ticks: '1' }]) {
    assert.equal(pidReused(7, recorded, linux('9000')), false, JSON.stringify(recorded));
  }
  assert.equal(pidReused(7, { kind: 'linux', boot: 'b-1', ticks: '500' }, () => null), false, 'the start of the pid cannot be read');
  assert.equal(pidReused(7, { kind: 'ps', lstart: 'x' }, linux('9000')), false, 'records of another kind are not compared');
});
