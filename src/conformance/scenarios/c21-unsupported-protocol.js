// C21 — a device whose protocol no driver serves is reported unreachable with a reason, instead
// of silently doing nothing.
import { configPayload, device, deviceId } from '../fixtures.js';
import { short } from '../harness.js';

export const id = 'C21';
export const title = 'Unsupported-protocol device → retained status reachable:false with a reason; no data';
export const level = 'core';

export default async function run(h) {
  const DEV = deviceId(5);
  const env = await h.env({ cloudConfig: configPayload([device(DEV, { protocol: 'gpio-pwm', conn: { pinNumber: 25, sampleIntervalMs: 10_000 }, tags: [{ name: 'duty', gpioPin: 25 }] })]) });
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced');
  await env.advance(35_000);
  const st = env.cloud.up('gateway.device-status', DEV);
  const last = st[st.length - 1];
  h.check('status', last && last.body && last.body.reachable === false && typeof last.body.reason === 'string' && last.body.reason.length > 0 && last.retain,
    `the device is reported reachable:false with a reason, retained (got ${short(last && last.body) || 'no status'})`);
  h.check('names-protocol', last && last.body && /gpio-pwm/.test(last.body.reason || ''), `the reason names the unsupported protocol (got ${short(last && last.body && last.body.reason)})`);
  h.check('no-data', env.data(DEV).length === 0, 'no data is published for it');
  h.check('platform-view', !env.cloud.deviceOnline(env.tenant, env.gatewayId, DEV), 'the platform does not show it online');
}
