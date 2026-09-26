// Public entry point. The programmatic API is experimental until 1.0; the CLI is the product.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Package version — also what the gateway reports to the platform as its firmware version. */
export const version = require('../package.json').version;
