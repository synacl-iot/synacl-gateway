# Architecture

This document describes how synacl-gateway is put together and the rules it follows. The wire contract itself — topics, payloads, schemas — is specified at [synacl.com/protocol](https://synacl.com/protocol/) and vendored in [`protocol/v1/`](../protocol/v1/). The interfaces between modules are frozen in [`src/core/types.js`](../src/core/types.js).

## Module map

```
bin/synacl-gateway.js ──► src/cli/*            init · run · status · metrics · conformance · doctor · service
                              │
                              ▼
                        src/core/gateway.js    the lifecycle state machine; wires everything below
   ┌──────────────┬──────────┴─────┬──────────────┬───────────────┬──────────────┐
transport.js   config-sync.js   scheduler.js   presence.js    commands.js    debug.js
(MQTT, never   (request/reply/  (per-device    (heartbeat,    (gateway +     (diag snapshot,
 queues)        push, chunks)    timers)        device status) device cmds)   live log tail)
                   │                 │
            config-model.js     drivers (src/drivers/*) ──► publisher.js ──► transport / backfill.js
            (normalise +                                   (validate +       (disk ring,
             defaults)          thresholds.js ◄────────────  route)           paced replay)
state.js (config bytes, overrides, seq, runtime, lock) · clock.js · log.js (redaction) · schemas.js · topics.js · fnv.js · capabilities.js
```

Every module is a factory that receives its collaborators as arguments. Nothing reaches for a singleton, so the conformance suite can run the real core against an in-memory broker, a scripted platform and a virtual clock.

## Lifecycle

1. **Boot.** Load `config.json`, take the per-gateway lock, load state. If a previously applied device configuration is on disk, start the devices immediately — while offline their readings go to the store-and-forward buffer.
2. **Connect.** One MQTT connection, client id = gateway id, clean session, keepalive 60 s, Last Will `{"online":false}` retained at QoS 1 on `{prefix}/status`. Our own reconnect backoff (1 s doubling to 60 s, ±20 % jitter). Nothing is ever queued inside the MQTT client: messages published while offline would be flushed as one burst on reconnect, which the platform counts as rate violations.
3. **Online.** Subscribe to the seven downlink filters and check the SUBACK (a refused filter means the gateway id or account in `config.json` does not match the credential). Publish the retained heartbeat (without `ts`, so the platform uses its own clock), then the capability report, then — two seconds later — `config/request {hash}`.
4. **Configuration.** The reply is either `{"unchanged":true}`, the full device list, or (only when `configCap` is set) one chunk of it. The gateway hashes the **exact bytes it received** (FNV-1a 32-bit), stores those bytes, applies the devices, and immediately sends `config/request` again with the new hash: only the `unchanged` answer to that request tells the platform the gateway is in sync. The same path handles configuration the platform pushes unprompted. The request is retried after 10, 20, 40 and 80 seconds when nothing comes back, then every 10 minutes — never on a fixed timer, because every request has side effects on the platform.
5. **Running.** Each device is read on its own interval; readings are published on `devices/{id}/data`; a retained `devices/{id}/status` goes out at least every 30 s (the platform marks a device offline after 90 s of silence); the gateway heartbeat goes out every 60 s.
6. **Offline.** Timers that talk to the platform stop; device reads continue and go to the buffer. After the connection has been stable for 10 s the buffer drains on `data/backfill`: at most 40 records and 3,500 bytes per batch, one batch per second, oldest first. Buffered readings never go to the live topic.
7. **Shutdown.** Publish `{"online":false}` (retained, QoS 1), disconnect cleanly, close drivers, save state, release the lock. A `restart` command from the platform does the same and starts over **inside the same process**, so it works without a service manager.

## Rules that keep a gateway in good standing

- **One data message per device per interval**, timestamps at least one interval apart. Devices start on staggered phases so a gateway with many devices doesn't hit the account's messages-per-second window all at once. The platform measures arrival gaps; repeated violations suspend the device, and the gateway is not told.
- **Only finite values.** A tag that could not be read is left out of the message. A `null` or `NaN` anywhere makes the platform drop the whole message.
- **Read-once is serialised per device.** The reply to `read/once` is a data message carrying only that tag, published immediately and followed by the acknowledgement; a scheduled read of the same device never runs concurrently.
- **Raw values on the wire.** Scale factor and offset are applied by the platform. The gateway applies them only to evaluate the tag's alarm band locally.
- **Defaults are part of the contract.** The platform omits a tag key when it equals the reference firmware's default; the gateway fills it back in (`isIntervalRead` true, `registerType` holding, `mbFormat` u16, `mbWordOrder` big, `scaleFactor` 1, `offset` 0, thresholds 0/0 = no band).
- **Credentials stay secret.** The broker password and every local-broker password are registered with the logger's redactor; files holding them are created with mode 0600.

## Drivers

A driver serves one or more platform protocols. Built-ins: `host`, `mqtt-bridge`, `modbus-tcp`. Third-party drivers are npm packages listed in `config.json` (`drivers`), installed under `~/.synacl-gateway/drivers`, loaded in-process with full trust. The API (`synacl-gateway/driver`, `apiVersion: 1`):

```js
export default defineDriver({
  apiVersion: 1, name: 'my-driver', protocols: ['http'],
  capabilities: {},                                   // merged into the capability report
  create(ctx) {                                       // { log, clock, gatewayId, dataDir, signal, options }
    return {
      async open(device) { return handle },           // device: { id, protocol, conn, tags, intervalMs }
      async read(handle, tags, { reason, signal }) {  // reason: 'interval' | 'once'
        return { values: { [tag.name]: 21.5 }, reachable: true }
      },
      async write(handle, op) { return { ok: false, error: 'not supported' } },   // optional
      async close(handle) {},
    };
  },
});
```

`synacl-gateway conformance --driver <package>` checks a driver against this contract.

## Conformance

`synacl-gateway conformance --offline` runs the real gateway core against an in-memory broker, a scripted platform that follows the documented behaviour, and a virtual clock. It checks the connection sequence, configuration handling (full, unchanged, chunked, oversized, pushed unprompted), pacing over a simulated half hour, commands and acknowledgements, an outage with store-and-forward replay, and that every message it sends validates against the published schemas. The same scenarios are this project's test suite.
