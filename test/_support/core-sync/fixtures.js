// A deterministic stand-in for the host driver and a gateway config for lifecycle tests.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TENANT = '64b7a1000000000000000004';
export const GW = 'gw_3f2a9c1e7b41';
export const PREFIX = `tenants/${TENANT}/sources/gateway/${GW}`;
export const DEV = '66f1a2b3c4d5e6f708192a3b';

/** Serves `host`: every read returns cpu.load = 12.5 (and counts reads). */
export function fakeHostDriver() {
  const stats = { opened: 0, reads: 0, closed: 0 };
  const def = {
    apiVersion: 1,
    name: 'fake-host',
    protocols: ['host'],
    capabilities: {},
    create() {
      return {
        async open(device) { stats.opened++; return { id: device.id }; },
        async read(handle, tags) {
          stats.reads++;
          const values = {};
          for (const t of tags) values[t.name] = 12.5;
          return { values, reachable: true };
        },
        async close() { stats.closed++; },
      };
    },
  };
  return { def, stats };
}

/** One host device with one tag, 5 s interval. */
export function hostConfigBytes({ intervalMs = 5000, id = DEV } = {}) {
  return Buffer.from(JSON.stringify({
    devices: [{ _id: id, protocol: 'host', conn: { sampleIntervalMs: intervalMs }, tags: [{ name: 'cpu_load', metric: 'cpu.load' }] }],
    success: true,
  }));
}

export function gatewayConfig(brokerUrl, over = {}) {
  return {
    schema: 1,
    broker: brokerUrl,
    tenant: TENANT,
    gateway: GW,
    username: '123456',
    password: 'gw-secret-pw',
    api: null,
    tls: { caFile: null, rejectUnauthorized: true },
    drivers: [],
    driverDir: null,
    configCap: null,
    minIntervalMs: 1000,
    backfill: { maxBytes: 4 * 1024 * 1024, maxAgeHours: 168, batchIntervalMs: 1000 },
    host: { diskPath: '/' },
    bridge: { rejectUnauthorized: true },
    log: { level: 'debug', format: 'json' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function tempHome() {
  return mkdtempSync(join(tmpdir(), 'sgw-home-'));
}
