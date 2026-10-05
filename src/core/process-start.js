// When a process started, as the kernel records it — what tells the process that wrote run.lock
// apart from a later, unrelated one that was handed the same pid. A restarted container's pid
// namespace starts over, so the old gateway's pid (1, or 7 under `--init`) is reused at once;
// a reboot does the same on a Pi. kill(pid, 0) cannot see the difference; the start time can.
//
// Why a start time, and not the alternatives:
//   - /proc/<pid>/cmdline: after a container restart the reused pid is very often the NEW
//     gateway, with the same command line — the case this exists for.
//   - a lock the live process holds (flock): Node has no file locking without a native addon.
//   - a socket the live process listens on: socket files do not work on every volume (Docker
//     Desktop bind mounts, NFS, SMB), paths are capped near 104 bytes, and a gateway that
//     predates it would read as dead — a takeover of a live lock, i.e. two gateways.
// A start record is plain file reads on Linux (Alpine, busybox and distroless images ship no
// usable `ps`, and every container has /proc) and one `ps` on macOS/BSD, and a lock without
// one (written by 0.1.0) degrades to the pid check that was there before.
//
// Records are compared, never interpreted:
//   linux  {kind: 'linux', boot, ticks}  /proc/<pid>/stat field 22 (clock ticks after boot) and
//                                        the boot id, which tells a reboot that repeats a
//                                        pid and its start tick apart.
//   other  {kind: 'ps', lstart}          `ps -o lstart=`, one-second resolution — pids there
//                                        cycle through 99 999 before one is reused.
//   win32  null                          nothing cheap to ask; the pid check alone applies.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** @typedef {{kind: 'linux', boot: string|null, ticks: string} | {kind: 'ps', lstart: string}} ProcessStart */

const PS_TIMEOUT_MS = 2000;

/** undefined = not read yet. It changes only with a reboot, which also ends this process. */
let bootId;

/**
 * @param {number} pid
 * @returns {ProcessStart | null}  null when it cannot be known: no such process, not visible
 *   to this user (/proc mounted with hidepid), no `ps`, or Windows.
 */
export function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux' || process.platform === 'android') {
    let stat;
    try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
    const ticks = startTicksFromStat(stat);
    return ticks === null ? null : { kind: 'linux', boot: readBootId(), ticks };
  }
  if (process.platform === 'win32') return null;
  // A fixed locale and time zone: the service and the person running `status` can have
  // different ones, and the two strings are compared as text. An absolute path, so a `ps`
  // earlier on PATH is never what decides whether a gateway is running.
  const res = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8', timeout: PS_TIMEOUT_MS, env: { LC_ALL: 'C', TZ: 'UTC' },
  });
  const lstart = res.status === 0 ? String(res.stdout).trim().replace(/\s+/g, ' ') : '';
  return lstart ? { kind: 'ps', lstart } : null;
}

/**
 * Field 22 (starttime) of a /proc/<pid>/stat line, as a digit string. Field 2 is the command
 * name in parentheses, and it may itself contain spaces and ')', so fields are counted from
 * the last ')'.
 * @param {string} stat
 * @returns {string | null}
 */
export function startTicksFromStat(stat) {
  const close = String(stat).lastIndexOf(')');
  if (close < 0) return null;
  const fields = String(stat).slice(close + 1).trim().split(/\s+/); // fields[0] is field 3
  const ticks = fields[19];
  return /^\d+$/.test(ticks ?? '') ? ticks : null;
}

/**
 * True only when it is certain that `pid` is no longer the process that left `recorded`: both
 * records exist, are of the same kind, and differ. Anything less answers false, so the caller's
 * pid check decides as before — calling a live holder dead would let a second gateway take
 * its lock, which is worse than a stale "running".
 * @param {number} pid
 * @param {unknown} recorded
 * @param {(pid: number) => ProcessStart | null} [probe]
 */
export function pidReused(pid, recorded, probe = processStart) {
  if (!recorded || typeof recorded !== 'object') return false;
  const r = /** @type {Record<string, unknown>} */ (recorded);
  const now = probe(pid);
  if (!now || now.kind !== r.kind) return false;
  if (now.kind === 'linux') {
    if (typeof r.ticks !== 'string') return false;
    if (now.boot && typeof r.boot === 'string' && r.boot && now.boot !== r.boot) return true;
    return now.ticks !== r.ticks;
  }
  return typeof r.lstart === 'string' && now.lstart !== r.lstart;
}

function readBootId() {
  if (bootId === undefined) {
    try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { bootId = null; }
  }
  return bootId;
}
