#!/usr/bin/env node
// Entry point. Deliberately tiny and free of static imports: an old Node must reach the version
// check below and print a clear message, instead of failing to load a module it can't parse.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 11)) {
  process.stderr.write(`synacl-gateway needs Node.js 20.11 or newer (22 LTS recommended); this is ${process.version}.\n`);
  process.exit(1);
}
import('../src/cli/main.js').then((m) => m.cli());
