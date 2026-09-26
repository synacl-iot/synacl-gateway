// C03 — a restart runs the persisted config before it can reach the platform, then proves it is current.
import { configPayload, device, deviceId } from '../fixtures.js';
import { fnv1a32 } from '../protocol.js';
import { short } from '../harness.js';

export const id = 'C03';
export const title = 'Restart with a persisted config: devices run (and buffer) before connect; request carries the stored hash; unchanged → no re-apply';
export const level = 'core';

export default async function run(h) {
  const payload = configPayload([device(2, { tickDuration: 10_000, tags: [{ name: 'temperature' }, { name: 'humidity' }] })]);
  const hash = fnv1a32(payload);
  const env = await h.env({ cloudConfig: payload });
  await env.start();
  h.check('first-sync', await env.waitSynced(60_000), 'first boot reaches configCurrent');

  // Second process on the same disk, with the broker unreachable at first.
  await env.stop();
  const readsBefore = env.controls.readsOf(deviceId(2)).length;
  const opensBefore = env.controls.opensOf(deviceId(2));
  const upBefore = env.cloud.uplinks.length;
  env.broker.setNetwork(false);
  await env.start();
  await env.advance(35_000);
  const offlineReads = env.controls.readsOf(deviceId(2)).length - readsBefore;
  h.check('runs-offline', offlineReads >= 2, `devices start from the stored config before any connection (reads while offline: ${offlineReads})`);
  h.check('nothing-sent-offline', env.cloud.uplinks.length === upBefore, 'nothing reaches the platform while it is unreachable');
  const st = env.gw.status();
  h.check('buffers-offline', st && st.buffer && st.buffer.records >= 1, `readings taken offline go to the store-and-forward buffer (buffer: ${short(st && st.buffer)})`);

  env.broker.setNetwork(true);
  const sinceUp = env.cloud.uplinks.length;
  await env.until(() => env.cloud.uplinks.slice(sinceUp).some((u) => u.id === 'gateway.config-request'), 120_000);
  await env.advance(10_000);
  const req = env.cloud.uplinks.slice(sinceUp).find((u) => u.id === 'gateway.config-request');
  h.check('stored-hash', req && req.body && req.body.hash === hash, `the first request after restart carries the persisted hash ${hash} (got ${short(req && req.raw) || 'no request'})`);
  const pushesAfter = env.g.configPushes.filter((p) => p.at >= (req ? req.arrivedAt : Infinity));
  h.check('answered-unchanged', pushesAfter.length >= 1 && pushesAfter.every((p) => p.kind === 'unchanged'), `the platform answers "unchanged" and sends no full payload (got ${pushesAfter.map((p) => p.kind).join(', ') || 'nothing'})`);
  h.check('no-reapply', env.controls.opensOf(deviceId(2)) === opensBefore + 1, `"unchanged" must not re-open the device (opens this process: ${env.controls.opensOf(deviceId(2)) - opensBefore}, expected 1)`);
  h.check('current', env.cloud.configCurrent(env.tenant, env.gatewayId) === true, 'the platform shows configCurrent = true after the restart');
}
