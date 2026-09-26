// Conformance report: the JSON document and its human-readable rendering.

/**
 * @typedef {{id: string, ok: boolean, message: string}} Assertion
 * @typedef {{id: string, title: string, level: 'core'|'optional', status: 'passed'|'failed'|'skipped',
 *            assertions: Assertion[], durationMs: number, reason?: string}} ScenarioResult
 * @typedef {{sdkVersion: string, protocol: '1', node: string, mode: 'offline',
 *            scenarios: ScenarioResult[], summary: {passed: number, failed: number, skipped: number}}} Report
 */

/** @param {ScenarioResult[]} scenarios */
export function summarize(scenarios) {
  const summary = { passed: 0, failed: 0, skipped: 0 };
  for (const s of scenarios) summary[s.status]++;
  return summary;
}

/** @returns {Report} */
export function buildReport({ sdkVersion, scenarios }) {
  return { sdkVersion, protocol: '1', node: process.version, mode: 'offline', scenarios, summary: summarize(scenarios) };
}

export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const indent = (text, pad) => String(text).split('\n').map((l) => pad + l).join('\n');

/**
 * Text: grouped CORE / OPTIONAL, one line per scenario, and each failed assertion with its
 * message (which names the offending message or value).
 * @param {Report} report
 */
export function renderText(report) {
  const out = [];
  out.push(`synacl-gateway ${report.sdkVersion} — conformance (${report.mode}), protocol v${report.protocol}, node ${report.node}`);
  for (const level of ['core', 'optional']) {
    const group = report.scenarios.filter((s) => s.level === level);
    if (!group.length) continue;
    out.push('', level.toUpperCase());
    for (const s of group) {
      const n = s.assertions.length;
      const failed = s.assertions.filter((a) => !a.ok);
      const tag = s.status === 'passed' ? '[pass]' : s.status === 'skipped' ? '[skip]' : '[FAIL]';
      const detail = s.status === 'skipped' ? (s.reason || 'skipped')
        : s.status === 'failed' ? `${failed.length} of ${n} check${n === 1 ? '' : 's'} failed`
          : `${n} check${n === 1 ? '' : 's'}`;
      out.push(`  ${tag} ${s.id} ${s.title} … ${detail} (${Math.round(s.durationMs)} ms)`);
      for (const a of failed) out.push(indent(`✗ ${a.id}: ${a.message}`, '         '));
    }
  }
  const { passed, failed, skipped } = report.summary;
  out.push('', `${passed} passed, ${failed} failed, ${skipped} skipped`);
  return `${out.join('\n')}\n`;
}
