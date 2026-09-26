// C06 — the platform stays silent when a config exceeds what it believes the gateway can take;
// the gateway must retry on its own schedule and succeed once its capabilities are on record.
import { configPayload, device } from '../fixtures.js';
import { short } from '../harness.js';

export const id = 'C06';
export const title = 'Over-budget silence (capabilities not yet stored, 5 KB config) → retry at ~10 s succeeds; ≤5 requests in 5 min';
export const level = 'core';

export function fiveKbConfig() {
  const tags = Array.from({ length: 60 }, (_, i) => ({ name: `holding_register_${String(i).padStart(3, '0')}`, mbAddress: 100 + i, isIntervalRead: i < 4 }));
  return configPayload([device(2, { tickDuration: 10_000, tags })]);
}

export default async function run(h) {
  const payload = fiveKbConfig();
  const env = await h.env({ cloudConfig: payload });
  const legacy = env.cloud.budget(env.tenant, env.gatewayId);
  h.check('setup', Buffer.byteLength(payload) > legacy, `the config (${Buffer.byteLength(payload)} B) exceeds the legacy single-packet budget (${legacy} B)`);
  // The capability report is processed late — the first request is judged without it.
  env.cloud.processingDelayMs['gateway.firmware-response'] = 6_000;
  await env.start();
  await env.waitOnline(30_000);
  const first = env.configRequests()[0];
  await env.advance(5 * 60_000);

  const refused = env.cloud.eventsOf('gateway/config-too-large');
  h.check('silence', refused.length >= 1 && refused[0].at - first.arrivedAt < 1_000, `the first request is refused silently (config-too-large events: ${refused.length})`);
  const reqs = env.configRequests();
  const second = reqs[1];
  const gap = second ? second.publishedAt - first.publishedAt : null;
  h.check('retry-10s', gap != null && gap >= 8_000 && gap <= 15_000, `with no reply the gateway re-requests after ~10 s (got ${gap == null ? 'no retry' : `${gap} ms`})`);
  h.check('succeeds', env.cloud.configCurrent(env.tenant, env.gatewayId) === true, 'the retry is answered with the full config and the gateway ends up current');
  const inWindow = reqs.filter((r) => r.publishedAt - first.publishedAt <= 5 * 60_000);
  h.check('bounded', inWindow.length <= 5, `at most 5 config requests in the first 5 minutes (got ${inWindow.length}: ${short(inWindow.map((r) => Math.round((r.publishedAt - first.publishedAt) / 1000) + 's'))})`);
  h.check('same-connection', env.transport.connectCalls.length === 1, `a missing reply never causes a reconnect (connects: ${env.transport.connectCalls.length})`);
}
