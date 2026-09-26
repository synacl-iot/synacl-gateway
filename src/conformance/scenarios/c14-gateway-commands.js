// C14 — gateway commands: restart, reset/config, diagnostics, the live log tail, simulation
// mode, and commands the gateway must ignore.
import { configPayload, device, deviceId } from '../fixtures.js';
import { short } from '../harness.js';

export const id = 'C14';
export const title = 'restart, reset/config, debug/diag, live log tail (cats mask, ≤50/batch, stop, 5-min auto-stop), sim/start, unknown commands ignored';
export const level = 'optional';

const uuid = (n) => `0d9e8f7a-0000-4000-8000-${String(n).padStart(12, '0')}`;

export default async function run(h) {
  const payload = configPayload([device(deviceId(2), { tickDuration: 10_000 })]);
  const env = await h.env({ cloudConfig: payload });
  const { tenant, gatewayId, log } = env;
  const cmd = (body) => env.cloud.sendGatewayCmd(tenant, gatewayId, body);
  const since = (t, id) => env.cloud.up(id).filter((u) => u.arrivedAt >= t);
  const tailText = (t) => since(t, 'gateway.debug-log').flatMap((u) => (u.body && u.body.lines) || []).join('\n');
  const mark = (cat, tag) => log.child(cat).info(`conformance-mark-${cat}-${tag}`);
  await env.start();
  h.check('sync', await env.waitSynced(60_000), 'config synced');
  await env.advance(10_000);

  // debug/diag
  let t = env.now();
  cmd({ command: 'debug/diag', correlationId: uuid(1) });
  await env.advance(3_000);
  const diag = since(t, 'gateway.debug-response')[0];
  h.check('diag', diag && diag.valid && diag.body.correlationId === uuid(1), `debug/diag is answered on debug/response echoing the correlationId (got ${short(diag && diag.body) || 'nothing'})`);

  // live log tail with cats = 9 (system + modbus)
  t = env.now();
  cmd({ command: 'debug/logs/start', cats: 9 });
  await env.advance(1_000);
  for (const cat of ['system', 'modbus', 'sensors', 'network', 'commands']) mark(cat, 'a');
  await env.advance(3_000);
  const text = tailText(t);
  h.check('tail-selected', text.includes('conformance-mark-system-a') && text.includes('conformance-mark-modbus-a'), 'the tail streams the selected categories (system + modbus)');
  h.check('tail-filtered', !/conformance-mark-(sensors|network|commands)-a/.test(text), `the tail leaves out unselected categories (got: ${short(text.split('\n').filter((l) => l.includes('conformance-mark')))})`);

  // flood → batches stay within 50 lines
  t = env.now();
  for (let i = 0; i < 300; i++) log.child('modbus').info(`conformance-flood-${i}`);
  await env.advance(15_000);
  const batches = since(t, 'gateway.debug-log');
  h.check('tail-bounded', batches.length >= 1 && batches.every((b) => b.body && b.body.lines.length <= 50), `every debug/log batch carries at most 50 lines (sizes ${short(batches.map((b) => b.body && b.body.lines.length))})`);
  h.check('tail-paced', batches.length >= 1 && batches.every((b, i) => i === 0 || b.publishedAt - batches[i - 1].publishedAt >= 900), 'batches are flushed about once a second, not in a burst');

  // stop
  cmd({ command: 'debug/logs/stop' });
  await env.advance(2_000);
  t = env.now();
  mark('system', 'after-stop');
  await env.advance(5_000);
  h.check('tail-stop', since(t, 'gateway.debug-log').length === 0, 'debug/logs/stop ends the tail');

  // auto-stop after 5 minutes
  cmd({ command: 'debug/logs/start', cats: 1 });
  await env.advance(5 * 60_000 + 5_000);
  t = env.now();
  mark('system', 'late');
  await env.advance(5_000);
  h.check('tail-auto-stop', !tailText(t).includes('conformance-mark-system-late'), 'a forgotten tail stops on its own after 5 minutes');

  // unknown commands and job/config are ignored
  const connects = env.transport.connectCalls.length;
  t = env.now();
  cmd({ command: 'frobnicate', correlationId: uuid(2) });
  cmd({ command: 'job/config', control: { deviceName: deviceId(2), startOn: 'rising', debounceMs: 50, minJobMs: 1000 } });
  await env.advance(5_000);
  const replies = env.cloud.uplinks.filter((u) => u.arrivedAt >= t && !['gateway.status', 'gateway.device-data', 'gateway.device-status'].includes(u.id));
  h.check('ignore-unknown', replies.length === 0 && env.transport.connectCalls.length === connects, `unknown commands and job/config are ignored: no reply, no reconnect (got ${short(replies.map((u) => u.id))})`);

  // sim/start → heartbeat says so
  t = env.now();
  cmd({ command: 'sim/start' });
  await env.advance(3_000);
  const simBeat = since(t, 'gateway.status').find((u) => u.body && u.body.simMode === true);
  h.check('sim-start', !!simBeat, 'sim/start is reflected at once in a heartbeat with simMode:true');
  cmd({ command: 'sim/stop' });
  await env.advance(3_000);

  // restart: goodbye, then the full connect sequence again, with the current hash
  t = env.now();
  cmd({ command: 'restart' });
  await env.advance(15_000);
  const after = env.cloud.uplinks.filter((u) => u.arrivedAt >= t);
  const bye = after.findIndex((u) => u.id === 'gateway.status' && u.body && u.body.online === false && !u.lwt);
  const seq = after.slice(bye + 1).filter((u) => ['gateway.status', 'gateway.firmware-response', 'gateway.config-request'].includes(u.id)).slice(0, 3);
  h.check('restart-goodbye', bye !== -1 && after[bye].retain, 'restart publishes a retained {"online":false} first (no last will needed)');
  h.check('restart-sequence', seq.map((u) => u.id).join() === 'gateway.status,gateway.firmware-response,gateway.config-request' && seq[0].body.online === true,
    `then the full connect sequence runs again (got ${seq.map((u) => u.id).join(' → ')})`);
  h.check('restart-hash', seq[2] && seq[2].body.hash === env.cloud.configHash(tenant, gatewayId), `the request after a restart carries the running config's hash (got ${short(seq[2] && seq[2].body)})`);
  h.check('restart-no-lwt', !after.some((u) => u.lwt), 'a restart is graceful: no last will is published');
  await env.waitSynced(30_000);

  // reset/config: next request carries no hash, the full config comes back
  t = env.now();
  cmd({ command: 'reset/config' });
  await env.advance(15_000);
  const req = since(t, 'gateway.config-request')[0];
  h.check('reset-hash-0', req && (req.body.hash === 0 || req.body.hash === undefined), `after reset/config the next request carries hash 0 (got ${short(req && req.body) || 'no request'})`);
  h.check('reset-resync', (await env.waitSynced(60_000)) && env.g.configPushes.some((p) => p.at >= t && p.kind === 'full'), 'the platform re-sends the full config and the gateway is current again');
}
