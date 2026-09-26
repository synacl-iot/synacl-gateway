// Modbus register decoding and encoding, shared by every Modbus transport.
//
// Decoding matches the reference firmware bit for bit, so a tag configured once reads the same
// value on an ESP32 gateway and on this one:
//   u16  the register as-is            s16  the register as two's-complement
//   u32 / s32 / f32  two registers — word order `big` (ABCD, the Modbus convention): the
//   register at the LOWER address is the HIGH word; `little` (CDAB): it is the LOW word.
// An unknown format decodes as u16 and an unknown word order as big, as the firmware does.
// Deliberate improvements over the firmware: u32/s32 are exact integers (it casts through a
// 32-bit float), and an f32 that is NaN or ±Infinity is reported as "no value" instead of
// being published — the platform drops a whole message that contains one.

const THIRTY_TWO_BIT = new Set(['u32', 's32', 'f32']);

/**
 * Registers a format occupies.
 * @param {string} format
 * @returns {1|2}
 */
export function wordCount(format) {
  return THIRTY_TWO_BIT.has(format) ? 2 : 1;
}

/**
 * Decode one or two 16-bit registers.
 * @param {number} w0  The register at the tag's address.
 * @param {number} w1  The register at address + 1 (ignored for 16-bit formats).
 * @param {string} format  u16 | s16 | u32 | s32 | f32
 * @param {string} wordOrder  big | little
 * @returns {number|undefined}  undefined when the bits are not a finite number (f32 NaN/Inf).
 */
export function decodeWords(w0, w1, format, wordOrder) {
  const a = w0 & 0xffff;
  if (format === 's16') return a >= 0x8000 ? a - 0x10000 : a;
  if (!THIRTY_TWO_BIT.has(format)) return a;
  const b = (w1 ?? 0) & 0xffff;
  const [hi, lo] = wordOrder === 'little' ? [b, a] : [a, b];
  if (format === 'f32') {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint16(0, hi);
    view.setUint16(2, lo);
    const f = view.getFloat32(0);
    // toPrecision(7): a float32 carries ~7 significant digits; this turns 230.5000030517578
    // style artefacts back into the number the device meant.
    return Number.isFinite(f) ? Number(f.toPrecision(7)) : undefined;
  }
  const u = hi * 0x10000 + lo;
  if (format === 's32') return u >= 0x80000000 ? u - 0x100000000 : u;
  return u;
}

/**
 * Encode a number into the two registers it would occupy — the inverse of decodeWords, used by
 * tests and the simulator.
 * @param {number} value
 * @param {string} format
 * @param {string} [wordOrder='big']
 * @returns {number[]}  One or two register values (0..65535), lowest address first.
 */
export function encodeWords(value, format, wordOrder = 'big') {
  if (!THIRTY_TWO_BIT.has(format)) return [value & 0xffff];
  const view = new DataView(new ArrayBuffer(4));
  if (format === 'f32') view.setFloat32(0, value);
  else view.setUint32(0, format === 's32' && value < 0 ? value + 0x100000000 : value);
  const hi = view.getUint16(0);
  const lo = view.getUint16(2);
  return wordOrder === 'little' ? [lo, hi] : [hi, lo];
}

/**
 * The 16-bit word written by FC06 for a requested value. Accepts the signed and the unsigned
 * reading of a register (−32768..65535); negatives are sent as two's complement.
 * @param {unknown} value
 * @returns {{ok: true, word: number} | {ok: false, error: string}}
 */
export function encodeRegisterWrite(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -32768 || value > 65535) {
    return { ok: false, error: `value ${JSON.stringify(value)} cannot be written to a holding register: it must be an integer from -32768 to 65535` };
  }
  return { ok: true, word: value < 0 ? value + 0x10000 : value };
}

/** Function code that reads each register table. */
export const READ_FUNCTION = Object.freeze({ coil: 1, discrete: 2, holding: 3, input: 4 });

const EXCEPTIONS = {
  1: 'illegal function',
  2: 'illegal data address',
  3: 'illegal data value',
  4: 'server device failure',
  5: 'acknowledge',
  6: 'server device busy',
  7: 'negative acknowledge',
  8: 'memory parity error',
  10: 'gateway path unavailable',
  11: 'gateway target device failed to respond',
};

/**
 * Standard name of a Modbus exception code.
 * @param {number} code
 * @returns {string}
 */
export function exceptionName(code) {
  return EXCEPTIONS[code] ?? 'unknown exception';
}

/**
 * Compact register label used in logs and reasons: hr40, ir0, co3, di7 — the same labels the
 * reference firmware logs, so support can compare the two.
 * @param {string} registerType
 * @param {number} address
 * @returns {string}
 */
export function registerLabel(registerType, address) {
  const prefix = { holding: 'hr', input: 'ir', coil: 'co', discrete: 'di' }[registerType] ?? 'di';
  return `${prefix}${address}`;
}
