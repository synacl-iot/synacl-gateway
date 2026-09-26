// src/core/types.js — the frozen interfaces between modules. JSDoc only; no runtime code.
//
// Every module in src/ is written against these shapes so that the core, the drivers, the
// conformance harness and the CLI can be built in parallel and meet in the middle. Changing
// a shape here changes a contract: only the maintainer edits this file, and a change lands
// together with every module it touches. See docs/ARCHITECTURE.md for how the pieces fit.

// ─── Logging ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {'debug'|'info'|'warn'|'error'} LogLevel
 *
 * Log categories double as the remote live-log filter. On the wire (`debug/logs/start {cats}`)
 * they are a bitmask: system 1 · network 2 · commands 4 · modbus 8 · sensors 16 · macros 32.
 * `system` is always included.
 * @typedef {'system'|'network'|'commands'|'modbus'|'sensors'|'macros'} LogCategory
 *
 * @typedef {Object} Logger
 * @property {(msg: string, fields?: Object) => void} debug
 * @property {(msg: string, fields?: Object) => void} info
 * @property {(msg: string, fields?: Object) => void} warn
 * @property {(msg: string, fields?: Object) => void} error
 * @property {(category: LogCategory) => Logger} child  A logger whose lines carry `category`.
 * @property {(secret: string) => void} redact  Register a string (a password) to be replaced by
 *   `***` in EVERY line and field from now on. Credentials never reach stdout, files or the wire.
 * @property {(listener: (line: LogLine) => void) => () => void} tap  Subscribe to redacted lines
 *   (used by the live-log tail and the diagnostics ring); returns an unsubscribe function.
 *
 * @typedef {Object} LogLine
 * @property {number} ts
 * @property {LogLevel} level
 * @property {LogCategory} category
 * @property {string} msg  Already redacted.
 */

// ─── Time ───────────────────────────────────────────────────────────────────────────────

/**
 * Every timer in the gateway goes through a Clock, never the globals. Production uses the real
 * clock; conformance uses a VirtualClock whose `advance(ms)` runs due timers in order, so a
 * 30-minute scenario runs in milliseconds.
 * @typedef {Object} Clock
 * @property {() => number} now  Epoch milliseconds (integer).
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 * @property {(fn: () => void, ms: number) => unknown} setInterval
 * @property {(handle: unknown) => void} clearInterval
 */

// ─── Transport ──────────────────────────────────────────────────────────────────────────

/**
 * MqttTransport (mqtt.js) in production, MemoryTransport in conformance. The one place MQTT
 * client options live. It NEVER queues: `publish` rejects while disconnected (mqtt.js would
 * otherwise replay everything published offline as one burst on reconnect, which the platform
 * counts as rate violations and can suspend devices for).
 *
 * Events: 'connect' () · 'close' () · 'message' (topic: string, payload: Buffer, info: {retain: boolean})
 *         'error' (err: Error) · 'connack-refused' (code: number)
 * @typedef {Object} Transport
 * @property {boolean} connected
 * @property {(opts: TransportConnectOptions) => void} connect  Starts connecting; reconnection and
 *   backoff are the caller's job (the gateway core), not the transport's.
 * @property {(topic: string, payload: Buffer|string, opts?: {qos?: 0|1, retain?: boolean}) => Promise<void>} publish
 *   Resolves when written (QoS 0) or acknowledged (QoS 1). Rejects when not connected.
 * @property {(filters: string[], qos?: 0|1) => Promise<number[]>} subscribe  Granted QoS per filter,
 *   in order; 128 (0x80) means the broker refused it — the only in-band sign of an ACL mismatch.
 * @property {(graceful?: boolean) => Promise<void>} end  graceful=true sends DISCONNECT (no Last Will).
 * @property {(event: string, fn: Function) => void} on
 * @property {(event: string, fn: Function) => void} off
 *
 * @typedef {Object} TransportConnectOptions
 * @property {string} url  mqtt:// mqtts:// ws:// wss://
 * @property {string} clientId  The gateway id. One live connection per gateway id.
 * @property {string} username
 * @property {string} password
 * @property {number} keepalive  Seconds.
 * @property {{topic: string, payload: string, qos: 1, retain: true}} will
 * @property {Buffer|string} [ca]
 * @property {boolean} rejectUnauthorized
 */

// ─── Configuration written by `init` (config.json) ──────────────────────────────────────

/**
 * `$SYNACL_GATEWAY_HOME/config.json` (default `~/.synacl-gateway/config.json`), mode 0600.
 * @typedef {Object} FileConfig
 * @property {1} schema
 * @property {string} broker  e.g. "mqtts://mqtt.synacl.com:8883"
 * @property {string} tenant  24-hex account id (the OWNER's id, which is what Connection Info shows).
 * @property {string} gateway  Gateway id (chip id), `^[A-Za-z0-9][A-Za-z0-9_.:-]{2,63}$`.
 * @property {string} username
 * @property {string} password
 * @property {string|null} api  Platform REST base, derived from the broker host (`mqtt.X` → `https://api.X`).
 * @property {{caFile: string|null, rejectUnauthorized: boolean}} tls
 * @property {string[]} drivers  Extra driver packages (npm names or absolute paths).
 * @property {string|null} driverDir  Where extra drivers are installed (default `$HOME/.synacl-gateway/drivers`).
 * @property {number|null} configCap  Opt-in chunked config pull (bytes per MQTT message). null = off.
 * @property {number} minIntervalMs  Floor for every device interval (default 1000, never below 250).
 * @property {{maxBytes: number, maxAgeHours: number, batchIntervalMs: number}} backfill
 * @property {{diskPath: string}} host  Filesystem the host driver reports as `disk.used_pct`.
 * @property {{rejectUnauthorized: boolean}} bridge  TLS verification for local brokers.
 * @property {{level: LogLevel, format: 'auto'|'text'|'json'}} log
 * @property {string} createdAt  ISO timestamp.
 */

// ─── The device model (normalised from a config/push document) ──────────────────────────

/**
 * One tag, with the platform's omitted-at-default keys filled back in (config-model.js). The
 * platform leaves a key out when it equals the reference firmware's default, so these defaults
 * are part of the contract: isIntervalRead TRUE, registerType 'holding', mbFormat 'u16',
 * mbWordOrder 'big', scaleFactor 1, offset 0, thresholds 0/0 (= no band), strings ''.
 * @typedef {Object} TagSpec
 * @property {string} name  The key its values are published under. Always present.
 * @property {boolean} isIntervalRead  false = only read on demand (`read/once`).
 * @property {number} scaleFactor  Engineering value = raw × scaleFactor + offset (used locally for thresholds only; raw is published).
 * @property {number} offset
 * @property {number} thresholdStart  [0, 0] = no band.
 * @property {number} thresholdEnd
 * @property {number} mbAddress
 * @property {'holding'|'input'|'coil'|'discrete'} registerType
 * @property {'u16'|'s16'|'u32'|'s32'|'f32'} mbFormat
 * @property {'big'|'little'} mbWordOrder
 * @property {string} metric  host driver: which host metric.
 * @property {string} topic  mqtt-bridge: local topic filter (+ and # allowed).
 * @property {string} cmdTopic  mqtt-bridge: reserved (writes are not supported in 0.1).
 * @property {string} jsonPath  mqtt-bridge: dot path into a JSON payload; numeric segments index arrays.
 * @property {Object} raw  The tag object exactly as received (for drivers of other protocols).
 *
 * @typedef {Object} DeviceSpec
 * @property {string} id  The platform's device id (24 hex); data/status/ack topics use it.
 * @property {string} protocol
 * @property {Object} conn  Verbatim from the config document.
 * @property {TagSpec[]} tags
 * @property {number} intervalMs  Effective publish interval: override ?? conn.sampleIntervalMs ??
 *   conn.tickDuration (ms) ?? 10000, clamped to [max(250, minIntervalMs), 3600000].
 * @property {number} readIntervalMs  0 = read once per publish interval.
 * @property {string} fingerprint  Canonical JSON of {protocol, conn, tags}; equal ⇒ the running driver handle is kept.
 * @property {Object} raw  The device entry exactly as received.
 */

// ─── Driver plugin API v1 (src/drivers/api.js `defineDriver` validates this) ────────────

/**
 * @typedef {Object} DriverDefinition
 * @property {1} apiVersion
 * @property {string} name  e.g. "host", "synacl-driver-foo".
 * @property {string[]} protocols  Platform protocol names this driver serves.
 * @property {{modbusFormats?: boolean, sensorModels?: Object}} [capabilities]  Merged into the capability report.
 * @property {(ctx: DriverContext) => DriverInstance} create
 *
 * @typedef {Object} DriverContext
 * @property {Logger} log  Category-scoped and redacting.
 * @property {Clock} clock
 * @property {string} gatewayId
 * @property {string} dataDir  A private writable directory for this driver.
 * @property {AbortSignal} signal  Aborted on shutdown / restart.
 * @property {Object} options  The relevant FileConfig section (e.g. `host`, `bridge`).
 *
 * @typedef {Object} DriverInstance
 * @property {(device: DeviceSpec) => Promise<unknown>} open  Returns an opaque handle.
 * @property {(handle: unknown, tags: TagSpec[], opts: {reason: 'interval'|'once', signal: AbortSignal}) => Promise<ReadResult>} read
 * @property {(handle: unknown, op: WriteOp) => Promise<WriteResult>} [write]
 * @property {(handle: unknown) => {reachable: boolean, reason?: string}} [status]  For push-style drivers.
 * @property {(handle: unknown) => Promise<void>} close  Idempotent.
 *
 * @typedef {Object} ReadResult
 * @property {Object<string, number|boolean|string>} values  Keyed by TagSpec.name. Finite numbers only;
 *   a tag that could not be read is ABSENT (never null/NaN/0) — the platform drops a whole message
 *   that contains a null.
 * @property {Object<string, string>} [errors]  Per-tag reason, for logs and diagnostics.
 * @property {boolean} reachable
 * @property {string} [reason]  ≤128 chars. 'modbus/timeout' and 'link/weak' have their own event types.
 *
 * @typedef {{kind: 'modbus', registerType: 'coil'|'holding', address: number, value: number}
 *         | {kind: 'actuator', value: number, dir?: number}} WriteOp
 * @typedef {{ok: boolean, value?: number, error?: string}} WriteResult
 */

// ─── Readings and module contracts ──────────────────────────────────────────────────────

/**
 * @typedef {Object} Reading
 * @property {string} deviceId
 * @property {number} ts  Integer epoch ms, taken when the read started.
 * @property {Object<string, number|boolean|string>} values  ≥1 key.
 * @property {number} [seq]
 */

/*
 * Module contracts (factory → instance). Each module takes its collaborators as arguments —
 * no module imports another module's singleton — so tests and conformance can wire fakes.
 *
 *  topics.js        createTopics({tenant, gateway}) → { prefix,
 *                     up(name: string, deviceId?: string): string,          // name = topics.json id
 *                     subscriptions(): string[],                            // the 7 downlink filters
 *                     parseDown(topic: string): {kind: string, deviceId?: string} | null }
 *  fnv.js           fnv1a32(bytes: Uint8Array|string): number               // uint32
 *  schemas.js       createValidators(protocolDir: string) →
 *                     { validate(schema: string, value: unknown): {ok: boolean, errors: string[]},
 *                       names(): string[] }                                  // plain Ajv: no removeAdditional/useDefaults
 *  state.js         openState({home, tenant, gateway, clock}) → { dir,
 *                     lock(): void, unlock(): void,                          // throws LockHeldError
 *                     readConfigRaw(): {bytes: Buffer, meta: Object} | null,
 *                     writeConfigRaw(bytes: Buffer, meta: Object): void,     // atomic
 *                     clearConfig(): void,
 *                     readOverrides(): Object, writeOverrides(o: Object): void,
 *                     readSeq(): Object, writeSeq(s: Object): void,
 *                     writeRuntime(r: Object): void, readRuntime(): Object | null }
 *  config-model.js  normalizeConfig(doc: Object, {overrides, minIntervalMs}) → {devices: DeviceSpec[], errors: string[]}
 *  config-sync.js   createConfigSync({transport, topics, state, clock, log, configCap, onApply}) →
 *                     { onConnected(): void, onDisconnected(): void,
 *                       onMessage(buf: Buffer): void,                        // config/push payloads only
 *                       requestNow(reason: string): void, currentHash(): number, synced(): boolean, stop(): void }
 *                     onApply(bytes: Buffer, doc: Object, hash: number): Promise<void>
 *  publisher.js     createPublisher({transport, topics, validators, backfill, clock, log, strict}) →
 *                     { data(reading: Reading): Promise<'live'|'backfill'|'dropped'>,
 *                       deviceStatus(deviceId, {reachable, reason?}): Promise<void>,
 *                       alert(deviceId, alert: Object): Promise<void>,
 *                       ack(deviceId, ack: Object): Promise<void>,
 *                       gateway(name: string, body: Object, opts?: {qos?, retain?}): Promise<void> }  // status, firmware/response, config/request, debug/*, macro/run/status, data/backfill
 *  backfill.js      createBackfill({dir, clock, log, limits}) → { append(record): void, drainTick(send: (batch) => Promise<void>): Promise<number>,
 *                     stats(): {records, bytes, dropped, writeErrors}, close(): void }
 *  scheduler.js     createScheduler({clock, log, drivers, publisher, thresholds, state, minIntervalMs}) →
 *                     { apply(devices: DeviceSpec[]): Promise<void>, readOnce(deviceId, tag, correlationId): Promise<void>,
 *                       setInterval(deviceId, ms): void, pause(deviceId, mode, durationMs?): void, resume(deviceId): void,
 *                       write(deviceId, op: WriteOp): Promise<WriteResult>, snapshot(): Object[], stop(): Promise<void> }
 *  presence.js      createPresence({publisher, clock, getDevices, getHeartbeatExtras}) →
 *                     { start(): void, stop(): void, heartbeatNow(): Promise<void>, transition(deviceId, {reachable, reason?}): void }
 *  thresholds.js    createThresholds({publisher, clock}) → { evaluate(device: DeviceSpec, values, ts): void,
 *                     resetDevice(deviceId): void, reconcile(prev: DeviceSpec[], next: DeviceSpec[]): void, flushQueued(): Promise<void> }
 *  capabilities.js  buildCapabilities({version, gatewayId, drivers, configCap}) → Object   // the firmware/response report
 *  commands.js      createCommands({scheduler, lifecycle, debug, capabilities, publisher, log}) → { onMessage(kind, deviceId, buf): Promise<void> }
 *                     lifecycle = { restart(): Promise<void>, resetConfig(): Promise<void>, setSim(on: boolean): void }
 *  debug.js         createDebug({publisher, log, clock, snapshot}) → { diag(correlationId): Promise<void>, startLogs(cats): void, stopLogs(): void }
 *  gateway.js       createGateway({config: FileConfig, home, transport?, clock?, drivers?, log?}) →
 *                     { start(): Promise<void>, stop(): Promise<void>, restart(): Promise<void>, status(): Object }
 */

export {};
