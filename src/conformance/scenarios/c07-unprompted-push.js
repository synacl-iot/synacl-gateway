// C07 — a config pushed unprompted (the user edited devices) is applied live, then confirmed.
import { configPayload, device, deviceId } from '../fixtures.js';
import { fnv1a32 } from '../protocol.js';
import { short } from '../harness.js';

export const id = 'C07';
export const title = 'Unprompted push while running → applied without reconnect, re-request sent, zero rate violations across the re-apply';
export const level = 'core';

export default async function run(h) {
  const before = configPayload([
    device(2, { tickDuration: 5_000, tags: [{ name: 'temperature' }] }),
    device(3, { tickDuration: 10_000, tags: [{ name: 'pressure' }] }),
  ]);
  const after = configPayload([
    device(2, { tickDuration: 5_000, tags: [{ name: 'temperature' }, { name: 'humidity' }] }),   // changed
    device(3, { tickDuration: 10_000, tags: [{ name: 'pressure' }] }),                           // unchanged
    device(4, { tickDuration: 7_500, tags: [{ name: 'flow' }] }),                                // added
  ]);
  const env = await h.env({ cloudConfig: before, plan: 'free' });
  await env.start();
  h.check('first-sync', await env.waitSynced(60_000), 'initial config synced');
  await env.advance(60_000);

  const connects = env.transport.connectCalls.length;
  const t0 = env.now();
  env.cloud.setConfig(env.tenant, env.gatewayId, after);
  env.cloud.pushConfig(env.tenant, env.gatewayId);
  await env.advance(5_000);
  const req = env.configRequests().find((r) => r.arrivedAt > t0);
  h.check('re-request', req && req.body.hash === fnv1a32(after) && req.arrivedAt - t0 <= 5_000, `after applying a pushed config the gateway re-requests with its hash ${fnv1a32(after)} (got ${short(req && req.body) || 'nothing within 5 s'})`);
  await env.advance(115_000);
  h.check('no-reconnect', env.transport.connectCalls.length === connects, 'the push is applied on the live connection');
  h.check('current', env.cloud.configCurrent(env.tenant, env.gatewayId) === true, 'the platform shows configCurrent = true');
  h.check('changed-device', env.data(deviceId(2)).filter((d) => d.arrivedAt > t0).some((d) => 'humidity' in d.body.values), 'the changed device publishes its new tag');
  h.check('added-device', env.data(deviceId(4)).length >= 3, `the added device runs (data messages: ${env.data(deviceId(4)).length})`);
  h.check('kept-handle', env.controls.opensOf(deviceId(3)) === 1, `an unchanged device keeps its driver handle (opens: ${env.controls.opensOf(deviceId(3))})`);
  const v = env.cloud.rate.violations();
  h.check('no-violations', v === 0, `zero interval violations across the re-apply (got ${v}; drops ${short(env.cloud.rate.drops())})`);
}
