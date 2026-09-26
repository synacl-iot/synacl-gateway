// FNV-1a 32-bit (seed 0x811c9dc5, prime 0x01000193) — the protocol's config hash.
//
// The platform hashes the exact UTF-8 bytes it publishes on config/push, and answers a
// config/request whose `hash` matches with `{"unchanged":true}`. So the gateway must hash the
// bytes it RECEIVED — never a re-serialisation (key order, `0.01` vs `1e-2` and escaping would
// all move the hash and turn every reconnect into a full re-apply).

/**
 * @param {Uint8Array|string} bytes  A string is hashed as its UTF-8 encoding.
 * @returns {number} Unsigned 32-bit integer (0 … 4294967295).
 */
export function fnv1a32(bytes) {
  const b = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    // Math.imul keeps the multiply in 32 bits; a plain `*` loses precision past 2^53.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
