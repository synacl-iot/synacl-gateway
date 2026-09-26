// The CLI dispatcher. It parses nothing but the subcommand name; each command module owns its
// flags and help (see CliCommand in src/core/types.js). Commands are imported on demand so
// `--version` and `help` never load mqtt.js or the gateway core.

/** @typedef {import('../core/types.js').CliIO} CliIO */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXIT } from './args.js';
import { flushStream, redactingStream } from './output.js';
import { version } from '../index.js';

const COMMANDS = {
  init: './init.js',
  run: './run.js',
  status: './status.js',
  metrics: './metrics.js',
  service: './service.js',
  doctor: './doctor.js',
  conformance: './conformance.js',
};

export const USAGE = `synacl-gateway ${version} — the reference gateway for the Synacl IoT platform

Usage: synacl-gateway <command> [options]

Commands:
  init          save the settings from Gateways → Connection Info and check them
  run           run the gateway in the foreground
  status        show what the gateway is doing (also when it is stopped)
  metrics       show the host metrics this machine would publish
  service       install or remove the systemd service (Linux)
  doctor        look for problems on this machine, the broker and the platform
  conformance   run the protocol conformance suite (--offline)
  help [cmd]    show help for a command
  --version     print the version

Environment:
  SYNACL_GATEWAY_HOME   where config.json and state live (default ~/.synacl-gateway)

Protocol: https://synacl.com/protocol/
Source:   https://github.com/synacl-iot/synacl-gateway
`;

/** `$SYNACL_GATEWAY_HOME`, default `~/.synacl-gateway`. */
export function resolveHome(env = {}) {
  return env.SYNACL_GATEWAY_HOME ? resolve(env.SYNACL_GATEWAY_HOME) : join(homedir(), '.synacl-gateway');
}

/**
 * @param {string[]} argv  Arguments after the executable (process.argv.slice(2)).
 * @param {CliIO} io
 * @param {{load?: (specifier: string) => Promise<{default: Function}>}} [opts]  Module loader (tests).
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io, { load = (spec) => import(spec) } = {}) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) { io.stderr.write(USAGE); return EXIT.USAGE; }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') { io.stdout.write(`${version}\n`); return EXIT.OK; }
  if (cmd === '--help' || cmd === '-h') { io.stdout.write(USAGE); return EXIT.OK; }
  if (cmd === 'help') {
    const topic = rest[0];
    if (topic === undefined) { io.stdout.write(USAGE); return EXIT.OK; }
    if (!Object.hasOwn(COMMANDS, topic)) return unknown(topic, io);
    return dispatch(topic, ['--help'], io, load);
  }
  if (!Object.hasOwn(COMMANDS, cmd)) return unknown(cmd, io);
  return dispatch(cmd, rest, io, load);
}

async function dispatch(cmd, args, io, load) {
  let mod;
  try {
    mod = await load(new URL(COMMANDS[cmd], import.meta.url).href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(COMMANDS[cmd].slice(2))) {
      io.stderr.write(`error: the ${cmd} command is not available in this build\n`);
      return EXIT.RUNTIME;
    }
    throw err;
  }
  return mod.default(args, io);
}

function unknown(cmd, io) {
  // Only repeat something shaped like a command name: a misplaced argument could be a password.
  const name = /^[a-z][a-z0-9-]{0,31}$/.test(cmd) ? ` "${cmd}"` : '';
  io.stderr.write(`error: unknown command${name}\n\n${USAGE}`);
  return EXIT.USAGE;
}

/** Values that must never appear in output: --pass on the command line, passwords in the environment. */
export function collectSecrets(argv, env = {}) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === '--pass' && typeof argv[i + 1] === 'string') out.push(argv[i + 1]);
    else if (a.startsWith('--pass=')) out.push(a.slice('--pass='.length));
  });
  for (const k of ['SYNACL_PASS', 'SYNACL_PASSWORD']) if (env[k]) out.push(env[k]);
  return out;
}

/** The bin entry point: real process streams, then process.exit with the command's code. */
export async function cli() {
  const argv = process.argv.slice(2);
  const env = process.env;
  // `synacl-gateway metrics | head`: a closed pipe is the reader's choice, not a crash.
  for (const s of [process.stdout, process.stderr]) {
    s.on('error', (err) => process.exit(err?.code === 'EPIPE' ? EXIT.OK : EXIT.RUNTIME));
  }
  const secrets = collectSecrets(argv, env);
  // A safety net under every command: whatever gets printed, the password comes out as ***.
  const io = {
    stdout: redactingStream(process.stdout, secrets),
    stderr: redactingStream(process.stderr, secrets),
    stdin: process.stdin,
    env,
    home: resolveHome(env),
  };
  let code;
  try {
    code = await main(argv, io);
  } catch (err) {
    io.stderr.write(`error: ${err?.message ?? err}\n`);
    code = EXIT.RUNTIME;
  }
  // process.exit (rather than waiting for the loop to drain) because `run` may leave driver
  // handles behind after a clean stop; pipes on macOS are async, so flush first.
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  process.exit(Number.isInteger(code) ? code : EXIT.RUNTIME);
}
