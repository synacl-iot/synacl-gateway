// C04 — chunked config transfer (opt-in `configCap`): reassembly, the old hash on every part,
// a config that changes mid-transfer, a tampered part, and a config larger than 64 KiB.
import { FIXTURE_537, FIXTURE_537_HASH, GATEWAY, configPayload, device, deviceId } from '../fixtures.js';
import { fnv1a32 } from '../protocol.js';
import { short } from '../harness.js';

export const id = 'C04';
export const title = 'Chunked config: 13-part vector, old hash on every part, h/n change restarts at 0, tamper is bounded, >64 KiB';
export const level = 'optional';

const effPart = (r) => (r.body && r.body.part != null ? r.body.part : 0);

/** A config with `count` quiet devices (no interval tags), for size tests. */
export function bigConfig(count, tagsPer = 6) {
  const devices = [];
  for (let i = 0; i < count; i++) {
    devices.push(device(0x1000 + i, {
      tickDuration: 3_600_000,
      tags: Array.from({ length: tagsPer }, (_, t) => ({ name: `register_${i}_${t}`, mbAddress: 40001 + t, isIntervalRead: false, thresholdStart: 200, thresholdEnd: 250 })),
    }));
  }
  return configPayload(devices);
}

export default async function run(h) {
  const env = await h.env({ cloudConfig: FIXTURE_537, fileConfig: { configCap: 120 } });
  const { tenant } = env;
  const transferSince = (t0) => env.configRequests().filter((r) => r.arrivedAt >= t0);
  const reconnect = async () => {
    env.broker.drop(GATEWAY);
    await env.advance(1_000);
  };

  // ── A: the pinned 537-byte vector ──
  h.check('vector-hash', fnv1a32(FIXTURE_537) === FIXTURE_537_HASH && Buffer.byteLength(FIXTURE_537) === 537, 'the 537-byte vector hashes to 1657896004');
  await env.start();
  const okA = await env.waitSynced(120_000);
  const chunks = env.g.configPushes.filter((p) => p.kind === 'chunk').map((p) => p.body);
  const served = new Set(chunks.map((c) => c.p));
  h.check('13-parts', chunks.length >= 13 && chunks.every((c) => c.n === 13) && served.size === 13, `cap 120 → 13 parts, each served (served ${[...served].sort((a, b) => a - b).join(',')}; n=${short([...new Set(chunks.map((c) => c.n))])})`);
  const lens = [...served].sort((a, b) => a - b).map((p) => chunks.find((c) => c.p === p).d.length);
  h.check('slice-sizes', lens.slice(0, 12).every((l) => l === 56) && lens[12] === 44, `slices are 56 base64 chars, the last 44 (got ${lens.join(',')})`);
  const reqsA = env.configRequests();
  const partReqsA = reqsA.filter((r) => r.body && r.body.hash !== FIXTURE_537_HASH);
  h.check('cap-sent', partReqsA.every((r) => r.body && r.body.cap === 120), `every request during the transfer carries cap 120 (got ${short(partReqsA.map((r) => r.body && r.body.cap))})`);
  h.check('old-hash-0', partReqsA.every((r) => !r.body.hash), `every part request carries the OLD hash (0 on first boot) (got ${short(partReqsA.map((r) => r.body.hash))})`);
  const raw = env.gw.state.readConfigRaw();
  h.check('reassembled', okA && raw && Buffer.from(raw.bytes).toString('utf8') === FIXTURE_537, `reassembled bytes equal the 537-byte vector and the platform shows configCurrent (${short(raw && Buffer.from(raw.bytes))})`);

  // ── B: a later transfer carries the previous (non-zero) hash on every part ──
  const cfgB = FIXTURE_537.replace('"voltage"', '"voltage_l1"');
  const hashB = fnv1a32(cfgB);
  env.cloud.setConfig(tenant, GATEWAY, cfgB);
  const tB = env.now();
  await reconnect();
  const okB = await env.waitSynced(120_000);
  const reqsB = transferSince(tB);
  const partsB = reqsB.filter((r) => r.body && r.body.hash !== hashB);
  h.check('old-hash-nonzero', okB && partsB.length >= 13 && partsB.every((r) => r.body.hash === FIXTURE_537_HASH),
    `every part request of the second transfer carries the previous hash ${FIXTURE_537_HASH} (got ${short([...new Set(partsB.map((r) => r.body.hash))])}, ${partsB.length} requests)`);

  // ── C: the payload changes mid-transfer (h and n change) → restart at part 0 ──
  const cfgC = FIXTURE_537.replace('"voltage"', '"voltage_phase_a"');
  const cfgD = configPayload([device(2, { tickDuration: 10_000, tags: [{ name: 'flow' }, { name: 'level' }, { name: 'valve_position', isIntervalRead: false }] }), device(3, { tickDuration: 20_000 })]);
  const hashD = fnv1a32(cfgD);
  env.cloud.setConfig(tenant, GATEWAY, cfgC);
  let switched = false;
  env.cloud.downlinkFilter = (topic, payload) => {
    if (!switched && topic.endsWith('/config/push')) {
      const b = JSON.parse(payload);
      if (b.p === 3) { switched = true; env.cloud.setConfig(tenant, GATEWAY, cfgD); }
    }
    return payload;
  };
  const tC = env.now();
  await reconnect();
  const okC = await env.waitSynced(120_000);
  env.cloud.downlinkFilter = null;
  const pushesC = env.g.configPushes.filter((p) => p.at >= tC && p.kind === 'chunk');
  const firstNew = pushesC.find((p) => p.body.h === hashD);
  const reqAfter = firstNew ? env.configRequests().find((r) => r.arrivedAt > firstNew.at) : null;
  h.check('restart-at-0', firstNew && firstNew.body.p !== 0 && reqAfter && effPart(reqAfter) === 0,
    `a chunk with a different h/n mid-transfer makes the gateway restart at part 0 (first new chunk p=${firstNew && firstNew.body.p}, next request ${short(reqAfter && reqAfter.body)})`);
  h.check('restart-completes', okC && env.cloud.configHash(tenant, GATEWAY) === hashD, 'the restarted transfer completes with the new config');

  // ── D: one tampered part → hash mismatch → restart, then success ──
  const cfgE = cfgD.replace('"flow"', '"flow_rate"');
  const hashE = fnv1a32(cfgE);
  env.cloud.setConfig(tenant, GATEWAY, cfgE);
  let tampered = 0;
  env.cloud.downlinkFilter = (topic, payload) => {
    if (tampered === 0 && topic.endsWith('/config/push')) {
      const b = JSON.parse(payload);
      if (b.p === 2 && b.h === hashE) { tampered++; b.d = `AAAA${b.d.slice(4)}`; return JSON.stringify(b); }
    }
    return payload;
  };
  const tD = env.now();
  await reconnect();
  const okD = await env.waitSynced(180_000);
  env.cloud.downlinkFilter = null;
  const part0D = transferSince(tD).filter((r) => r.body && r.body.hash !== hashE && effPart(r) === 0).length;
  h.check('tamper-restart', tampered === 1 && part0D === 2, `a tampered part is caught by the hash and the transfer restarts once at part 0 (part-0 requests: ${part0D})`);
  h.check('tamper-recovers', okD && env.gw.status().configHash === hashE, `after the clean retry the verified config is applied (gateway hash ${env.gw.status().configHash}, expected ${hashE})`);

  // ── E: permanently corrupt → bounded restarts, nothing applied ──
  const cfgF = cfgE.replace('"level"', '"tank_level"');
  env.cloud.setConfig(tenant, GATEWAY, cfgF);
  env.cloud.downlinkFilter = (topic, payload) => {
    if (topic.endsWith('/config/push')) {
      const b = JSON.parse(payload);
      if (b.p === 1) { b.d = `AAAA${b.d.slice(4)}`; return JSON.stringify(b); }
    }
    return payload;
  };
  const tE = env.now();
  await reconnect();
  await env.advance(5 * 60_000);
  env.cloud.downlinkFilter = null;
  const part0E = transferSince(tE).filter((r) => effPart(r) === 0).length;
  h.check('tamper-bounded', part0E >= 2 && part0E <= 4, `a transfer that never verifies is retried a bounded number of times, then backs off (part-0 requests in 5 min: ${part0E}, allowed 2–4)`);
  h.check('tamper-not-applied', env.gw.status().configHash === hashE, `a config that never verified is never applied (gateway hash ${env.gw.status().configHash})`);

  // ── F: a config larger than 64 KiB with cap 4096 ──
  const big = bigConfig(190);
  const bigBytes = Buffer.byteLength(big);
  env.cloud.setConfig(tenant, GATEWAY, big);
  const tF = env.now();
  await env.stop();
  env.config.configCap = 4096;
  await env.start();
  const okF = await env.waitSynced(180_000);
  const partsF = new Set(env.g.configPushes.filter((p) => p.at >= tF && p.kind === 'chunk').map((p) => p.body.p));
  const expectParts = Math.ceil(Buffer.from(big).toString('base64').length / 4032);
  const rawF = env.gw.state.readConfigRaw();
  h.check('big-config', bigBytes > 65_536 && okF && partsF.size === expectParts && rawF && Buffer.from(rawF.bytes).equals(Buffer.from(big)),
    `a ${bigBytes}-byte config travels as ${expectParts} parts of cap 4096 and is stored verbatim (parts served ${partsF.size}, synced ${okF})`);
  h.check('big-device-count', env.gw.status().devices.length === 190, `all 190 devices are configured (got ${env.gw.status().devices.length})`);
  void deviceId;
}
