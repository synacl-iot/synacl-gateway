// C11 — set/interval: applied live, persisted across a restart, clamped to the local floor,
// and superseded by a config the platform sends afterwards.
import { configPayload, device, deviceId } from '../fixtures.js';
import { gaps, maxOf, minOf } from '../harness.js';

export const id = 'C11';
export const title = 'set/interval: new cadence, persisted across restart, clamped to the floor, superseded by a later config';
export const level = 'optional';

const DEV = deviceId(2);

export default async function run(h) {
  const env = await h.env({ cloudConfig: configPayload([device(DEV, { tickDuration: 10_000 })]), plan: 's2', fileConfig: { minIntervalMs: 1_000 } });
  const { tenant, gatewayId } = env;
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced');
  await env.advance(30_000);

  /** Device ts gaps of the data published inside [from, to]. */
  const cadence = (from, to = env.now()) => gaps(env.data(DEV).filter((d) => d.body && d.body.ts >= from && d.body.ts <= to).map((d) => d.body.ts));
  const within = (gs, want, tol) => gs.length >= 2 && minOf(gs) >= want && maxOf(gs) <= want + tol;

  env.cloud.sendDeviceCmd(tenant, gatewayId, DEV, { command: 'set/interval', interval: 20_000 });
  await env.advance(25_000);
  const t1 = env.now();
  await env.advance(100_000);
  const g1 = cadence(t1);
  h.check('applied', within(g1, 20_000, 250), `the new interval applies live (gaps ${minOf(g1)}–${maxOf(g1)} ms, want 20000)`);

  await env.stop();
  await env.start();
  await env.waitSynced(60_000);
  const t2 = env.now();
  await env.advance(100_000);
  const g2 = cadence(t2);
  h.check('persisted', within(g2, 20_000, 250), `the override survives a restart (gaps ${minOf(g2)}–${maxOf(g2)} ms, want 20000)`);

  env.cloud.sendDeviceCmd(tenant, gatewayId, DEV, { command: 'set/interval', interval: 300 });
  await env.advance(25_000);
  const t3 = env.now();
  await env.advance(20_000);
  const g3 = cadence(t3);
  h.check('clamped', within(g3, 1_000, 150), `an interval below the gateway's floor is raised to it (gaps ${minOf(g3)}–${maxOf(g3)} ms, floor 1000)`);

  env.cloud.setConfig(tenant, gatewayId, configPayload([device(DEV, { tickDuration: 15_000 })]));
  env.cloud.pushConfig(tenant, gatewayId);
  await env.advance(20_000);
  const t4 = env.now();
  await env.advance(100_000);
  const g4 = cadence(t4);
  h.check('superseded', within(g4, 15_000, 250), `a config applied after the override is authoritative (gaps ${minOf(g4)}–${maxOf(g4)} ms, want 15000)`);
  h.check('no-violations', env.cloud.rate.violations() === 0, `no interval violations while the cadence changed (got ${env.cloud.rate.violations()})`);
}
