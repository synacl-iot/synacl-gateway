// Every conformance scenario is also a node:test test: the suite the CLI runs for users is the
// suite this project runs on every change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../../src/conformance/scenarios/index.js';
import { runScenario } from '../../src/conformance/runner.js';

for (const mod of SCENARIOS) {
  test(`${mod.id} [${mod.level}] ${mod.title}`, async () => {
    const r = await runScenario(mod);
    if (r.status === 'skipped') return;
    const failed = r.assertions.filter((a) => !a.ok);
    assert.equal(failed.length, 0, failed.map((a) => `${a.id}: ${a.message}`).join('\n'));
    assert.ok(r.assertions.length > 0, 'a scenario must make at least one check');
  });
}
