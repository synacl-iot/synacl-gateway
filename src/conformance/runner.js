// Runs conformance scenarios against the real gateway core and collects a report.
//
// A scenario is a module exporting `id`, `title`, `level` and a default `async (h) => {}`
// that records assertions with `h.check(id, ok, message)`. The same modules back this CLI
// report and the project's node:test suite (test/conformance/conformance.test.js).

import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createHarness, SkipScenario } from './harness.js';
import { buildReport } from './report.js';
import { SCENARIOS } from './scenarios/index.js';

const { version } = createRequire(import.meta.url)('../../package.json');

/** Real-time ceiling per scenario, so a hung await fails one scenario instead of the whole run. */
export const SCENARIO_TIMEOUT_MS = 120_000;

/** Every scenario id, in order. */
export const scenarioIds = () => SCENARIOS.map((s) => s.id);

/**
 * Run one scenario module.
 * @returns {Promise<import('./report.js').ScenarioResult>}
 */
export async function runScenario(mod, { timeoutMs = SCENARIO_TIMEOUT_MS } = {}) {
  const h = createHarness(mod);
  const started = performance.now();
  let status = 'passed';
  let reason;
  let timer;
  try {
    await Promise.race([
      mod.default(h),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`scenario did not finish within ${timeoutMs / 1000} s of real time`)), timeoutMs); }),
    ]);
  } catch (err) {
    if (err instanceof SkipScenario) {
      status = 'skipped';
      reason = err.message;
    } else {
      h.check('run', false, `scenario threw: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err)}`);
    }
  } finally {
    clearTimeout(timer);
  }
  await h._cleanup();
  if (status !== 'skipped') status = h.assertions.length > 0 && h.assertions.every((a) => a.ok) ? 'passed' : 'failed';
  const res = { id: mod.id, title: mod.title, level: mod.level, status, assertions: h.assertions, durationMs: performance.now() - started };
  if (reason) res.reason = reason;
  return res;
}

/**
 * @param {{ids?: string[], onResult?: (r: import('./report.js').ScenarioResult) => void, scenarios?: Object[]}} [opts]
 * @returns {Promise<import('./report.js').Report>}
 */
export async function runConformance({ ids, onResult, scenarios = SCENARIOS } = {}) {
  const want = ids && ids.length ? new Set(ids.map((s) => s.toUpperCase())) : null;
  const results = [];
  for (const mod of scenarios) {
    if (want && !want.has(mod.id)) continue;
    const r = await runScenario(mod);
    results.push(r);
    if (onResult) onResult(r);
  }
  return buildReport({ sdkVersion: version, scenarios: results });
}
