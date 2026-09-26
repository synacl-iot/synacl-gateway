// C10 — read/once: the reply is a data message carrying only that tag, published before the
// ack, and it must never cost the device an interval violation — including when it races a
// scheduled read of the same device.
import { configPayload, device, deviceId } from '../fixtures.js';
import { short } from '../harness.js';

export const id = 'C10';
export const title = 'read/once: tag-only data before the ack; correlationId echoed; races a scheduled tick with 0 violations; unknown tag → error ack; on-demand tags only on demand';
export const level = 'optional';

const DEV = deviceId(2);
const corr = (n) => `64b7a10000000000000c${String(n).padStart(4, '0')}`;

export default async function run(h) {
  const payload = configPayload([device(DEV, { tickDuration: 10_000, tags: [{ name: 'flow' }, { name: 'totalizer', isIntervalRead: false }] })]);
  const env = await h.env({ cloudConfig: payload, plan: 'free' });
  const { tenant, gatewayId } = env;
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced');
  await env.advance(30_000);

  const readOnce = async (tag, c) => {
    const t = env.now();
    const res = env.cloud.sendDeviceCmd(tenant, gatewayId, DEV, { command: 'read/once', tag, correlationId: c });
    await env.advance(8_000);
    const ack = env.cloud.ackFor(tenant, gatewayId, c);
    const data = env.data(DEV).filter((d) => d.arrivedAt > t);
    const ackUp = env.cloud.up('gateway.device-cmd-ack', DEV).find((u) => u.body && u.body.correlationId === c);
    return { res, ack, data, ackUp, t };
  };

  // 1. An on-demand tag, read once.
  const a = await readOnce('totalizer', corr(1));
  const reply = a.data.find((d) => d.body && 'totalizer' in d.body.values);
  h.check('reply-data', reply && Object.keys(reply.body.values).join() === 'totalizer', `the reply is a data message carrying ONLY the requested tag (got ${short(reply && reply.body) || 'no data with the tag'})`);
  h.check('ack-ok', a.ack && a.ack.body.status === 'ok' && a.ack.body.correlationId === corr(1) && typeof a.ack.body.value === 'number',
    `the ack echoes the correlationId with status ok and the value (got ${short(a.ack && a.ack.body) || 'no ack'})`);
  h.check('data-before-ack', reply && a.ackUp && reply.arrivedAt <= a.ackUp.arrivedAt && env.cloud.uplinks.indexOf(reply) < env.cloud.uplinks.indexOf(a.ackUp), 'the data message is published before the acknowledgement');
  const decision = env.cloud.dataLog.find((d) => reply && d.deviceId === DEV && d.at === reply.arrivedAt && 'totalizer' in d.body.values);
  h.check('exempt', decision && decision.accepted && decision.ephemeral === 'totalizer', `the platform accepted it under the read-once exemption (${short(decision && { accepted: decision.accepted, path: decision.path, ephemeral: decision.ephemeral })})`);

  // 2. An unknown tag → error ack, no data.
  await env.advance(2_000);
  const b = await readOnce('no_such_tag', corr(2));
  h.check('unknown-tag', b.ack && b.ack.body.status === 'error' && typeof b.ack.body.error === 'string' && b.ack.body.error.length > 0 && !b.data.some((d) => 'no_such_tag' in d.body.values),
    `an unknown tag is answered with an error ack and no data (got ${short(b.ack && b.ack.body) || 'no ack'})`);

  // 3. Races with the scheduled tick: arriving just before it is due, and while it is in flight.
  for (const [n, offset] of [[3, -40], [4, 12], [5, -2]]) {
    const sched = env.data(DEV).filter((d) => d.body && 'flow' in d.body.values && !('totalizer' in d.body.values));
    const last = sched[sched.length - 1];
    const due = last.body.ts + 10_000;   // ts is taken when the read starts
    // Commands take one network delay to arrive; aim the arrival at `due + offset`.
    let sendAt = due + offset - env.broker.config.latencyMs;
    while (sendAt <= env.now()) sendAt += 10_000;
    await env.advance(sendAt - env.now());
    const r = await readOnce('flow', corr(n));
    h.check(`race${n - 2}`, r.res.sent && r.ack && r.ack.body.status === 'ok', `read/once arriving ${offset} ms from a scheduled tick is acknowledged ok (got ${short(r.ack && r.ack.body) || 'no ack'})`);
    await env.advance(8_000);
  }

  await env.advance(60_000);
  const regular = env.data(DEV).filter((d) => d.body && !(Object.keys(d.body.values).length === 1 && 'totalizer' in d.body.values));
  h.check('on-demand-absent', regular.every((d) => !('totalizer' in d.body.values)), 'an isIntervalRead:false tag never appears in scheduled data');
  const v = env.cloud.rate.violations();
  h.check('no-violations', v === 0, `no interval violations from any read/once or race (got ${v}: ${short(env.cloud.rate.decisions.filter((d) => d.reason === 'interval'))})`);
  h.check('cadence-kept', env.data(DEV).filter((d) => d.arrivedAt > env.now() - 60_000).length >= 5, 'scheduled publishing continues at its interval afterwards');
}
