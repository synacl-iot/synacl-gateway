// C16 — macros: a gateway that does not run macros must still answer a run, so it never hangs
// in the app; a pushed macro set is accepted silently.
import { short } from '../harness.js';

export const id = 'C16';
export const title = 'macros/run → macro/run/status phase "error" echoing runId/macroId; macros/push and macros/abort ignored';
export const level = 'optional';

const MACRO = '64b7a10000000000000000aa';
const RUN = '7c1d0e2f-0000-4000-8000-000000000001';

export default async function run(h) {
  const env = await h.env({ macros: [{ macroId: MACRO, program: { v: 1, code: [] } }] });
  const { tenant, gatewayId } = env;
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced (macros/push arrived with it)');
  await env.advance(5_000);

  let t = env.now();
  env.cloud.sendMacros(tenant, gatewayId, 'macros/push', { macros: [{ macroId: MACRO, program: { v: 1, code: [] } }] });
  env.cloud.sendMacros(tenant, gatewayId, 'macros/abort', {});
  await env.advance(5_000);
  const noise = env.cloud.uplinks.filter((u) => u.arrivedAt >= t && !['gateway.status', 'gateway.device-data', 'gateway.device-status'].includes(u.id));
  h.check('push-ignored', noise.length === 0, `macros/push and macros/abort need no reply (got ${short(noise.map((u) => u.id))})`);

  t = env.now();
  env.cloud.sendMacros(tenant, gatewayId, 'macros/run', { macroId: MACRO, runId: RUN, params: {} });
  await env.advance(5_000);
  const st = env.cloud.up('gateway.macro-run-status').filter((u) => u.arrivedAt >= t);
  const b = st[0] && st[0].body;
  h.check('run-answered', st.length >= 1 && st[0].valid, `macros/run is answered on macro/run/status (got ${short(st.map((u) => u.body)) || 'nothing'})`);
  h.check('run-error', b && b.phase === 'error' && b.runId === RUN && b.macroId === MACRO && typeof b.message === 'string' && b.message.length > 0,
    `the answer is phase "error" with a message, echoing runId and macroId (got ${short(b)})`);
  h.check('no-started', !st.some((u) => u.body && u.body.phase === 'started'), 'a gateway that does not run macros never reports "started"');
}
