// `synacl-gateway conformance` — run the protocol conformance suite, or check a driver package
// against the driver contract.
//
// Exit codes: 0 every scenario passed · 4 a scenario (or driver check) failed · 2 usage · 1 internal error.

/** @typedef {import('../core/types.js').CliIO} CliIO */

import { isAbsolute, join, resolve } from 'node:path';
import { EXIT, parseCommandArgs, UsageError } from './args.js';

export const USAGE = `Usage: synacl-gateway conformance --offline [--json] [--scenario <id>]… [--driver <package|path>]

Runs the real gateway core against an in-memory broker, a scripted platform that follows the
published protocol, and a virtual clock (a simulated half hour takes seconds). Checks the
connection sequence, configuration handling, pacing, commands, an outage with replay, and that
every message sent validates against the protocol schemas.

Options:
  --offline              run against the scripted platform (the only mode in this version)
  --scenario <id>        run only these scenarios (repeat, or comma-separate: C01,C09)
  --driver <pkg|path>    check a driver package against the driver contract instead
  --json                 print the report as JSON
  -h, --help             show this help

Exit codes: 0 passed · 4 failed · 2 usage error · 1 internal error
`;

/** Resolve a driver argument: a path (relative to the working directory) or a package name. */
async function loadDriver(spec, io) {
  const { loadDriverPackage } = await import('../drivers/index.js');
  const looksLikePath = isAbsolute(spec) || spec.startsWith('.') || (spec.includes('/') && !spec.startsWith('@'));
  const where = { driverDir: join(io.home, 'drivers'), home: process.cwd() };
  const target = looksLikePath ? resolve(process.cwd(), spec) : spec;
  const { def } = await loadDriverPackage(target, where);
  return def;
}

/**
 * @param {string[]} argv
 * @param {CliIO} io
 * @returns {Promise<number>}
 */
export default async function conformance(argv, io) {
  let args;
  try {
    args = parseCommandArgs(argv, {
      offline: { type: 'boolean' },
      json: { type: 'boolean' },
      scenario: { type: 'string', multiple: true },
      driver: { type: 'string' },
    }).values;
  } catch (err) {
    io.stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return err instanceof UsageError ? EXIT.USAGE : EXIT.RUNTIME;
  }
  if (args.help) { io.stdout.write(USAGE); return EXIT.OK; }

  if (args.driver) {
    let def;
    try {
      def = await loadDriver(args.driver, io);
    } catch (err) {
      io.stderr.write(`error: cannot load driver "${args.driver}": ${err.message}\n`);
      return EXIT.USAGE;
    }
    const { testDriver } = await import('../conformance/driver-harness.js');
    const r = await testDriver(def);
    if (args.json) io.stdout.write(`${JSON.stringify({ driver: r.name, ok: r.ok, checks: r.checks }, null, 2)}\n`);
    else {
      io.stdout.write(`driver ${r.name} — driver contract (apiVersion 1)\n`);
      for (const c of r.checks) io.stdout.write(`  ${c.ok ? '[pass]' : '[FAIL]'} ${c.id}${c.ok ? '' : `: ${c.message}`}\n`);
      io.stdout.write(`${r.ok ? 'the driver honours the contract' : 'the driver does NOT honour the contract'}\n`);
    }
    return r.ok ? EXIT.OK : EXIT.CONFORMANCE;
  }

  if (!args.offline) {
    io.stderr.write(`error: say --offline (the only mode in this version)\n\n${USAGE}`);
    return EXIT.USAGE;
  }

  const { runConformance, scenarioIds } = await import('../conformance/runner.js');
  const { renderJson, renderText } = await import('../conformance/report.js');
  const ids = (args.scenario || []).flatMap((s) => s.split(',')).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const known = new Set(scenarioIds());
  const unknown = ids.filter((i) => !known.has(i));
  if (unknown.length) {
    io.stderr.write(`error: unknown scenario ${unknown.join(', ')} (known: ${[...known].join(' ')})\n`);
    return EXIT.USAGE;
  }

  let report;
  try {
    report = await runConformance({
      ids,
      // Progress on stderr, so stdout stays a clean report (or clean JSON).
      onResult: args.json ? undefined : (r) => io.stderr.write(`${r.status === 'passed' ? '.' : r.status === 'skipped' ? 's' : 'F'}`),
    });
    if (!args.json) io.stderr.write('\n');
  } catch (err) {
    io.stderr.write(`error: the conformance runner failed: ${err && err.stack ? err.stack : err}\n`);
    return EXIT.RUNTIME;
  }
  io.stdout.write(args.json ? renderJson(report) : renderText(report));
  return report.summary.failed > 0 ? EXIT.CONFORMANCE : EXIT.OK;
}
