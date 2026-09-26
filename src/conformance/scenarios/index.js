// The conformance scenarios, in report order. Ids and levels follow the published table.
import * as c01 from './c01-connect.js';
import * as c02 from './c02-full-push.js';
import * as c03 from './c03-restart-persisted.js';
import * as c04 from './c04-chunked.js';
import * as c05 from './c05-utf8-straddle.js';
import * as c06 from './c06-over-budget.js';
import * as c07 from './c07-unprompted-push.js';
import * as c08 from './c08-identical-push.js';
import * as c09 from './c09-pacing.js';
import * as c10 from './c10-read-once.js';
import * as c11 from './c11-set-interval.js';
import * as c12 from './c12-pause.js';
import * as c13 from './c13-writes.js';
import * as c14 from './c14-gateway-commands.js';
import * as c15 from './c15-firmware-request.js';
import * as c16 from './c16-macros.js';
import * as c17 from './c17-outage.js';
import * as c18 from './c18-lwt.js';
import * as c19 from './c19-thresholds.js';
import * as c20 from './c20-acl-denied.js';
import * as c21 from './c21-unsupported-protocol.js';
import * as c22 from './c22-examples.js';
import * as c23 from './c23-fixture.js';

export const SCENARIOS = [c01, c02, c03, c04, c05, c06, c07, c08, c09, c10, c11, c12, c13, c14, c15, c16, c17, c18, c19, c20, c21, c22, c23];
