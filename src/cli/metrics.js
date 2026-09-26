// `synacl-gateway metrics` — what a Host metrics device on this machine would publish, per
// metric key, with where each value comes from. The point is to answer "why is cpu.temp
// missing?" before adding the device in the app: unavailable metrics are never published as 0.

/** @typedef {import('../core/types.js').CliIO} CliIO */

import { EXIT, UsageError, loadFileConfig, parseCommandArgs } from './args.js';
import { createOutput, table } from './output.js';

const OPTIONS = { json: { type: 'boolean' }, watch: { type: 'string' }, config: { type: 'string' } };

export const USAGE = `Usage: synacl-gateway metrics [--json] [--watch <seconds>] [--config <path>]

Shows the values a Host metrics device on this machine would publish, the metric key to use
for each tag, and where each value comes from. Metrics this machine can't provide are listed
with the reason; the gateway leaves them out rather than sending 0.

Options:
  --json              print JSON (one document; one per line with --watch)
  --watch <seconds>   sample again every <seconds> until Ctrl-C
  --config <path>     read host.diskPath from this file instead of $SYNACL_GATEWAY_HOME/config.json
  -h, --help          show this help
`;

/**
 * @param {{host?: {describeHostMetrics: Function, createHostSampler: Function}, signals?: NodeJS.EventEmitter,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>, now?: () => number}} [deps]
 */
export function createMetricsCommand(deps = {}) {
  /** @param {string[]} argv @param {CliIO} io */
  return async function metrics(argv, io) {
    let values;
    let watchS = null;
    try {
      ({ values } = parseCommandArgs(argv, OPTIONS));
      if (values.watch !== undefined) {
        watchS = Number(values.watch);
        if (!Number.isFinite(watchS) || watchS < 1 || watchS > 3600) throw new UsageError('--watch takes a number of seconds between 1 and 3600');
      }
    } catch (err) {
      createOutput(io).error(err.message, 'Run "synacl-gateway metrics --help" for the options.');
      return EXIT.USAGE;
    }
    if (values.help) { io.stdout.write(USAGE); return EXIT.OK; }
    const out = createOutput(io, { json: Boolean(values.json) });

    const diskPath = resolveDiskPath(io, values.config, out);
    const host = deps.host ?? (await import('../drivers/host.js'));
    const now = deps.now ?? Date.now;

    const print = (rows) => {
      if (out.json) {
        io.stdout.write(`${JSON.stringify({ ts: now(), diskPath, metrics: rows }, null, watchS === null ? 2 : 0)}\n`);
        return;
      }
      out.line(table([
        ['METRIC', 'VALUE', 'UNIT', 'SOURCE'],
        ...rows.map((r) => [r.metric, r.available ? String(r.value) : '—', r.unit ?? '', r.available ? r.source : `${r.source} — ${r.reason ?? 'unavailable'}`]),
      ]));
    };

    if (watchS === null) {
      // Waits a second between two samples so rates (net.*_bps, cpu.load) are real on the first print.
      const rows = await host.describeHostMetrics({ diskPath, settleMs: 1000 });
      print(rows);
      if (!out.json) {
        out.line(`\nDisk: ${diskPath}. Use a METRIC as a tag's metric on a Host metrics device; tag names are yours to choose.`);
      }
      return EXIT.OK;
    }

    const signals = deps.signals ?? process;
    const ac = new AbortController();
    const stop = () => ac.abort();
    signals.on('SIGINT', stop);
    signals.on('SIGTERM', stop);
    const sleep = deps.sleep ?? abortableSleep;
    try {
      const sampler = host.createHostSampler({ diskPath });
      await sampler.prime();
      while (!ac.signal.aborted) {
        await sleep(watchS * 1000, ac.signal);
        if (ac.signal.aborted) break;
        const rows = await host.describeHostMetrics({ sampler });
        if (!out.json && io.stdout.isTTY) io.stdout.write('\x1b[H\x1b[2J');
        if (!out.json) out.line(`${new Date(now()).toISOString()}  (every ${watchS} s, Ctrl-C to stop)`);
        print(rows);
      }
      await sampler.close?.();
    } finally {
      signals.removeListener('SIGINT', stop);
      signals.removeListener('SIGTERM', stop);
    }
    return EXIT.OK;
  };
}

export default createMetricsCommand();

/** host.diskPath from config.json (and SYNACL_HOST_DISK_PATH); a missing config is fine here. */
function resolveDiskPath(io, configPath, out) {
  try {
    return loadFileConfig({ home: io.home, configPath, env: io.env }).config.host.diskPath;
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    if (err.code !== 'ENOCONFIG') out.warn(`${err.message} — using the defaults`);
    return io.env.SYNACL_HOST_DISK_PATH || '/';
  }
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}
