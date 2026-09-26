// MQTT topic-filter matching (MQTT 3.1.1 §4.7), used by the mqtt-bridge driver to route one
// incoming message to every tag whose filter it matches. The broker already filtered what it
// sends us; we re-match locally because one pooled connection carries many devices' filters.

/**
 * Why a filter is not a valid MQTT subscription filter, or null when it is.
 * @param {string} filter
 * @returns {string|null}
 */
export function filterError(filter) {
  if (typeof filter !== 'string' || filter.length === 0) return 'topic filter is empty';
  if (filter.includes('\u0000')) return 'topic filter contains a NUL character';
  if (Buffer.byteLength(filter, 'utf8') > 65535) return 'topic filter is longer than 65535 bytes';
  const levels = filter.split('/');
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    if (level.includes('#') && (level !== '#' || i !== levels.length - 1)) {
      return `"#" must be the last level on its own (in "${filter}")`;
    }
    if (level.includes('+') && level !== '+') return `"+" must occupy a whole level (in "${filter}")`;
  }
  return null;
}

/**
 * Does `topic` match `filter`? Wildcards: `+` one level, `#` this level and everything below
 * (so `a/#` also matches `a`). Topics starting with `$` (broker internals such as `$SYS/…`) are
 * never matched by a filter whose first level is a wildcard, as the spec requires.
 * @param {string} filter
 * @param {string} topic
 * @returns {boolean}
 */
export function topicMatches(filter, topic) {
  if (typeof filter !== 'string' || typeof topic !== 'string' || topic.length === 0) return false;
  if (topic.includes('+') || topic.includes('#')) return false; // wildcards are illegal in topic names
  const f = filter.split('/');
  const t = topic.split('/');
  if (topic.startsWith('$') && (f[0] === '#' || f[0] === '+')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return i === f.length - 1;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}
