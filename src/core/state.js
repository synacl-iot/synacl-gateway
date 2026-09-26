// Per-gateway state directory: the applied config bytes, runtime overrides, seq counters, the
// runtime snapshot `status` reads, and the single-instance lock.
//
//   <home>/state/<gateway-sanitised>-<sha256(tenant/gateway) first 8 hex>/
//
// The hash keys the directory to the identity, so re-running `init` for another gateway never
// replays the old gateway's config or buffer under the new id. Nothing is created until the
// first write or lock(): read-only callers (`status`) must not leave directories behind.
// Every file is written atomically (tmp + fsync + rename) with mode 0600 — config.raw can hold
// local-broker passwords — and directories are 0700.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { fnv1a32 } from './fnv.js';

/** @typedef {import('./types.js').Clock} Clock */
/** @typedef {import('./types.js').Logger} Logger */

/** Thrown by lock() while another live process holds this gateway's lock (CLI exit code 6). */
export class LockHeldError extends Error {
  /** @param {{pid: number, startedAt: number, hostname: string}} holder @param {string} lockFile */
  constructor(holder, lockFile) {
    super(`another synacl-gateway (pid ${holder.pid} on ${holder.hostname}) is running for this gateway`);
    this.name = 'LockHeldError';
    this.code = 'ELOCKED';
    this.holder = holder;
    this.lockFile = lockFile;
  }
}

/** Same rule for every caller: characters outside [A-Za-z0-9_.-] (e.g. ':' on Windows) → '_'. */
export function stateDirFor({ home, tenant, gateway }) {
  const sanitised = String(gateway).replace(/[^A-Za-z0-9_.-]/g, '_');
  const digest = createHash('sha256').update(`${tenant}/${gateway}`).digest('hex').slice(0, 8);
  return join(home, 'state', `${sanitised}-${digest}`);
}

/** kill(pid, 0): ESRCH = gone; EPERM = alive but not ours. */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Write `data` to `file` so that a crash leaves either the old or the new content, never half. */
export function atomicWrite(file, data, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readBytes(file) {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

const EMPTY_OVERRIDES = () => ({ v: 1, devices: {} });

/** Lock files held by this process — two gateways with one identity in one process are refused too. */
const HELD = new Set();

/**
 * @param {{home: string, tenant: string, gateway: string, clock?: Clock, log?: Logger}} opts
 */
export function openState({ home, tenant, gateway, clock, log }) {
  const dir = stateDirFor({ home, tenant, gateway });
  const f = {
    raw: join(dir, 'config.raw'),
    meta: join(dir, 'config.meta.json'),
    overrides: join(dir, 'overrides.json'),
    seq: join(dir, 'seq.json'),
    runtime: join(dir, 'runtime.json'),
    lock: join(dir, 'run.lock'),
  };
  const now = () => (clock ? clock.now() : Date.now());
  let held = false;

  function ensureDir() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask and ignored for a dir that already exists.
    try { chmodSync(dir, 0o700); } catch { /* not ours to fix (e.g. a read-only mount) */ }
  }

  function write(file, data) {
    ensureDir();
    atomicWrite(file, data);
  }

  function readHolder() {
    const h = readJson(f.lock);
    return h && typeof h === 'object' && Number.isInteger(h.pid) ? h : null;
  }

  function holderAlive(h) {
    // Another host (a shared volume, or Docker re-creating the container with a new hostname)
    // cannot be probed by pid, and treating it as live would crash-loop the new container. A
    // lock carrying our own pid that this process does not hold (HELD) is left over from an
    // earlier life of this pid — containers restart as pid 1.
    if (h.hostname !== osHostname()) return false;
    if (h.pid === process.pid) return HELD.has(f.lock);
    return isPidAlive(h.pid);
  }

  return {
    dir,
    backfillDir: join(dir, 'backfill'),

    /** @throws {LockHeldError} */
    lock() {
      if (held) return;
      ensureDir();
      const body = JSON.stringify({ pid: process.pid, startedAt: now(), hostname: osHostname() });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fd = openSync(f.lock, 'wx', 0o600);
          try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
          held = true;
          HELD.add(f.lock);
          return;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          const h = readHolder();
          if (h && holderAlive(h)) throw new LockHeldError(h, f.lock);
          if (h && h.hostname !== osHostname()) {
            log?.warn('taking over a lock left by another host', { pid: h.pid, hostname: h.hostname });
          }
          rmSync(f.lock, { force: true });
        }
      }
      const h = readHolder() ?? { pid: -1, startedAt: 0, hostname: '?' };
      throw new LockHeldError(h, f.lock);
    },

    unlock() {
      if (!held) return;
      held = false;
      HELD.delete(f.lock);
      // Only remove a lock that is still ours.
      const h = readHolder();
      if (h && h.pid === process.pid && h.hostname === osHostname()) {
        try { unlinkSync(f.lock); } catch { /* already gone */ }
      }
    },

    /** @returns {{pid: number, startedAt: number, hostname: string, alive: boolean} | null} */
    lockHolder() {
      const h = readHolder();
      if (!h) return null;
      return { pid: h.pid, startedAt: h.startedAt, hostname: h.hostname, alive: held || holderAlive(h) };
    },

    /**
     * The last applied config, re-hashed. A meta/bytes mismatch (a torn write, a hand edit)
     * returns null; while this process holds the lock it also discards both files, so the next
     * config/request carries hash 0 and gets the full payload. Without the lock it never
     * deletes: another process (`status`, `doctor`) may be reading between the running
     * gateway's two writes.
     * @returns {{bytes: Buffer, meta: Object} | null}
     */
    readConfigRaw() {
      const bytes = readBytes(f.raw);
      const meta = readJson(f.meta);
      if (!bytes && !meta) return null;
      if (!bytes || !meta || meta.hash !== fnv1a32(bytes)) {
        if (held) {
          log?.warn('stored configuration failed its hash check; discarding it', { stored: meta?.hash ?? null });
          rmSync(f.meta, { force: true });
          rmSync(f.raw, { force: true });
        }
        return null;
      }
      return { bytes, meta };
    },

    /** config.meta.json as stored, unverified and never modified (for read-only callers). */
    readConfigMeta() {
      return readJson(f.meta);
    },

    /** Bytes first, meta second: a crash between the two leaves a mismatch that the next read discards. */
    writeConfigRaw(bytes, meta) {
      write(f.raw, bytes);
      write(f.meta, JSON.stringify(meta));
    },

    clearConfig() {
      rmSync(f.meta, { force: true });
      rmSync(f.raw, { force: true });
    },

    /** @returns {{v: 1, devices: Object<string, Object>}} */
    readOverrides() {
      const o = readJson(f.overrides);
      return o && typeof o === 'object' && o.devices && typeof o.devices === 'object' ? o : EMPTY_OVERRIDES();
    },

    writeOverrides(o) {
      write(f.overrides, JSON.stringify(o ?? EMPTY_OVERRIDES()));
    },

    /**
     * Per-device seq counters exactly as last saved. The loader (the scheduler) resumes at n+1000:
     * counters are saved only periodically and at shutdown, so after a crash the saved value
     * can be behind what was already published.
     * @returns {{v: 1, devices: Object<string, number>}}
     */
    readSeq() {
      const s = readJson(f.seq);
      const devices = {};
      if (s && s.devices && typeof s.devices === 'object') {
        for (const [id, n] of Object.entries(s.devices)) {
          if (Number.isInteger(n) && n >= 0) devices[id] = n;
        }
      }
      return { v: 1, devices };
    },

    writeSeq(s) {
      write(f.seq, JSON.stringify({ v: 1, devices: (s && s.devices) || {} }));
    },

    writeRuntime(r) {
      write(f.runtime, JSON.stringify(r));
    },

    /** @returns {Object|null} */
    readRuntime() {
      return readJson(f.runtime);
    },
  };
}
