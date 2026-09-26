// Run with `npm test` (after `npm install`, which links synacl-gateway for the harness).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { assertDriver, createMemoryLogger } from 'synacl-gateway/testing';
import driver from './index.js';

const AUTH = 'Bearer example-token-123';
let server;
let url;

before(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sensor: { temp: 21.5, ok: true, label: 'hall' }, list: [1, 2.5], bad: null }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/state`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const device = () => ({
  conn: { url, authHeader: AUTH },
  tags: [
    { name: 'temp', jsonPath: 'sensor.temp' },
    { name: 'second', jsonPath: 'list.1' },
    { name: 'missing', jsonPath: 'sensor.humidity' },
  ],
});

test('passes the synacl-gateway driver contract checks', async () => {
  await assertDriver(driver, { device: device(), secrets: [AUTH] });
});

test('reads one value per tag and leaves out what is not there', async () => {
  const ctrl = new AbortController();
  const inst = driver.create({
    log: createMemoryLogger(),
    clock: { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval },
    gatewayId: 'example-gw',
    dataDir: '.',
    signal: ctrl.signal,
    options: {},
  });
  const handle = await inst.open({ id: '66f1a2b3c4d5e6f708192a3b', protocol: 'http', intervalMs: 10000, ...device() });
  const r = await inst.read(handle, device().tags, { reason: 'interval', signal: ctrl.signal });
  assert.equal(r.reachable, true);
  assert.deepEqual(r.values, { temp: 21.5, second: 2.5 });
  assert.equal('missing' in r.values, false);
  await inst.close(handle);
});
