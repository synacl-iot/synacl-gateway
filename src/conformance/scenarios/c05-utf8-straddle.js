// C05 — a 4-byte UTF-8 character split across two chunk slices must reassemble intact.
import { configPayload, device, deviceId } from '../fixtures.js';
import { fnv1a32 } from '../protocol.js';
import { short } from '../harness.js';

export const id = 'C05';
export const title = 'Multi-byte UTF-8 (a 4-byte emoji) straddling a slice boundary reassembles byte-for-byte';
export const level = 'core';

const CAP = 120;                       // → 56 base64 chars = 42 bytes per slice
const BYTES_PER_SLICE = ((CAP - 64) - ((CAP - 64) % 4)) / 4 * 3;
const EMOJI = '\u{1F321}\u{FE0F}';     // 🌡️ — a 4-byte code point followed by a 3-byte selector

/** Pad the first tag name until the emoji's 4 bytes start 2 bytes before a slice boundary. */
export function straddlingPayload() {
  for (let pad = 0; pad < BYTES_PER_SLICE; pad++) {
    const name = `${'t'.repeat(pad + 1)}${EMOJI}_temp`;
    const payload = configPayload([device(2, { tickDuration: 10_000, tags: [{ name }] })]);
    const at = Buffer.from(payload, 'utf8').indexOf(Buffer.from(EMOJI, 'utf8'));
    if (at % BYTES_PER_SLICE === BYTES_PER_SLICE - 2) return { payload, name, at };
  }
  throw new Error('could not place the emoji across a boundary');
}

export default async function run(h) {
  const { payload, name, at } = straddlingPayload();
  h.check('straddles', at % BYTES_PER_SLICE === BYTES_PER_SLICE - 2, `the emoji starts at byte ${at}, 2 bytes before a ${BYTES_PER_SLICE}-byte slice boundary`);
  const env = await h.env({ cloudConfig: payload, fileConfig: { configCap: CAP } });
  await env.start();
  const ok = await env.waitSynced(120_000);
  const raw = env.gw.state.readConfigRaw();
  h.check('bytes', ok && raw && Buffer.from(raw.bytes).equals(Buffer.from(payload, 'utf8')), `reassembled bytes are identical to the original (got ${short(raw && Buffer.from(raw.bytes))})`);
  h.check('hash', env.gw.status().configHash === fnv1a32(payload), `the applied hash is FNV-1a over the reassembled bytes (${fnv1a32(payload)})`);
  await env.advance(25_000);
  const data = env.data(deviceId(2));
  h.check('tag-name', data.some((d) => d.body && Object.prototype.hasOwnProperty.call(d.body.values, name)), `the tag is published under its exact name "${name}" (got ${short(data[0] && data[0].body)})`);
}
