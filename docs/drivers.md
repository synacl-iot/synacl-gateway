# Built-in drivers

synacl-gateway 0.1 ships with three drivers. Each serves one platform protocol; the protocol is what you pick when you add a device in the Synacl app. This page lists, for each driver, the device settings (`conn`) and tag settings it reads, what it publishes, what "reachable" means for it, and every `reason` it can report.

Two things are true for every driver:

- **Values go out raw.** The scale factor and offset you set on a tag are applied by the platform. The gateway uses them only to evaluate the tag's alarm band locally.
- **A value the driver could not read is left out** of the reading. Nothing is ever published as `0` or `null` in its place. A reading with no values at all is not published.

The words in **bold** below are the labels in the app's *Add device* form; the code names in `monospace` are the keys the gateway receives in its configuration.

| App protocol | Driver name | `protocol` | Writes |
|---|---|---|---|
| Host metrics | `host` | `host` | no |
| Local MQTT bridge | `mqtt-bridge` | `mqtt-bridge` | not in 0.1 |
| Modbus TCP | `modbus-tcp` | `modbus-tcp` | FC05 / FC06 |

A device whose protocol no driver serves gets a retained status of `reachable: false` with the reason `unsupported protocol: <name>` and never publishes data. `synacl-gateway doctor` lists the protocols this gateway reported and the ones enabled for your account.

## Host metrics (`host`)

Reads the machine the gateway runs on. There is no address and no wiring: if the gateway is running, its host is running, so the device is **always reachable** and reports no reason.

### Device settings

| App label | Key | Meaning |
|---|---|---|
| **Sample Interval (ms)** | `sampleIntervalMs` | How often a reading is published. Default 10 000 ms; clamped to at least `minIntervalMs` from `config.json` (1 000 ms) and at most one hour. |

### Tag settings

| App label | Key | Meaning |
|---|---|---|
| **Metric** | `metric` | Which measurement this tag carries, from the table below. An empty metric falls back to the tag's name. |

The tag name is yours to choose; it becomes the key the value is published under.

### Metrics

| Metric | Unit | Where it comes from | Not available when |
|---|---|---|---|
| `cpu.temp` | °C | the CPU temperature sensor the OS exposes | no sensor is exposed (most VMs, many laptops, some containers) |
| `cpu.load` | % | CPU utilisation since the previous sample | — |
| `load.1m` | — | 1-minute load average | on Windows |
| `mem.used_pct` | % | (total − available) / total | — |
| `disk.used_pct` | % | space used on the filesystem holding `host.diskPath` (`/`, `C:` on Windows, `/data` in the Docker image) | no filesystem is found for the path |
| `uptime_s` | s | seconds since boot, whole seconds | — |
| `net.rx_bps` | bit/s | receive rate of the default network interface | there is no default interface, or on the very first sample |
| `net.tx_bps` | bit/s | transmit rate of the default network interface | as above |

Values are rounded to two decimals. `cpu.load` and `net.*` are rates: the driver takes a baseline when the device is opened, so the first scheduled reading is already a real figure — except the network rates, which can be missing from the first reading after a start and appear from the next one.

A metric that is unavailable on this machine is left out of the readings and logged once (`host: cpu.temp is unavailable on this machine (no CPU temperature sensor exposed on this machine); it is left out of the readings`). An unknown metric key is left out and logged once with the list of known keys. Run `synacl-gateway metrics` before adding the device: it prints each metric with its value, unit and source, or the reason it cannot be provided.

Per-tag errors (visible in the diagnostics snapshot and in a read-once acknowledgement) have the form `<metric>: <reason>`, for example `cpu.temp: no CPU temperature sensor exposed on this machine`, `load.1m: load average is not reported on Windows`, `net.rx_bps: needs a second sample`, `disk.used_pct: no filesystem found for /mnt/x`, `bogus: unknown host metric`.

`SYNACL_HOST_DISK_PATH` overrides `host.diskPath` (the Docker image sets it to `/data`).

## Local MQTT bridge (`mqtt-bridge`)

Subscribes to topics on a broker you already run — Tasmota, Shelly, zigbee2mqtt, Home Assistant, a PLC — and maps values from the messages onto a device's tags. Nothing changes on the local side.

### Device settings

| App label | Key | Meaning |
|---|---|---|
| **Local broker URL** | `brokerUrl` | `mqtt://host:1883`, `mqtts://host:8883`, `ws://…` or `wss://…` on your network. This is *not* the Synacl broker. Credentials in the URL (`mqtt://user:pw@host`) are accepted. |
| **Username** (optional) | `username` | Broker username. |
| **Password** (optional) | `password` | Broker password. It is registered with the log redactor before anything is logged. |
| **Sample Interval (ms)** | `sampleIntervalMs` | How often the latest values are forwarded to Synacl. Default 10 000 ms, same clamping as above. |
| — | `clientId` | MQTT client id on the local broker. Default `synacl-<gateway id>-<last 6 characters of the id of the first device that opened this connection>`. Not shown in the app. |
| — | `staleMs` | Report the device unreachable when nothing arrived on any of its topics for this long. `0` = never. Default `max(3 × interval, 300 000)` — five minutes is Tasmota's default telemetry period, so a plug on factory settings never flaps. Not shown in the app. |

One connection is opened per distinct (broker URL, username, password, client id) and shared by every device that points at it, so a fleet of plugs on one broker costs one local connection. The connection is clean-session; the driver reconnects itself with a backoff from 1 s to 30 s. TLS on the local broker is verified unless `bridge.rejectUnauthorized` is `false` in `config.json`.

### Tag settings

| App label | Key | Meaning |
|---|---|---|
| **Topic** | `topic` | The subscription filter on the local broker. `+` and `#` are allowed (`tele/+/SENSOR`). Tags of one device may listen on different topics. |
| **JSON Path** | `jsonPath` | Dot path into a JSON payload: `ENERGY.Power`, `sensors.0.temp` (a numeric segment indexes an array). Empty = the whole payload. |
| — | `cmdTopic` | Reserved for writes in a later release; ignored in 0.1. |

Unless you pick a catalog type for the tag, the app derives the tag name from topic and path (`tele/plug1/SENSOR` + `ENERGY.Power` → `tele_plug1_SENSOR_ENERGY_Power`). Either way the tag name is the key the value is published under.

### How values are picked

For every message that matches a tag's filter:

1. With a JSON path, the payload must be a JSON object or array; the value at the path is taken. A payload that is not JSON, or a path that is not in it, skips the message.
2. Without a path, a bare JSON number, string or boolean, or a plain-text payload such as Tasmota's `ON`, is taken as-is. A JSON object without a path is skipped — set a path to pick a field.
3. The value is normalised so the platform can store it and rules can compare it: `true`/`false` and `ON`/`OFF`/`true`/`false` in any case become `1`/`0`; numeric strings become numbers; other strings pass through, cut to 256 characters; objects, arrays and `null` are skipped.

Each skip is logged once per tag with a hint, for example `mqtt-bridge: tag "power" (device …, topic tele/plug1/SENSOR): the payload is a JSON object — set a JSON path to pick a field; skipping it`.

### When a reading is published

The driver is push-style: it keeps the latest value per tag as messages arrive. On each sample interval it publishes the tags that received a message since the previous interval. A tag that received nothing is left out; when no tag received anything, no reading is published at all, and the device stays reachable. A chatty local device is therefore throttled to the sample interval, never suspended. A **Read now** in the app answers from the latest value without waiting for a new message.

### Reachability and reasons

Reachability comes from the driver's own view of the local broker, checked on every read and every 30 s status:

| Reason | Meaning | Fix |
|---|---|---|
| `bridge/disconnected` | The local broker has been unreachable for more than 10 s (or the device was closed). | Check the broker URL, port and that the broker is up. The log line `mqtt-bridge: <url>: <error>` says what the connection attempt hit. |
| `bridge/no_message` | Nothing arrived on any of the device's topics for `staleMs`. | Check the topics (case, wildcards) with `mosquitto_sub -v -t '#'` on the broker; raise `staleMs` for a device that publishes rarely, or set it to `0`. |
| `mqtt-bridge device <id>: conn.brokerUrl is missing` / `… is not a valid URL` / `… scheme <x> is not supported (use mqtt:, mqtts:, ws: or wss:)` | The device could not be opened. | Fix the **Local broker URL** in the app. |

Per-tag problems: a filter that is not valid MQTT (`"#" must be the last level on its own`, `"+" must occupy a whole level`, `topic filter is empty`) leaves the tag unsubscribed, logged once; a read-once on a tag that has not received anything yet is acknowledged with `no message received yet on <topic>`; a subscription the broker refuses (its ACL) is logged once as `mqtt-bridge: <url> refused the subscription to "<filter>" (check the broker's ACL for this user)`.

### Limitations in 0.1

- One-way. Writes are not supported: a write command is acknowledged with `actuator writes are not supported for protocol "mqtt-bridge"` (or `modbus writes …`). `cmdTopic` is reserved for this.
- `staleMs` and `clientId` cannot be set in the app's device form in this release; the defaults above apply.
- Two devices with the same broker and credentials share one connection and one client id. Setting a `clientId` that another client on the broker already uses makes the broker disconnect them in turn.

## Modbus TCP (`modbus-tcp`)

Polls holding and input registers, coils and discrete inputs on Modbus TCP devices — PLCs, meters, and TCP-to-RTU bridges that front several serial units behind one IP address.

### Device settings

| App label | Key | Meaning |
|---|---|---|
| **Device IP Address** | `ip` | IP address or host name on the gateway's network. |
| **Device Port** | `port` | TCP port, default 502. |
| **Modbus Device ID** | `modbusId` | The unit (slave) id the device answers on, default 1. The driver accepts 0–255. Behind a bridge, each unit needs its own device with the same IP and its own id. |
| **Publish Interval (ms)** | `tickDuration` | How often a reading is published. Default 10 000 ms, same clamping as above. (`sampleIntervalMs` is accepted too.) |
| **Read Interval (ms)** | `readIntervalMs` | Optional. When shorter than the publish interval, the device is also read this often in between (not below 250 ms). Those extra reads feed the alarm bands and reachability only; they publish nothing. |

One TCP connection is opened per `ip:port` and shared by every device behind it; the unit id is set per request. Exactly one transaction is in flight at a time on a connection, because many devices and bridges handle one request at a time and drop or garble the rest. Each request is bounded by 3 s (the TCP connect too). After an error that is not a Modbus exception the connection is closed and the next transaction opens a fresh one.

### Tag settings

| App label | Key | Values | Meaning |
|---|---|---|---|
| **Modbus Address** | `mbAddress` | 0–65535 | The protocol address, used as-is (0-based). A register documented as `40001` is address `0`. |
| **Register Type** | `registerType` | `holding` (FC03), `input` (FC04), `coil` (FC01), `discrete` (FC02) | Which table to read. Default `holding`. Coils and discrete inputs read as `1`/`0`. |
| **Format** | `mbFormat` | `u16` (default), `s16`, `u32`, `s32`, `f32` | How the register value is encoded. The 32-bit formats read two consecutive registers. |
| **Word order** | `mbWordOrder` | `big` (default), `little` | For 32-bit formats: `big` (ABCD) is the Modbus convention, the register at the lower address is the high word; `little` (CDAB) is what some meters (e.g. the PZEM-004T) send. |

Decoding matches Synacl's ESP32 firmware bit for bit, so a tag configured once reads the same on either gateway, with two deliberate improvements: `u32`/`s32` are exact integers, and an `f32` that decodes to NaN or ±Infinity is left out of the reading instead of being published (the platform would drop the whole message). An `f32` is rounded to 7 significant digits, so `230.5000030517578` is published as `230.5`.

### How a read proceeds

The tags are read one by one over the shared connection. A tag that times out is retried once; an exception, a failed connect or a configuration error is not retried, because it would repeat itself. After a tag has timed out twice the remaining tags of that round are skipped (`skipped: the device did not answer an earlier tag`), so one dead unit cannot hold the shared connection for tags × 2 × 3 s. The driver logs only on change: one warning when tags start failing (`modbus-tcp: 192.168.1.50:502 unit 1 (device …): 2/5 tags failed (modbus/timeout)`) and one line when all of them read again.

### Reachability and reasons

The device is **reachable when at least one tag answered** in the last read. Otherwise the reason is the first of:

| Reason | Meaning | Fix |
|---|---|---|
| `TCP connect failed to <ip>:<port> (<code>)` | The connection was refused (`ECONNREFUSED`), the host is unreachable (`EHOSTUNREACH`), the name did not resolve (`ENOTFOUND`), … | Check the IP and port from a machine on the same LAN: `nc -vz <ip> 502`. A ping proves the device is on the network, not that a Modbus server listens on that port. |
| `modbus/timeout` | The TCP connect or a request got no answer within 3 s. The platform raises its own `modbus/timeout` event for this. | Usually a wrong port (the broker's `8883` is MQTT, not Modbus) or a wrong unit id behind a bridge; then the network path. |
| `modbus exception <n> (<name>) at <register>` | The device answered with an exception, e.g. `modbus exception 2 (illegal data address) at hr40`. | Check the address, register type and format against the device's register map. Names: 1 illegal function, 2 illegal data address, 3 illegal data value, 4 server device failure, 6 server device busy, 10 gateway path unavailable, 11 gateway target device failed to respond. |
| `no tag could be read` | Every tag failed for a reason that fits none of the above. | Look at the per-tag errors in the diagnostics snapshot. |
| `modbus-tcp device <id>: no valid device IP configured` / `port … is not a TCP port (1..65535)` / `modbusId … is not a unit id (0..255)` | The device could not be opened. | Fix the setting in the app. An unset address can only ever time out, so the driver says what is wrong instead. |

Register labels in reasons and logs are `hr<addr>` (holding), `ir<addr>` (input), `co<addr>` (coil), `di<addr>` (discrete) — the same labels the ESP32 firmware logs.

Per-tag errors: `<label>: address <n> is outside 0..65535`, `<label>: unknown register type "<x>"`, `<label>: f32 value is not a finite number (NaN or infinity)`, `skipped: the device did not answer an earlier tag`, `read cancelled` (the gateway was stopping).

### Writes

The app can command a write through this gateway; a write is acknowledged to the platform with the value written or an error.

| Command | Function | Accepted value |
|---|---|---|
| coil write | FC05 | any number; non-zero switches the coil on. The ack carries `1` or `0`. |
| holding register write | FC06 | one integer from −32768 to 65535; negatives are sent as two's complement. |

Not supported in 0.1: multi-register writes (FC15, FC16, an array value) — acknowledged with `multi-register writes not supported`; writes to input registers or discrete inputs — `<type> registers are read-only; only coil and holding can be written`; actuator-style writes — `actuator writes are not supported for protocol "modbus-tcp"`. A write that gets no answer is acknowledged with `no reply from <ip>:<port> unit <id> writing <label> (modbus/timeout)`.

### Trying it without hardware

A checkout of this repository includes a small Modbus TCP device: `node scripts/modbus-sim.js` listens on `127.0.0.1:1502`, answers every unit id, prints a ready-to-use tag list at start-up, moves the values a little every second, and prints writes as they arrive. Add a Modbus TCP device at that address in the app (the gateway and the simulator must run on the same machine, or use the machine's LAN address with `--host`). The script is not part of the npm package.
