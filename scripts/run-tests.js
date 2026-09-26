// Runs every test/**/*.test.js with node:test. A shell glob needs Node 21+, and Node 20's
// default discovery would also execute helper .js files under test/ as tests — so the list is
// built here and handed to `node --test` explicitly. Shared helpers live in test/_support/
// (never named *.test.js); extra args (e.g. --test-name-pattern) are passed through.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function collect(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '_support' ? [] : collect(p);
    return name.endsWith('.test.js') ? [p] : [];
  });
}

const files = collect('test');
const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
