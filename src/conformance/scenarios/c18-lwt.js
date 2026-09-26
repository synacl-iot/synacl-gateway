// C18 — the Last Will tells the platform about an ungraceful loss; a graceful shutdown says
// goodbye itself and leaves no will behind.
import { configPayload, device, deviceId } from '../fixtures.js';
import { short } from '../harness.js';

export const id = 'C18';
export const title = 'Ungraceful drop → Last Will {"online":false} (retained); graceful shutdown → online:false published before DISCONNECT, no will';
export const level = 'core';

export default async function run(h) {
  const env = await h.env({ cloudConfig: configPayload([device(deviceId(2), { tickDuration: 10_000 })]) });
  const { tenant, gatewayId } = env;
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced');
  await env.advance(30_000);
  h.check('device-online', env.cloud.deviceOnline(tenant, gatewayId, deviceId(2)), 'the device is online before the drop');

  let t = env.now();
  env.broker.drop(gatewayId);
  await env.advance(500);
  const will = env.cloud.up('gateway.status').find((u) => u.arrivedAt >= t && u.lwt);
  h.check('lwt', will && will.raw.toString('utf8') === '{"online":false}' && will.retain === true && will.qos === 1, `an ungraceful drop publishes the will exactly {"online":false}, retained, QoS 1 (got ${short(will && will.raw) || 'nothing'})`);
  h.check('lwt-effect', !env.cloud.gatewayOnline(tenant, gatewayId) && !env.cloud.deviceOnline(tenant, gatewayId, deviceId(2)), 'the platform shows the gateway and its devices offline');

  h.check('reconnects', await env.until(() => env.cloud.gatewayOnline(tenant, gatewayId), 60_000), 'the gateway reconnects on its own');
  await env.waitSynced(30_000);
  await env.advance(10_000);

  t = env.now();
  const willsBefore = env.broker.stats.wills;
  await env.stop();
  await env.advance(2_000);
  const after = env.cloud.uplinks.filter((u) => u.arrivedAt >= t);
  const bye = after.find((u) => u.id === 'gateway.status' && u.body && u.body.online === false);
  const end = env.transport.endCalls[env.transport.endCalls.length - 1];
  h.check('goodbye', bye && !bye.lwt && bye.retain === true, `graceful shutdown publishes {"online":false} itself, retained (got ${short(bye && bye.raw) || 'nothing'})`);
  h.check('goodbye-first', bye && end && bye.publishedAt <= end.at && end.graceful === true, 'the goodbye is published before a graceful DISCONNECT');
  h.check('no-will', env.broker.stats.wills === willsBefore && !after.some((u) => u.lwt), 'no last will is published after a graceful shutdown');
  h.check('offline', !env.cloud.gatewayOnline(tenant, gatewayId), 'the platform shows the gateway offline');
}
