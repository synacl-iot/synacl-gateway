import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { realClock, probeSkew } from '../../src/core/clock.js';

const fakeFetch = (date, delayMs = 0) => async (url, init) => {
  assert.equal(init.method, 'HEAD');
  await new Promise((r) => setTimeout(r, delayMs));
  return { headers: { get: (k) => (k.toLowerCase() === 'date' ? date : null) } };
};

test('realClock implements the Clock contract', async () => {
  assert.ok(Number.isInteger(realClock.now()));
  const n = { once: 0, cancelled: 0, every: 0 };
  realClock.setTimeout(() => { n.once++; }, 1);
  realClock.clearTimeout(realClock.setTimeout(() => { n.cancelled++; }, 1));
  const iv = realClock.setInterval(() => { n.every++; }, 1);
  await new Promise((r) => setTimeout(r, 30));
  realClock.clearInterval(iv);
  const every = n.every;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(n.once, 1);
  assert.equal(n.cancelled, 0);
  assert.ok(every >= 2);
  assert.equal(n.every, every, 'cleared intervals stop');
});

test('probeSkew: local − server, from the Date header', async () => {
  const ahead = new Date(Date.now() - 60_000).toUTCString(); // server says a minute ago → we are ahead
  const skew = await probeSkew('https://api.example.test', { fetch: fakeFetch(ahead) });
  assert.ok(skew > 58_000 && skew < 61_500, `${skew}`);
  const behind = new Date(Date.now() + 3_600_000).toUTCString();
  const skew2 = await probeSkew('https://api.example.test', { fetch: fakeFetch(behind) });
  assert.ok(skew2 < -3_598_000 && skew2 > -3_601_500, `${skew2}`);
  const now = new Date().toUTCString();
  assert.ok(Math.abs(await probeSkew('https://x.test', { fetch: fakeFetch(now) })) <= 1500);
});

test('probeSkew never throws: no url, no header, junk header, network error, timeout', async () => {
  assert.equal(await probeSkew(null), null);
  assert.equal(await probeSkew('https://x.test', { fetch: fakeFetch(null) }), null);
  assert.equal(await probeSkew('https://x.test', { fetch: fakeFetch('not a date') }), null);
  assert.equal(await probeSkew('https://x.test', { fetch: async () => { throw new Error('ENOTFOUND'); } }), null);
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  assert.equal(await probeSkew('https://x.test', { fetch: hang, timeoutMs: 20 }), null);
});

test('probeSkew against a real HTTP server', async () => {
  const server = createServer((req, res) => { res.setHeader('Date', new Date().toUTCString()); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const skew = await probeSkew(`http://127.0.0.1:${server.address().port}/`);
    assert.ok(skew !== null && Math.abs(skew) <= 1500, `${skew}`);
  } finally {
    server.close();
  }
});
