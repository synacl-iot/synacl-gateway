# Writing a driver

A driver teaches synacl-gateway to read (and optionally write) one kind of equipment. It is an npm package that default-exports a driver definition; the gateway loads it in-process, hands it each device of the protocols it serves, calls `read` on the device's interval, and does everything else — pacing, publishing, buffering while offline, alarm bands, device status, commands and acknowledgements.

This page is the driver API, version 1, as implemented by synacl-gateway 0.1. The shapes are frozen in [`src/core/types.js`](../src/core/types.js); the smallest useful driver is in [`examples/drivers/synacl-driver-example`](../examples/drivers/synacl-driver-example) and is walked through at the end.

## The definition

```js
import { defineDriver, DriverError } from 'synacl-gateway/driver';

export default defineDriver({
  apiVersion: 1,
  name: 'synacl-driver-example',   // a non-empty string; used in logs and as the driverOptions key
  protocols: ['http'],             // the platform protocol name(s) this driver serves
  capabilities: {},                // optional, see below
  create(ctx) {
    return {
      async open(device) { /* … */ return handle; },
      async read(handle, tags, { reason, signal }) { /* … */ return { values, reachable: true }; },
      async write(handle, op) { /* optional */ },
      status(handle) { /* optional */ },
      async close(handle) { /* … */ },
    };
  },
});
```

`defineDriver` validates the definition when the package is imported and throws a `DriverError` naming every problem, so a malformed package fails at load time with a clear message instead of misbehaving inside the scheduler. `validateDriverDefinition(def)` returns the same list without throwing. `apiVersion` is `1`; the gateway refuses any other value.

**Protocols** are the platform's protocol names. The gateway includes them in the capability report it sends on every connect, and the Synacl app only offers a device protocol on a gateway that reported it — but the app has to know the protocol in the first place. A driver therefore usually serves a protocol the platform already has (the example serves `http`), or replaces a built-in: a driver listed in `config.json` that serves the same protocol as a built-in wins, with a warning in the log.

**Capabilities** are merged into the capability report: `modbusFormats: true` if the driver decodes the 32-bit Modbus formats, `sensorModels: { '<bus>': ['model', …] }` for sensor drivers. Anything else is ignored.

## `create(ctx)`

Called once, the first time a device of one of the driver's protocols is configured (never for a driver no device needs). It returns the driver instance. `ctx` holds:

| Field | What it is |
|---|---|
| `log` | A logger (`debug`/`info`/`warn`/`error(msg, fields?)`) whose lines carry the driver's category (`modbus` for protocols matching `modbus` or `rs485`, otherwise `sensors`). **`log.redact(secret)`** registers a string to be replaced by `***` in every line and field from then on; call it in `open()` for every credential in `device.conn` before logging anything. Fields whose key looks like a credential (`pass`, `secret`, `token`, `authorization`) and user-info in URLs are masked automatically. |
| `clock` | `{ now, setTimeout, clearTimeout, setInterval, clearInterval }`. Use it instead of the globals for every timer, so the conformance harness can drive the driver with a virtual clock. |
| `gatewayId` | The gateway id from `config.json`. |
| `dataDir` | A private writable directory for this driver: `$SYNACL_GATEWAY_HOME/driver-data/<name>` (mode 0700). |
| `signal` | An `AbortSignal` that is aborted when the gateway shuts down or restarts. Release long-lived resources (a pooled connection) on it. |
| `options` | Operator settings for this driver: the `driverOptions.<name>` object from `config.json` (built-ins get their `host` / `bridge` section instead). `{}` when unset. |

## The device

`open(device)` receives a `DeviceSpec` and returns whatever handle the driver wants; the gateway passes it back to `read`, `write`, `status` and `close` and never looks inside it.

| Field | What it is |
|---|---|
| `id` | The platform's device id (24 hex characters). |
| `protocol` | The device's protocol. |
| `conn` | The connection settings exactly as configured in the app. Its keys are protocol-specific; validate them in `open` and throw a clear error when they are unusable. |
| `tags` | The tags, each a `TagSpec` (below). |
| `intervalMs` | The publish interval the gateway will use. |
| `readIntervalMs` | `0`, or a shorter sampling interval the gateway will also read on. |
| `raw` | The device entry exactly as received. |

A `TagSpec` always has `name` (the key its value is published under) and every key the platform may omit, filled with the reference firmware's default: `isIntervalRead` `true`, `scaleFactor` `1`, `offset` `0`, `thresholdStart`/`thresholdEnd` `0`, `mbAddress` `0`, `registerType` `'holding'`, `mbFormat` `'u16'`, `mbWordOrder` `'big'`, `metric`/`topic`/`cmdTopic`/`jsonPath`/`sensorModel`/`bleField` `''`, `i2cAddress`/`canId`/`mbusRecord`/`initByte` `0`, `gpioPin` `-1`, `readBytes` `2`, `bigEndian` `true`. `tag.raw` is the tag object as received, for keys not in this list.

The gateway opens a device as soon as it is configured (so a push-style driver starts listening at once) and keeps the handle for as long as the device's protocol, `conn` and tags are unchanged; a changed device is closed and reopened. A failed `open` is retried by the next scheduled read.

## `read(handle, tags, { reason, signal })`

Called once per interval with the tags to read this time (`reason: 'interval'`) — the tags whose `isIntervalRead` is true — or with a single tag when the user pressed *Read now* in the app (`reason: 'once'`). It resolves to a `ReadResult`:

```js
{
  values:    { temp: 21.5, valve_open: 1 },       // keyed by tag.name
  errors:    { humidity: 'nothing at "sensor.humidity"' },   // optional, per tag, for logs and diagnostics
  reachable: true,
  reason:    'http/timeout',                       // optional, when reachable is false; ≤128 characters
}
```

Rules the gateway relies on (the harness checks them):

- **Only finite numbers, booleans and strings** may appear in `values`. A tag that could not be read is **absent** — never `null`, `NaN`, `Infinity` or a placeholder `0`. The platform drops a whole message that contains a `null`, and a placeholder reads as a real value on a chart.
- Return values only for the tags asked for; a single-tag read returns only that tag. (The gateway drops anything else, but do not rely on it.)
- Publish **raw** values. Scale factor and offset belong to the platform; the gateway applies them itself only to evaluate the tag's alarm band.
- `reachable` says whether the equipment answered. A device that is unreachable gets a retained status with your `reason`; the reason `modbus/timeout` has its own event type on the platform, so use exactly that string for a Modbus timeout.
- **Honour `signal`.** The gateway bounds a read at 0.8 × the interval, at most 10 s (5 s for a read-once), then aborts the signal and treats the read as a timeout. A read that keeps running anyway blocks further reads of that device and, after another 60 s, is abandoned; shutdown waits for it.
- A read may reject or throw; the gateway treats that as `reachable: false` with the error's `reason` (a `DriverError`) or `message`, cut to 128 characters. Returning a result is clearer.
- A read that returns no values does not publish a message. That is the right answer for a push-style driver with nothing new; the device stays reachable through `reachable`/`status`.

What happens next is the gateway's job: values go through the local alarm-band evaluation and out on the device's data topic (or into the store-and-forward buffer while offline); a change of `reachable` publishes the device status at once; after three unreachable reads in a row the retry delay doubles, up to `max(interval, 60 s)`.

Per-tag `errors` are what a user sees when a *Read now* fails (`no message received yet on tele/plug1/SENSOR`) and what the diagnostics snapshot lists as the device's last error, so make them specific.

## `status(handle)` (optional)

For push-style drivers, where "reachable" is not something a read finds out. Returns `{ reachable: boolean, reason?: string }` synchronously. The gateway consults it for the 30-second status heartbeat, for the diagnostics snapshot, and when a device has only on-demand tags (nothing to poll). `mqtt-bridge` uses it for `bridge/disconnected` and `bridge/no_message`.

## `write(handle, op)` (optional)

Called for a write command from the platform. `op` is one of

```js
{ kind: 'modbus', registerType: 'coil' | 'holding', address: 0…65535, value: number }
{ kind: 'actuator', value: number, dir?: 0 | 1 }
```

and the result is `{ ok: true, value?: number }` or `{ ok: false, error: string }`; the gateway turns it into the acknowledgement the platform is waiting for. A write is bounded at 10 s. **Leave `write` out entirely** when the driver cannot write: the gateway then acknowledges every write with `<kind> writes are not supported for protocol "<protocol>"` on its own.

## `close(handle)`

Called when the device leaves the configuration, changes, or the gateway stops. It must be **idempotent** (a second call for the same handle does nothing) and should settle within 5 s. Release a shared connection when its last device closes; the built-ins count references for this.

## Secrets

Anything in `device.conn` can be a credential (a broker password, an API token, an authorization header). Call `ctx.log.redact(value)` for each of them in `open` before the first log line that could contain it, and never put a credential in a `reason`, an `errors` message or a thrown error's message: reasons go to the platform as the device's status and appear in the app. The harness fails a driver if a `conn` value whose key matches `pass`, `secret`, `token` or `key` appears in any log line.

## Packaging

```json
{
  "name": "synacl-driver-example",
  "type": "module",
  "exports": "./index.js",
  "keywords": ["synacl-driver", "synacl-gateway"],
  "engines": { "node": ">=20.11" },
  "peerDependencies": { "synacl-gateway": ">=0.1.0 <1" },
  "devDependencies": { "synacl-gateway": ">=0.1.0 <1" }
}
```

- The package is an ES module: `"type": "module"`, or name the entry `.mjs`. (On Node 20, a `.js` file with `import`/`export` outside a `"type": "module"` package fails to load; the gateway's error says exactly that.)
- `synacl-gateway` is a **peer dependency**, so `synacl-gateway/driver` resolves next to the driver wherever it is installed; a dev dependency lets the driver's own tests import `synacl-gateway/testing`.
- Name it `synacl-driver-<protocol>` and add the `synacl-driver` keyword so it can be found on npm.

## Installing a driver on a gateway

A globally installed gateway cannot see other global packages, so drivers are installed into the gateway's own directory and named in `config.json`:

```sh
npm i --prefix ~/.synacl-gateway/drivers synacl-driver-example
```

then in `~/.synacl-gateway/config.json`:

```json
"drivers": ["synacl-driver-example"],
"driverOptions": { "synacl-driver-example": { "timeoutMs": 8000 } }
```

and reload the gateway (`sudo systemctl reload synacl-gateway`, or `kill -HUP <pid>`); a changed `drivers` list restarts the gateway in-process. `driverDir` in `config.json` moves the directory. An entry may also be a path — absolute, or `./`/`../` relative to the gateway home — to a package directory or a single file, which is convenient while developing.

Load problems are logged at start-up and never stop the gateway; devices of the missing protocol are reported `unsupported protocol: <name>`:

| Log line | Meaning |
|---|---|
| `driver "x" not loaded: cannot find package "x" under …/drivers (install it with: npm i --prefix …/drivers x)` | Not installed where the gateway looks. |
| `driver "x" not loaded: it imports synacl-gateway, which is not installed next to it (run: npm i --prefix …/drivers synacl-gateway)` | The peer dependency was not installed (older npm, or `--omit=peer`). |
| `driver "x" not loaded: … is an ES module: name it .mjs or add "type": "module" to its package.json` | See Packaging. |
| `driver "x" refused: apiVersion must be 1 …` | The definition failed validation; the message lists every problem. |
| `driver "x" (x) replaces "host" (builtin) for protocol "host"` | Intended: a third-party driver overrides a built-in. |
| `driver x: create() failed: …` | `create(ctx)` threw; the driver is disabled for this run. |

## Testing a driver

`synacl-gateway/testing` exports the contract harness the gateway's own drivers are tested with:

```js
import { test } from 'node:test';
import { assertDriver } from 'synacl-gateway/testing';
import driver from './index.js';

test('honours the driver contract', () => assertDriver(driver, {
  device: { conn: { url: 'http://127.0.0.1:8080/state', authHeader: 'Bearer t0ken' }, tags: [{ name: 'temp', jsonPath: 'sensor.temp' }] },
  secrets: ['Bearer t0ken'],      // strings that must never appear in a log line (conn keys matching pass/secret/token/key are added automatically)
  options: {},                    // ctx.options
  reads: 2,                       // scheduled reads to perform (default 2)
  write: { kind: 'modbus', registerType: 'coil', address: 0, value: 1 },   // exercises write() when the driver has one
  timeoutMs: 10_000,
}));
```

`assertDriver` throws an `AssertionError` listing every failed check; `testDriver` returns `{ ok, name, checks, logs }` instead. The checks, in order: `shape`, `api-version`, `create`, `open`, `read.1`…`read.n` (a valid `ReadResult`: finite values only, no unrequested tags, `reachable` a boolean, `reason` ≤128 characters), `read-tags` (a single-tag read returns only that tag), `abort` (an aborted read settles promptly), `write` (when requested and present), `status` (when present), `close`, `close-idempotent`, `secrets`. Also exported: `createMemoryLogger()` (a logger that keeps its lines, for your own tests, as in the example's second test), `tagSpec()` and `deviceSpec()` to build specs with the documented defaults, and `readResultProblems(result, tags)`.

The CLI runs the same checks on an installed package or a path:

```sh
synacl-gateway conformance --driver synacl-driver-example      # from ~/.synacl-gateway/drivers
synacl-gateway conformance --driver ./path/to/my-driver          # a directory or file
```

It exits `0` when the driver honours the contract and `4` when it does not, printing `[pass]`/`[FAIL]` per check (`--json` for a report). **Note:** the CLI has no way to pass connection settings, so it opens the driver with an empty `conn` and one tag named `value`. A driver that refuses to open without its settings — as the example does, and as a careful driver should — fails the `open` check there; the full check with real settings is the `assertDriver` test in your own suite. Both are worth running: the CLI proves the package installs and loads where the gateway will look for it.

## The example, step by step

[`examples/drivers/synacl-driver-example`](../examples/drivers/synacl-driver-example) serves the protocol `http`: it fetches a URL that returns JSON and publishes one value per tag, picked with the tag's `jsonPath` — the same dot notation the platform uses elsewhere.

- **`package.json`** — `"type": "module"`, `synacl-gateway` as a peer dependency and, for `npm test`, as a dev dependency pointing at the repository checkout (`file:../../..`). `npm install` links the harness.
- **`index.js`** — `open` validates `conn.url`, defaults `method` and `timeoutMs`, and calls `ctx.log.redact(authHeader)` because the header is a credential. `read` makes one request per read; the timeout runs on `ctx.clock`, and the gateway's `signal` aborts the request as well. A non-2xx answer is `reachable: false` with `http/<status>`; a network error or timeout is `reachable: false` with `http/timeout` or `http request failed: <code>`; a 2xx answer is `reachable: true` with one value per tag whose path leads to a number, boolean or string, and an `errors` entry for each tag it does not. `walkPath` follows own properties only and never `__proto__`, `constructor` or `prototype`: the JSON comes from a device on your network. `close` has nothing to release.
- **`test.js`** — starts a local HTTP server that requires the header, runs `assertDriver` against it with the header as a declared secret, and then drives the instance by hand with `createMemoryLogger()` to assert the exact values read and that a missing path leaves its tag out.

Run it from a checkout of this repository:

```sh
cd examples/drivers/synacl-driver-example
npm install
npm test
```

To use it on a gateway, add an HTTP device in the app with `url` (and optionally `authHeader`, `method`, `timeoutMs`) in its connection settings and a `jsonPath` per tag, install the package as shown above, and list it in `config.json`.
