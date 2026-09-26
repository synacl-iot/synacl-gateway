// C20 — a refused subscription is the only in-band sign that the gateway's identity does not
// match its credential. The gateway must notice it, stop, say why, and retry slowly.
import { OTHER_TENANT } from '../fixtures.js';
import { short } from '../harness.js';

export const id = 'C20';
export const title = 'Subscriptions refused (SUBACK 128) → ACL_DENIED: disconnect, nothing published, ≤1 retry per 5 min';
export const level = 'core';

export default async function run(h) {
  // config.json names another account than the credential belongs to.
  const env = await h.env({ fileConfig: { tenant: OTHER_TENANT } });
  await env.start();
  await env.advance(16 * 60_000);

  const subs = env.transport.subscribeCalls;
  h.check('subscribed', subs.length >= 1, 'the gateway subscribed (and got 128 for every filter)');
  const attempts = env.transport.connectCalls.length;
  h.check('slow-retry', attempts >= 2 && attempts <= 5, `after ACL_DENIED the gateway retries at most once per 5 minutes (connects in 16 min: ${attempts})`);
  const gaps = env.transport.connectCalls.slice(1).map((c, i) => c.at - env.transport.connectCalls[i].at);
  h.check('retry-spacing', gaps.every((g) => g >= 5 * 60_000 - 1_000), `retries are ≥5 min apart (got ${short(gaps.map((g) => Math.round(g / 1000) + 's'))})`);
  const denied = env.broker.denied.filter((d) => !d.lwt);
  h.check('no-publish', denied.length === 0, `nothing is published into a session whose subscriptions were refused (denied publishes: ${short(denied.map((d) => d.topic))})`);
  const ends = env.transport.endCalls.filter((e) => e.connected);
  h.check('disconnects', ends.length >= 1 && ends.every((e) => e.graceful), 'the gateway ends the session itself, gracefully');
  const why = env.log.lines.filter((l) => (l.level === 'error' || l.level === 'warn') && /acl|denied|refused|not authori[sz]ed|match/i.test(l.msg));
  h.check('explains', why.length >= 1, `the log explains the mismatch (${short(why[0] && why[0].msg) || 'no warn/error line mentions it'})`);
}
