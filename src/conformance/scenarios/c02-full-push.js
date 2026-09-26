// C02 — full config push: hash the exact bytes, persist them, re-request, get "unchanged".
import { fnv1a32 } from '../protocol.js';
import { short } from '../harness.js';
import { deviceId } from '../fixtures.js';

export const id = 'C02';
export const title = 'Full push → FNV over the received bytes → stored verbatim → re-request → unchanged → configCurrent';
export const level = 'core';

// Deliberately NOT what JSON.stringify would produce for the parsed document (an escaped
// "é" and a trailing zero): a gateway that re-serialises before hashing reports the wrong
// hash and never reaches "unchanged".
export const PAYLOAD = `{"devices":[{"_id":"${deviceId(2)}","protocol":"rs485","conn":{"modbusId":1,"baudRate":9600,"tickDuration":10000},"tags":[{"name":"temp\\u00e9rature","registerType":"input","mbFormat":"f32","scaleFactor":1.50},{"name":"pressure","mbAddress":4}]}],"success":true}`;

export default async function run(h) {
  const env = await h.env({ cloudConfig: PAYLOAD });
  const expected = fnv1a32(PAYLOAD);
  await env.start();
  const synced = await env.waitSynced(60_000);

  const pushes = env.g.configPushes;
  h.check('full-push', pushes.some((p) => p.kind === 'full'), `the platform answered with the full payload (pushes: ${pushes.map((p) => p.kind).join(', ') || 'none'})`);
  const reqs = env.configRequests();
  const second = reqs.find((r) => r.body && r.body.hash !== 0 && r.body.hash !== undefined);
  h.check('rehash', second && second.body.hash === expected,
    `after applying, config/request must carry FNV-1a of the exact received bytes = ${expected} (got ${short(second && second.raw) || 'no re-request'})`);
  h.check('re-request-prompt', second && reqs[0] && second.publishedAt - reqs[0].publishedAt < 15_000,
    'the re-request is sent right after applying, not on a timer');
  h.check('unchanged', pushes.some((p) => p.kind === 'unchanged'), 'the platform answered the re-request with {"unchanged":true}');
  h.check('config-current', synced && env.cloud.configCurrent(env.tenant, env.gatewayId) === true, 'the platform shows configCurrent = true');
  h.check('busy-cleared', !env.cloud.busy(env.tenant, env.gatewayId), 'the platform cleared the gateway\'s busy flag');

  const raw = env.gw.state && env.gw.state.readConfigRaw ? env.gw.state.readConfigRaw() : null;
  h.check('stored-bytes', raw && Buffer.compare(Buffer.from(raw.bytes), Buffer.from(PAYLOAD, 'utf8')) === 0,
    `the stored config must be byte-identical to what was received (got ${raw ? short(Buffer.from(raw.bytes)) : 'nothing stored'})`);
  const st = env.gw.status();
  h.check('status-synced', st && st.configSynced === true && st.configHash === expected, `gateway status reports configSynced with hash ${expected} (got ${short({ configSynced: st && st.configSynced, configHash: st && st.configHash })})`);

  // The device runs, and its tag key is the decoded name.
  await env.advance(25_000);
  const data = env.data(deviceId(2));
  h.check('device-runs', data.length >= 1, `the configured device publishes data (got ${data.length} messages)`);
  h.check('decoded-key', data.some((d) => d.body && Object.prototype.hasOwnProperty.call(d.body.values, 'température')), `values are keyed by the decoded tag name "température" (got ${short(data[0] && data[0].body)})`);
  h.check('no-spam', env.configRequests().length <= 3, `no more config requests than needed in steady state (got ${env.configRequests().length})`);
}
