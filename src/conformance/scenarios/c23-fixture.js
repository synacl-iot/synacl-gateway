// C23 — the pinned 210-byte fixture: its hash, its normalisation (the platform omits keys that
// equal the firmware default, and the gateway must fill them back in), and unknown keys ignored.
import { FIXTURE_3420619844, FIXTURE_3420619844_HASH, deviceId } from '../fixtures.js';
import { fnv1a32 } from '../protocol.js';
import { short } from '../harness.js';

export const id = 'C23';
export const title = 'Fixture 3420619844 → oil_temp normalised (isIntervalRead:false, band 10..80, defaults filled); unknown keys ignored';
export const level = 'core';

export default async function run(h) {
  h.check('bytes', Buffer.byteLength(FIXTURE_3420619844) === 210 && fnv1a32(FIXTURE_3420619844) === FIXTURE_3420619844_HASH, 'the 210-byte fixture hashes to 3420619844');

  let model = null;
  try { model = await import('../../core/config-model.js'); } catch { /* reported below */ }
  if (model && typeof model.normalizeConfig === 'function') {
    const { devices, errors } = model.normalizeConfig(JSON.parse(FIXTURE_3420619844), { overrides: {}, minIntervalMs: 1000 });
    const tag = devices[0] && devices[0].tags[0];
    h.check('normalised', tag && tag.name === 'oil_temp' && tag.isIntervalRead === false && tag.thresholdStart === 10 && tag.thresholdEnd === 80,
      `oil_temp keeps isIntervalRead:false and its 10..80 band (got ${short(tag)})`);
    h.check('defaults', tag && tag.scaleFactor === 1 && tag.offset === 0 && tag.registerType === 'holding' && tag.mbFormat === 'u16' && tag.mbWordOrder === 'big' && tag.mbAddress === 0,
      `omitted keys read as the documented defaults (got ${short(tag && { scaleFactor: tag.scaleFactor, offset: tag.offset, registerType: tag.registerType, mbFormat: tag.mbFormat, mbWordOrder: tag.mbWordOrder, mbAddress: tag.mbAddress })})`);
    h.check('interval', devices[0] && devices[0].intervalMs === 10_000, `no interval in conn → 10000 ms (got ${devices[0] && devices[0].intervalMs})`);
    h.check('no-errors', errors.length === 0, `no normalisation errors (got ${short(errors)})`);
    const withUnknown = JSON.parse(FIXTURE_3420619844);
    withUnknown.future = { anything: true };
    withUnknown.devices[0].tags[0].unknownKey = 'x';
    withUnknown.devices[0].conn.somethingNew = 7;
    const r2 = model.normalizeConfig(withUnknown, { overrides: {}, minIntervalMs: 1000 });
    h.check('unknown-keys', r2.devices.length === 1 && r2.errors.length === 0 && r2.devices[0].tags[0].thresholdEnd === 80, `unknown keys are ignored (errors ${short(r2.errors)})`);
  } else {
    h.check('normalised', false, 'the gateway core does not expose normalizeConfig(doc, opts)');
  }

  // Live: the gateway applies the exact bytes and reports the pinned hash; an unknown top-level key does not stop it.
  const env = await h.env({ cloudConfig: FIXTURE_3420619844 });
  await env.start();
  await env.waitSynced(60_000);
  const req = env.configRequests().find((r) => r.body && r.body.hash);
  h.check('live-hash', req && req.body.hash === FIXTURE_3420619844_HASH, `the gateway reports hash 3420619844 after applying the fixture (got ${short(req && req.body)})`);
  await env.advance(20_000);
  const onlyOnDemand = env.data(deviceId(2)).length === 0;
  h.check('on-demand-only', onlyOnDemand, 'an isIntervalRead:false tag is not polled (no data without read/once)');
  const extended = FIXTURE_3420619844.replace('"success":true}', '"success":true,"future":{"x":1}}');
  env.cloud.setConfig(env.tenant, env.gatewayId, extended);
  env.cloud.pushConfig(env.tenant, env.gatewayId);
  h.check('live-unknown-key', await env.waitSynced(30_000) && env.gw.status().configHash === fnv1a32(extended), 'a config with an unknown top-level key is applied and confirmed');
}
