// C09 — half an hour of steady running, judged the way the platform judges it: arrival gaps,
// the account's messages-per-second window, presence refreshes and the heartbeat.
import { configPayload, device, deviceId } from '../fixtures.js';
import { gaps, maxOf, minOf, short } from '../harness.js';

export const id = 'C09';
export const title = '6 devices, plan floor … 10 s, 30 simulated minutes with 0–400 ms jitter: 0 violations, account window respected, status ≤30 s, heartbeat 60 s';
export const level = 'core';

const MINUTES = 30;
const PROFILES = [
  { plan: 'free', intervals: [5_000, 5_000, 6_000, 7_500, 10_000, 10_000] },
  { plan: 's1', intervals: [1_000, 1_000, 2_000, 3_000, 5_000, 10_000] },
];

async function runProfile(h, { plan, intervals }) {
  const ids = intervals.map((_, i) => deviceId(0x20 + i));
  const payload = configPayload(intervals.map((ms, i) => device(ids[i], {
    tickDuration: ms,
    tags: [{ name: 'value_a' }, { name: 'value_b', registerType: 'input' }],
  })));
  const env = await h.env({ cloudConfig: payload, plan, jitterMs: 400, readJitterMs: 400, seed: plan === 'free' ? 11 : 12 });
  await env.start();
  h.check(`${plan}.sync`, await env.waitSynced(60_000), `${plan}: config synced`);
  const t0 = env.now();
  await env.advance(MINUTES * 60_000);
  const t1 = env.now();
  const rate = env.cloud.rate;
  const p = `${plan}.`;

  h.check(`${p}violations`, rate.violations() === 0, `${plan}: zero interval violations in ${MINUTES} min (got ${rate.violations()}; first: ${short(rate.decisions.find((d) => d.reason === 'interval'))})`);
  const drops = rate.drops();
  h.check(`${p}account-window`, !drops.tenant_rate, `${plan}: the account's messages-per-second window is never exceeded (tenant drops: ${drops.tenant_rate || 0})`);
  h.check(`${p}no-drops`, Object.keys(drops).length === 0, `${plan}: the platform accepted every live message (drops: ${short(drops)})`);

  let worstGap = 0;
  let worstDev = null;
  let shortest = Infinity;
  let shortDev = null;
  let fewest = Infinity;
  for (const [i, idv] of ids.entries()) {
    const g = env.cloud.maxPresenceGap(env.tenant, env.gatewayId, idv, t0, t1);
    if (g > worstGap) { worstGap = g; worstDev = idv; }
    const data = env.data(idv).filter((d) => d.arrivedAt >= t0 && d.body);
    const tsGap = minOf(gaps(data.map((d) => d.body.ts)));
    if (tsGap - intervals[i] < shortest) { shortest = tsGap - intervals[i]; shortDev = { id: idv, gap: tsGap, interval: intervals[i] }; }
    const ratio = data.length / ((t1 - t0) / intervals[i]);
    fewest = Math.min(fewest, ratio);
  }
  h.check(`${p}presence`, worstGap <= 31_000, `${plan}: every device's presence is refreshed at least every 30 s (worst gap ${worstGap} ms on ${worstDev})`);
  h.check(`${p}ts-spacing`, shortDev === null || shortDev.gap >= shortDev.interval, `${plan}: data timestamps of a device are at least one interval apart (tightest ${short(shortDev)})`);
  h.check(`${p}throughput`, fewest >= 0.95, `${plan}: each device publishes at its interval (lowest ratio of expected messages ${fewest.toFixed(3)})`);

  const beats = env.cloud.up('gateway.status').filter((u) => !u.lwt && u.body && u.body.online && u.arrivedAt >= t0).map((u) => u.arrivedAt);
  const bg = gaps(beats);
  h.check(`${p}heartbeat`, beats.length >= MINUTES - 1 && minOf(bg) >= 59_000 && maxOf(bg) <= 61_000, `${plan}: a heartbeat every 60 s (count ${beats.length}, gaps ${minOf(bg)}–${maxOf(bg)} ms)`);
  h.check(`${p}online`, env.cloud.gatewayOnline(env.tenant, env.gatewayId) && ids.every((idv) => env.cloud.deviceOnline(env.tenant, env.gatewayId, idv)), `${plan}: gateway and all devices are online at the end`);
  const ints = env.cloud.up('gateway.device-data').every((u) => u.body && Number.isInteger(u.body.ts));
  h.check(`${p}integer-ts`, ints, `${plan}: every data ts is integer epoch milliseconds`);
  await env.stop();
}

export default async function run(h) {
  for (const profile of PROFILES) await runProfile(h, profile);
}
