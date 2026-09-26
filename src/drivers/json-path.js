// Dot-notation JSON paths — the same notation the platform uses for `jsonPath` on HTTP
// sources, so a path that works there works here: `ENERGY.Power`, `sensors.0.temp`
// (a numeric segment indexes an array), no escaping. The bracket form `sensors[0].temp` is
// accepted as a spelling of the same path, because people type it.
//
// Unlike a plain `obj?.[key]` walk, only OWN properties are followed and `__proto__`,
// `constructor` and `prototype` are never traversed: payloads come from devices on the local
// network, and a path must not be able to reach Object.prototype or a constructor function.

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Walk `value` along a dot path.
 * @param {unknown} value  A parsed JSON value.
 * @param {string} path  e.g. "ENERGY.Power" or "items.0.value".
 * @returns {unknown} The value found, or undefined when any segment is missing.
 */
export function walkPath(value, path) {
  if (typeof path !== 'string') return undefined;
  let cur = value;
  const dotted = path.replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
  for (const key of dotted.split('.')) {
    if (BLOCKED.has(key)) return undefined;
    // Only objects and arrays are traversed: indexing into a string or number is never what a
    // path into device JSON means.
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Keys a path segment may never name. */
export const BLOCKED_PATH_KEYS = Object.freeze([...BLOCKED]);
