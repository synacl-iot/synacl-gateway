// C15 — firmware/request: a bare request re-sends the capability report; an update request is
// not something a software gateway performs, so it must not answer with OTA progress or restart.
import { short } from '../harness.js';

export const id = 'C15';
export const title = 'Bare firmware/request → capability report again; update request → nothing (no OTA progress, no restart)';
export const level = 'optional';

export default async function run(h) {
  const env = await h.env();
  const { tenant, gatewayId } = env;
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced');
  await env.advance(5_000);

  let t = env.now();
  env.cloud.sendFirmwareRequest(tenant, gatewayId, {});
  await env.advance(3_000);
  const caps = env.cloud.up('gateway.firmware-response').filter((u) => u.arrivedAt >= t);
  h.check('bare-caps', caps.length === 1 && caps[0].body && Array.isArray(caps[0].body.protocols) && caps[0].body.version, `a firmware/request without type is answered with one capability report (got ${short(caps.map((c) => c.body))})`);

  t = env.now();
  const connects = env.transport.connectCalls.length;
  env.cloud.sendFirmwareRequest(tenant, gatewayId, { type: 'update', version: '9.9.9' });
  await env.advance(30_000);
  const after = env.cloud.up('gateway.firmware-response').filter((u) => u.arrivedAt >= t);
  h.check('update-ignored', after.length === 0, `an update request produces no firmware/response (got ${short(after.map((c) => c.body))})`);
  h.check('update-no-restart', env.transport.connectCalls.length === connects && !env.cloud.up('gateway.status').some((u) => u.arrivedAt >= t && u.body && u.body.online === false), 'an update request does not restart or disconnect the gateway');
}
