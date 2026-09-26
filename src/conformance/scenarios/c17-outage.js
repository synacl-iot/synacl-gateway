// C17 — a 20-minute outage: nothing is queued while offline, reconnect causes no burst, and the
// buffer drains on data/backfill — paced, bounded, oldest first — until it is empty.
import { configPayload, device, deviceId } from '../fixtures.js';
import { gaps, maxOf, minOf, short } from '../harness.js';

export const id = 'C17';
export const title = '20-min outage → nothing live or queued offline; no burst on reconnect; backfill ≥10 s after reconnect, ≤40 records/≤3500 B, ≥1 s apart, oldest first, drained to 0';
export const level = 'optional';

const IDS = [deviceId(2), deviceId(3), deviceId(4)];
const INTERVALS = [5_000, 10_000, 10_000];

export default async function run(h) {
  const payload = configPayload(IDS.map((idv, i) => device(idv, { tickDuration: INTERVALS[i], tags: [{ name: 'value_a' }, { name: 'value_b' }, { name: 'value_c' }] })));
  const env = await h.env({ cloudConfig: payload, plan: 'free' });
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced');
  await env.advance(120_000);

  const down = env.now();
  env.broker.setNetwork(false);
  await env.advance(20 * 60_000);
  const offlineAttempts = env.broker.stats.offlinePublishAttempts;
  env.broker.setNetwork(true);
  const up = env.now();
  await env.until(() => env.cloud.uplinks.some((u) => u.arrivedAt > up && u.id === 'gateway.status' && u.body && u.body.online), 120_000);
  const reconnectedAt = env.cloud.uplinks.find((u) => u.arrivedAt > up && u.id === 'gateway.status' && u.body && u.body.online).publishedAt;
  await env.until(() => env.gw.status().buffer.records === 0 && env.cloud.backfillLog.length > 0, 10 * 60_000, 500);
  await env.advance(70_000);

  h.check('nothing-queued', offlineAttempts <= 2, `the gateway does not hand messages to the transport while offline (attempts: ${offlineAttempts})`);
  const liveFromOutage = env.cloud.up('gateway.device-data').filter((u) => u.body && u.body.ts > down + 1_000 && u.body.ts < up);
  h.check('no-live-replay', liveFromOutage.length === 0, `readings taken offline never go out on the live topic (got ${liveFromOutage.length}, e.g. ${short(liveFromOutage[0] && liveFromOutage[0].body)})`);
  h.check('no-violations', env.cloud.rate.violations() === 0, `reconnect causes no interval violations (got ${env.cloud.rate.violations()})`);
  const burst = env.broker.maxInWindow(1_000, (m) => m.arrivedAt >= up && /\/devices\/[^/]+\/data$/.test(m.topic));
  h.check('no-burst', burst <= IDS.length, `no burst of live data after reconnect (max ${burst} live data messages in any 1 s)`);

  const batches = env.cloud.up('gateway.data-backfill').filter((u) => u.arrivedAt >= up);
  h.check('backfill-sent', batches.length >= 1, `the buffered readings are replayed on data/backfill (${batches.length} batches)`);
  h.check('backfill-delay', batches.length && batches[0].publishedAt - reconnectedAt >= 9_900, `replay starts only after the connection has been stable for 10 s (started ${batches.length ? batches[0].publishedAt - reconnectedAt : '?'} ms after reconnect)`);
  const sizes = batches.map((b) => (b.body ? b.body.batch.length : 0));
  const bytes = batches.map((b) => b.raw.length);
  h.check('batch-bounds', maxOf(sizes) <= 40 && maxOf(bytes) <= 3_500, `each batch ≤40 records and ≤3500 bytes (max ${maxOf(sizes)} records, ${maxOf(bytes)} B)`);
  const pace = gaps(batches.map((b) => b.publishedAt));
  h.check('batch-pace', batches.length < 2 || minOf(pace) >= 1_000, `batches are at least 1 s apart (min gap ${minOf(pace)} ms)`);
  const records = batches.flatMap((b) => (b.body ? b.body.batch : []));
  const ordered = IDS.every((idv) => { const ts = records.filter((r) => r.deviceId === idv).map((r) => r.ts); return ts.every((x, i) => i === 0 || x >= ts[i - 1]); });
  h.check('oldest-first', ordered, 'records are replayed oldest first');
  const expected = INTERVALS.reduce((n, ms) => n + (up - down) / ms, 0);
  const covered = records.filter((r) => r.ts >= down && r.ts < up).length;
  h.check('complete', covered >= 0.9 * expected, `the outage is covered by replayed records (${covered} of ~${Math.round(expected)})`);
  const bf = env.cloud.backfillLog.filter((b) => b.at >= up);
  const refused = bf.reduce((n, b) => n + b.dropped, 0);
  h.check('within-ceiling', refused === 0, `the platform accepted every replayed record (refused ${refused})`);
  h.check('drained', env.gw.status().buffer.records === 0, `the buffer drains to 0 (left: ${env.gw.status().buffer.records})`);
  const beats = env.cloud.up('gateway.status').filter((u) => u.arrivedAt >= up && u.body && u.body.online);
  h.check('heartbeat-counters', beats.some((b) => (b.body.bufFlash || 0) + (b.body.bufRam || 0) > 0) && ((beats[beats.length - 1].body.bufFlash || 0) + (beats[beats.length - 1].body.bufRam || 0)) === 0,
    `heartbeats report the backlog and then its drain (bufFlash sequence ${short(beats.map((b) => b.body.bufFlash))})`);
}
