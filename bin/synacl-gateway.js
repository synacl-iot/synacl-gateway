#!/usr/bin/env node
// Development stub until src/cli/main.js lands.
import { version } from '../src/index.js';

if (process.argv.includes('--version')) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
process.stderr.write(`synacl-gateway ${version} — under construction; see https://synacl.com/protocol/\n`);
process.exit(1);
