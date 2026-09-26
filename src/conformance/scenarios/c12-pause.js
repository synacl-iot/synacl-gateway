// C12 — read/disable (manual / restart / timed) and read/enable: no data while paused, the
// device stays online, timed pauses end on their own, and only `manual` survives a restart.
import { configPayload, device, deviceId } from '../fixtures.js';

export const id = 'C12';
export const title = 'read/disable manual/restart/timed + read/enable: no data while paused, device stays online, timed auto-resumes, restart mode not persisted';
export const level = 'optional';

const DEV = deviceId(2);

export default async function run(h) {
  const env = await h.env({ cloudConfig: configPayload([device(DEV, { tickDuration: 5_000 })]), plan: 'free' });
  const { tenant, gatewayId } = env;
  const cmd = (body) => env.cloud.sendDeviceCmd(tenant, gatewayId, DEV, body);
  const dataIn = (from, to) => env.data(DEV).filter((d) => d.arrivedAt >= from && d.arrivedAt <= to);
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced');
  await env.advance(20_000);

  // manual
  cmd({ command: 'read/disable', mode: 'manual' });
  await env.advance(1_000);
  const m0 = env.now();
  await env.advance(60_000);
  h.check('manual-silent', dataIn(m0, env.now()).length === 0, `no data while paused (got ${dataIn(m0, env.now()).length})`);
  h.check('manual-online', env.cloud.deviceOnline(tenant, gatewayId, DEV) && env.cloud.maxPresenceGap(tenant, gatewayId, DEV, m0) <= 31_000, 'a paused device keeps reporting reachable, so it stays online');
  const e0 = env.now();
  cmd({ command: 'read/enable' });
  await env.advance(7_000);
  h.check('enable', dataIn(e0, env.now()).length >= 1, 'read/enable resumes publishing promptly');

  // timed
  await env.advance(10_000);
  cmd({ command: 'read/disable', mode: 'timed', durationMs: 20_000 });
  await env.advance(1_000);
  const t0 = env.now();
  await env.advance(18_000);
  h.check('timed-silent', dataIn(t0, env.now()).length === 0, 'no data during a timed pause');
  const t1 = env.now();
  await env.advance(10_000);
  h.check('timed-resumes', dataIn(t1, env.now()).length >= 1, 'a timed pause ends on its own');

  // manual survives a restart
  cmd({ command: 'read/disable', mode: 'manual' });
  await env.advance(2_000);
  await env.stop();
  await env.start();
  await env.waitSynced(60_000);
  const r0 = env.now();
  await env.advance(30_000);
  h.check('manual-persisted', dataIn(r0, env.now()).length === 0, 'a manual pause is still in force after a restart');
  cmd({ command: 'read/enable' });
  await env.advance(8_000);
  h.check('manual-enable-after-restart', dataIn(r0, env.now()).length >= 1, 'read/enable after the restart resumes it');

  // restart mode is not persisted
  cmd({ command: 'read/disable', mode: 'restart' });
  await env.advance(1_000);
  const s0 = env.now();
  await env.advance(20_000);
  h.check('restart-mode-silent', dataIn(s0, env.now()).length === 0, 'no data while paused until restart');
  await env.stop();
  await env.start();
  await env.waitSynced(60_000);
  const s1 = env.now();
  await env.advance(20_000);
  h.check('restart-mode-cleared', dataIn(s1, env.now()).length >= 1, 'a restart-mode pause ends with the restart');
  h.check('no-violations', env.cloud.rate.violations() === 0, `no interval violations around pauses and resumes (got ${env.cloud.rate.violations()})`);
}
