// C08 — a push of the bytes the gateway already runs changes nothing, but is still confirmed.
import { configPayload, device, deviceId } from '../fixtures.js';
import { fnv1a32 } from '../protocol.js';
import { short } from '../harness.js';

export const id = 'C08';
export const title = 'Unprompted push with identical bytes → no rebuild, still re-requests (and gets "unchanged")';
export const level = 'core';

export default async function run(h) {
  const payload = configPayload([device(2, { tickDuration: 10_000 }), device(3, { tickDuration: 10_000, tags: [{ name: 'rpm' }] })]);
  const env = await h.env({ cloudConfig: payload });
  await env.start();
  h.check('first-sync', await env.waitSynced(60_000), 'initial config synced');
  await env.advance(30_000);
  const opens = env.controls.opens.length;
  const closes = env.controls.closes.length;
  const t0 = env.now();
  env.cloud.pushConfig(env.tenant, env.gatewayId);
  await env.advance(30_000);
  const req = env.configRequests().find((r) => r.arrivedAt > t0);
  h.check('re-request', req && req.body.hash === fnv1a32(payload), `an identical push is still answered with config/request {hash} (got ${short(req && req.body) || 'none'})`);
  h.check('unchanged', env.g.configPushes.some((p) => p.at > t0 && p.kind === 'unchanged'), 'the platform replies "unchanged"');
  h.check('no-rebuild', env.controls.opens.length === opens && env.controls.closes.length === closes, `no device is closed or reopened (opens +${env.controls.opens.length - opens}, closes +${env.controls.closes.length - closes})`);
  h.check('busy-cleared', !env.cloud.busy(env.tenant, env.gatewayId) && env.cloud.configCurrent(env.tenant, env.gatewayId) === true, 'the platform shows the gateway current and not busy');
  h.check('still-running', env.data(deviceId(2)).some((d) => d.arrivedAt > t0 + 5_000), 'devices keep publishing');
}
