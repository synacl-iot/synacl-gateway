// C01 — the connection sequence: Last Will, subscriptions, and the order of the first publishes.
import { createRequire } from 'node:module';
import { short } from '../harness.js';
import { GATEWAY } from '../fixtures.js';

export const id = 'C01';
export const title = 'Connect: Last Will, 7 subscriptions, status → capabilities → config/request';
export const level = 'core';

const { version } = createRequire(import.meta.url)('../../../package.json');
const BUILTINS = ['host', 'mqtt-bridge', 'modbus-tcp'];

export default async function run(h) {
  // Real built-in drivers: the capability report must list what actually ships.
  const env = await h.env({ drivers: 'builtin' });
  await env.start();
  await env.waitOnline(30_000);
  await env.advance(3_000);

  const c = env.transport.connectCalls[0];
  const will = c && c.opts.will;
  h.check('client-id', c && c.opts.clientId === GATEWAY, `client id must be the gateway id "${GATEWAY}" (got ${short(c && c.opts.clientId)})`);
  h.check('keepalive', c && c.opts.keepalive === 60, `keepalive must be 60 s (got ${c && c.opts.keepalive})`);
  h.check('lwt-topic', will && will.topic === env.topics.topic('status'), `Last Will topic must be ${env.topics.topic('status')} (got ${short(will && will.topic)})`);
  h.check('lwt-bytes', will && Buffer.from(will.payload).toString('utf8') === '{"online":false}', `Last Will payload must be exactly {"online":false} (got ${short(will && String(will.payload))})`);
  h.check('lwt-qos-retain', will && will.qos === 1 && will.retain === true, `Last Will must be QoS 1, retained (got qos ${will && will.qos}, retain ${will && will.retain})`);

  const sub = env.transport.subscribeCalls;
  const filters = sub.flatMap((s) => s.filters);
  const want = env.topics.downlinkFilters();
  const sameSet = filters.length === want.length && want.every((f) => filters.includes(f));
  h.check('subscriptions', sameSet, `must subscribe to exactly the ${want.length} downlink filters ${want.map((f) => f.slice(env.topics.prefix.length + 1)).join(', ')} (got ${filters.map((f) => f.replace(`${env.topics.prefix}/`, '')).join(', ') || 'none'})`);
  h.check('subscription-qos', sub.length > 0 && sub.every((s) => s.qos === 1), `subscriptions must request QoS 1 (got ${sub.map((s) => s.qos).join(',')})`);

  const first = env.cloud.uplinks.filter((u) => !u.lwt).slice(0, 3);
  const [s, caps, req] = first;
  h.check('order', first.map((u) => u.id).join(' → ') === 'gateway.status → gateway.firmware-response → gateway.config-request',
    `first three publishes must be status → firmware/response → config/request (got ${first.map((u) => u.id).join(' → ')})`);
  h.check('status-online', s && s.body && s.body.online === true && s.retain === true, `first status must be {"online":true,…} retained (got ${short(s && s.raw)})`);
  h.check('status-no-ts', s && s.body && !('ts' in s.body), `heartbeat must not carry ts, so the platform uses its own clock (got ${short(s && s.raw)})`);
  h.check('status-fw', s && s.body && s.body.fw === version, `heartbeat fw must be the package version ${version} (got ${short(s && s.body && s.body.fw)})`);

  const cb = caps && caps.body;
  h.check('caps-valid', caps && caps.valid, `capability report must validate strictly (${caps ? caps.errors.join('; ') : 'missing'})`);
  h.check('caps-version', cb && cb.version === version, `capability version must be ${version} (got ${short(cb && cb.version)})`);
  h.check('caps-protocols', cb && Array.isArray(cb.protocols) && BUILTINS.every((p) => cb.protocols.includes(p)), `protocols must include ${BUILTINS.join(', ')} (got ${short(cb && cb.protocols)})`);
  h.check('caps-stored', !!env.g.capabilities, 'the platform stored the capability report (it needs protocols or sensorModels)');

  const rb = req && req.body;
  h.check('request-hash-0', rb && (rb.hash === 0 || rb.hash === undefined), `first config/request with no stored config must carry hash 0 (got ${short(req && req.raw)})`);
  h.check('request-after-caps', req && caps && req.publishedAt - caps.publishedAt >= 1000,
    `config/request must follow the capability report by ≥1 s (got ${req && caps ? req.publishedAt - caps.publishedAt : '?'} ms)`);
  h.check('request-no-cap', rb && !('cap' in rb), `config/request must not send cap unless chunking is configured (got ${short(req && req.raw)})`);
}
