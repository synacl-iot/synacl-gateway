import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThresholds } from '../../src/core/thresholds.js';
import { createPublisher } from '../../src/core/publisher.js';
import {
  createFakeClock, createFakeTransport, createTopics, createValidators, createMemoryLogger, device, devId,
} from '../_support/core-runtime/fakes.js';

const D = devId(1);

function setup() {
  const clock = createFakeClock();
  const transport = createFakeTransport(clock);
  const validators = createValidators();
  const log = createMemoryLogger();
  const publisher = createPublisher({ transport, topics: createTopics(), validators, clock, log, strict: true });
  const th = createThresholds({ publisher, clock, log });
  const alerts = () => transport.bySuffix(`devices/${D}/alert`).map((m) => m.body);
  return { clock, transport, validators, th, alerts };
}

const dev = (tag) => device(D, { tags: [{ name: 'temp', ...tag }] });

test('edge-triggered: one VIOLATION on leaving the band, one CLEARED on return', async () => {
  const { th, alerts, validators } = setup();
  const d = dev({ thresholdStart: 10, thresholdEnd: 80 });
  for (const v of [50, 90, 95, 99, 70, 60, 5]) th.evaluate(d, { temp: v }, 1000 + v);
  await th.idle();
  const a = alerts();
  assert.deepEqual(a.map((x) => [x.code, x.severity, x.value]), [
    ['THRESHOLD_VIOLATION', 'warning', 90],
    ['THRESHOLD_CLEARED', 'info', 70],
    ['THRESHOLD_VIOLATION', 'warning', 5],
  ]);
  assert.equal(a[0].tag, 'temp');
  assert.equal(a[0].ts, 1090);
  assert.match(a[0].message, /90 outside range \[10, 80\]/);
  for (const x of a) assert.ok(validators.validate('alert', x).ok);
});

test('engineering units: raw × scaleFactor + offset is compared, eng value is reported', async () => {
  const { th, alerts } = setup();
  const d = dev({ scaleFactor: 0.1, offset: -40, thresholdStart: 0, thresholdEnd: 30 });
  th.evaluate(d, { temp: 650 }, 1); // 65 − 40 = 25 → in band
  th.evaluate(d, { temp: 710 }, 2); // 31 → out
  await th.idle();
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0].value, 31);
});

test('[0, 0] is no band; [0, 500] is a band', async () => {
  const { th, alerts } = setup();
  th.evaluate(dev({ thresholdStart: 0, thresholdEnd: 0 }), { temp: -999 }, 1);
  await th.idle();
  assert.equal(alerts().length, 0);
  th.evaluate(dev({ thresholdStart: 0, thresholdEnd: 500 }), { temp: -1 }, 2);
  await th.idle();
  assert.equal(alerts().length, 1);
});

test('±1e9 sentinels make one-sided bands with no special case', async () => {
  const { th, alerts } = setup();
  const upper = dev({ thresholdStart: -1e9, thresholdEnd: 30 });
  th.evaluate(upper, { temp: -5000 }, 1);
  th.evaluate(upper, { temp: 31 }, 2);
  await th.idle();
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].message, /upper limit 30/);
  const lower = { ...dev({ thresholdStart: 10, thresholdEnd: 1e9 }), id: D };
  const s2 = setup();
  s2.th.evaluate(lower, { temp: 1e8 }, 1);
  s2.th.evaluate(lower, { temp: 9 }, 2);
  await s2.th.idle();
  assert.equal(s2.alerts().length, 1);
  assert.match(s2.alerts()[0].message, /lower limit 10/);
});

test('non-numeric and non-finite values are not evaluated', async () => {
  const { th, alerts } = setup();
  const d = dev({ thresholdStart: 10, thresholdEnd: 80 });
  th.evaluate(d, { temp: 'hot' }, 1);
  th.evaluate(d, { temp: true }, 1);
  th.evaluate(d, { temp: NaN }, 1);
  th.evaluate(d, {}, 1);
  await th.idle();
  assert.equal(alerts().length, 0);
});

test('a band change resets the state silently (the platform clears its own warning)', async () => {
  const { th, alerts } = setup();
  th.evaluate(dev({ thresholdStart: 10, thresholdEnd: 80 }), { temp: 90 }, 1);
  const widened = dev({ thresholdStart: 10, thresholdEnd: 100 });
  th.reconcile([dev({ thresholdStart: 10, thresholdEnd: 80 })], [widened]);
  th.evaluate(widened, { temp: 90 }, 2); // in the new band: no CLEARED
  th.evaluate(widened, { temp: 120 }, 3); // leaves it: a fresh VIOLATION
  await th.idle();
  assert.deepEqual(alerts().map((a) => a.code), ['THRESHOLD_VIOLATION', 'THRESHOLD_VIOLATION']);
});

test('a scale change is also a band change, even without reconcile', async () => {
  const { th, alerts } = setup();
  th.evaluate(dev({ thresholdStart: 10, thresholdEnd: 80 }), { temp: 90 }, 1);
  th.evaluate(dev({ thresholdStart: 10, thresholdEnd: 80, scaleFactor: 0.5 }), { temp: 90 }, 2); // 45: in band, state was reset
  await th.idle();
  assert.deepEqual(alerts().map((a) => a.code), ['THRESHOLD_VIOLATION']);
});

test('resetDevice (device became unreachable) clears the in-alert state', async () => {
  const { th, alerts } = setup();
  const d = dev({ thresholdStart: 10, thresholdEnd: 80 });
  th.evaluate(d, { temp: 90 }, 1);
  th.resetDevice(D);
  th.evaluate(d, { temp: 95 }, 2);
  await th.idle();
  assert.deepEqual(alerts().map((a) => a.code), ['THRESHOLD_VIOLATION', 'THRESHOLD_VIOLATION']);
});

test('reconcile drops removed devices and tags', async () => {
  const { th, alerts } = setup();
  const d = dev({ thresholdStart: 10, thresholdEnd: 80 });
  th.evaluate(d, { temp: 90 }, 1);
  th.reconcile([d], []);
  th.evaluate(d, { temp: 95 }, 2);
  await th.idle();
  assert.equal(alerts().length, 2);
});

test('offline transitions queue (≤100, oldest dropped) and flush in order after reconnect', async () => {
  const { th, transport, alerts } = setup();
  transport.connected = false;
  const d = dev({ thresholdStart: 10, thresholdEnd: 80 });
  // 110 transitions: out, in, out, in, …
  for (let i = 0; i < 110; i++) th.evaluate(d, { temp: i % 2 === 0 ? 90 : 50 }, 1000 + i);
  await th.idle();
  assert.equal(th.stats().queued, 100);
  assert.equal(th.stats().dropped, 10);
  assert.equal(transport.sent.length, 0);

  transport.connected = true;
  th.evaluate(d, { temp: 90 }, 5000); // happens before the flush: must not overtake the queue
  await th.idle();
  assert.equal(transport.sent.length, 0);
  await th.flushQueued();
  const ts = alerts().map((a) => a.ts);
  assert.equal(ts.length, 100); // the cap held: the newest pushed out one more of the oldest
  assert.equal(ts[0], 1011);
  assert.equal(ts.at(-1), 5000);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  assert.equal(th.stats().queued, 0);
});
