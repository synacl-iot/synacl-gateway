// Simulation mode (`sim/start` … `sim/stop`): every configured device produces synthetic
// readings instead of touching hardware, so a dashboard can be built before the equipment is
// wired. The scheduler asks `sim.read()` in place of the driver while `active` is true, which
// keeps pacing, thresholds and buffering exactly as in a real run. The heartbeat reports
// `simMode` while it is on.

/** @typedef {import('./types.js').Clock} Clock */
/** @typedef {import('./types.js').DeviceSpec} DeviceSpec */
/** @typedef {import('./types.js').TagSpec} TagSpec */
/** @typedef {import('./types.js').ReadResult} ReadResult */

const PERIOD_MS = 5 * 60 * 1000;

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/**
 * A smooth, deterministic wave per tag. When the tag has a finite band, the wave is centred in
 * it (in raw units) and briefly overshoots, so threshold alerts can be demonstrated too.
 * @param {TagSpec} tag
 * @param {string} deviceId
 * @param {number} t  epoch ms
 */
function synth(tag, deviceId, t) {
  const phase = (hash(`${deviceId}/${tag.name}`) % 1000) / 1000;
  const angle = 2 * Math.PI * ((t / PERIOD_MS) + phase);
  if (tag.registerType === 'coil' || tag.registerType === 'discrete') return Math.sin(angle) >= 0 ? 1 : 0;
  const start = Number(tag.thresholdStart) || 0;
  const end = Number(tag.thresholdEnd) || 0;
  let centre = 50;
  let amp = 25;
  if ((start !== 0 || end !== 0) && Math.abs(start) < 1e9 && Math.abs(end) < 1e9 && end > start) {
    centre = (start + end) / 2;
    amp = (end - start) * 0.6; // peaks leave the band by 10 % on each side
  }
  const scale = tag.scaleFactor || 1;
  const eng = centre + amp * Math.sin(angle);
  const raw = (eng - (tag.offset || 0)) / scale;
  return Math.round(raw * 100) / 100;
}

/**
 * @param {{clock: Clock}} deps
 */
export function createSim({ clock }) {
  let active = false;
  return {
    get active() { return active; },
    start() { active = true; },
    stop() { active = false; },
    /**
     * @param {DeviceSpec} device
     * @param {TagSpec[]} tags
     * @returns {ReadResult}
     */
    read(device, tags) {
      const t = clock.now();
      const values = {};
      for (const tag of tags) values[tag.name] = synth(tag, device.id, t);
      return { values, reachable: true };
    },
  };
}
