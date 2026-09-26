// synacl-driver-example — the smallest useful synacl-gateway driver.
//
// Protocol `http`: fetch a URL that returns JSON and publish one value per tag, picked with the
// tag's dot-notation `jsonPath` (numeric segments index arrays) — the same notation the
// platform uses for HTTP sources.
//
//   conn: { url, method = 'GET', authHeader?, timeoutMs = 5000 }
//   tag:  { name, jsonPath }
//
// Install next to a gateway:   npm i --prefix ~/.synacl-gateway/drivers synacl-driver-example
// then list it in config.json:  "drivers": ["synacl-driver-example"]
// and check it:                 synacl-gateway conformance --driver synacl-driver-example

import { defineDriver } from 'synacl-gateway/driver';

// Own properties only, and never a prototype key: the JSON comes from a device on your network.
function walkPath(value, path) {
  let cur = value;
  for (const key of path.split('.')) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

// The platform accepts finite numbers, booleans and strings; anything else is left out.
const publishable = (v) => (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || typeof v === 'string';

export default defineDriver({
  apiVersion: 1,
  name: 'synacl-driver-example',
  protocols: ['http'],
  capabilities: {},

  create(ctx) {
    return {
      async open(device) {
        const { url, method = 'GET', authHeader, timeoutMs = 5000 } = device.conn ?? {};
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('conn.url must be an http(s) URL');
        // Headers are credentials: register them so they never reach a log line.
        if (authHeader) ctx.log.redact(authHeader);
        return { url, method, authHeader, timeoutMs: Number(timeoutMs) || 5000 };
      },

      async read(handle, tags, { signal }) {
        // One request per read; give up at timeoutMs or when the gateway cancels the read.
        // The timer goes through ctx.clock so the gateway's test clock controls it.
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = ctx.clock.setTimeout(() => ac.abort(), handle.timeoutMs);
        try {
          if (signal?.aborted) return { values: {}, reachable: false, reason: 'read cancelled' };
          const res = await fetch(handle.url, {
            method: handle.method,
            headers: handle.authHeader ? { Authorization: handle.authHeader } : {},
            signal: ac.signal,
          });
          if (!res.ok) return { values: {}, reachable: false, reason: `http/${res.status}` };
          const body = await res.json();
          const values = {};
          const errors = {};
          for (const tag of tags) {
            const v = tag.jsonPath ? walkPath(body, tag.jsonPath) : undefined;
            if (publishable(v)) values[tag.name] = v;
            else errors[tag.name] = tag.jsonPath ? `nothing publishable at "${tag.jsonPath}"` : 'no jsonPath set';
          }
          return { values, errors, reachable: true };
        } catch (err) {
          const reason = ac.signal.aborted ? 'http/timeout' : `http request failed: ${err.cause?.code ?? err.message}`;
          ctx.log.warn(`synacl-driver-example: ${handle.method} ${new URL(handle.url).origin}: ${reason}`);
          return { values: {}, reachable: false, reason: reason.slice(0, 128) };
        } finally {
          ctx.clock.clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
      },

      async close() {},
    };
  },
});
