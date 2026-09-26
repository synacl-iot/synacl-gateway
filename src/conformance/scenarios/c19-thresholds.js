// C19 — local threshold alerts: evaluated in engineering units, edge-triggered, [0,0] = off,
// sentinel bounds work, and alert state resets on a band change and when the device drops out.
import { configPayload, device, deviceId } from '../fixtures.js';
import { short } from '../harness.js';

export const id = 'C19';
export const title = 'Thresholds: edges only, engineering units, [0,0] off, ±1e9 sentinels, reset on band change and on unreachable';
export const level = 'optional';

const DEV = deviceId(2);

function cfg(band1) {
  return configPayload([device(DEV, {
    tickDuration: 5_000,
    tags: [
      { name: 'oil_temp', thresholdStart: band1[0], thresholdEnd: band1[1] },
      { name: 'counter' },                                                        // [0,0] → no band
      { name: 'pressure_raw', scaleFactor: 0.1, offset: 5, thresholdStart: 10, thresholdEnd: 20 },
      { name: 'level', thresholdStart: -1_000_000_000, thresholdEnd: 50 },        // one-sided
    ],
  })]);
}

export default async function run(h) {
  const env = await h.env({ cloudConfig: cfg([10, 80]), plan: 'free' });
  const { tenant, gatewayId, controls } = env;
  const set = (tag, v) => controls.setValue(DEV, tag, v);
  set('oil_temp', 50); set('counter', 1e6); set('pressure_raw', 100); set('level', 10);
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced');
  await env.advance(20_000);
  const alerts = () => env.g.alerts.filter((a) => a.deviceId === DEV).map((a) => a.body);
  const of = (tag, since) => env.g.alerts.filter((a) => a.deviceId === DEV && a.body.tag === tag && a.at >= since).map((a) => a.body);
  h.check('quiet-in-band', alerts().length === 0, `no alerts while every value is inside its band (got ${short(alerts())})`);

  let t = env.now();
  set('oil_temp', 90);
  await env.advance(12_000);
  set('oil_temp', 95);
  await env.advance(12_000);
  const v1 = of('oil_temp', t);
  h.check('violation-once', v1.length === 1 && v1[0].code === 'THRESHOLD_VIOLATION' && v1[0].severity === 'warning' && v1[0].value === 90,
    `leaving the band raises ONE warning THRESHOLD_VIOLATION with the value, not one per reading (got ${short(v1)})`);
  t = env.now();
  set('oil_temp', 60);
  await env.advance(8_000);
  const c1 = of('oil_temp', t);
  h.check('cleared', c1.length === 1 && c1[0].code === 'THRESHOLD_CLEARED' && c1[0].severity === 'info', `returning inside raises one info THRESHOLD_CLEARED (got ${short(c1)})`);
  h.check('no-band-off', of('counter', 0).length === 0, 'a [0,0] band never alerts');

  t = env.now();
  set('pressure_raw', 200);   // 200 × 0.1 + 5 = 25 → above 20
  set('level', 60);           // above the one-sided 50
  await env.advance(8_000);
  const p = of('pressure_raw', t);
  h.check('engineering-units', p.length === 1 && p[0].code === 'THRESHOLD_VIOLATION' && p[0].value === 25, `the band is checked on raw × scaleFactor + offset (got ${short(p)})`);
  h.check('sentinel', of('level', t).length === 1, `a one-sided band with a ±1e9 sentinel works (got ${short(of('level', t))})`);
  const raw = env.data(DEV).filter((d) => d.arrivedAt >= t).map((d) => d.body.values.pressure_raw);
  h.check('raw-on-wire', raw.length > 0 && raw.every((v) => v === 200), `data carries the RAW value; scaling is the platform's job (got ${short(raw)})`);

  // Reset on band change: in alert at 95 → band widened (90 now inside) → no alert; narrowed again → a fresh violation.
  set('oil_temp', 95);
  await env.advance(8_000);
  t = env.now();
  env.cloud.setConfig(tenant, gatewayId, cfg([10, 100]));
  env.cloud.pushConfig(tenant, gatewayId);
  await env.advance(15_000);
  h.check('band-change-reset', of('oil_temp', t).filter((a) => a.code === 'THRESHOLD_CLEARED').length === 0, `a band change resets the tag's alert state instead of reporting a clear (got ${short(of('oil_temp', t))})`);
  t = env.now();
  env.cloud.setConfig(tenant, gatewayId, cfg([10, 80]));
  env.cloud.pushConfig(tenant, gatewayId);
  await env.advance(15_000);
  const v2 = of('oil_temp', t);
  h.check('band-change-new-violation', v2.length === 1 && v2[0].code === 'THRESHOLD_VIOLATION', `after the band changes back, the still-high value violates afresh (got ${short(v2)})`);

  // Reset on unreachable: the device drops out while in alert, then comes back still high.
  controls.fail(DEV, 'timeout');
  await env.advance(40_000);
  t = env.now();
  controls.recover(DEV);
  await env.advance(75_000);   // failure backoff can hold the next attempt for up to 60 s
  const v3 = of('oil_temp', t);
  h.check('unreachable-reset', v3.length === 1 && v3[0].code === 'THRESHOLD_VIOLATION', `after the device was unreachable its alert state is reset, so the still-high value violates again (got ${short(v3)})`);
  h.check('alerts-valid', env.cloud.up('gateway.device-alert').every((u) => u.valid), 'every alert is schema-valid');
}
