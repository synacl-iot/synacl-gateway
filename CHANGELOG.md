# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `status` no longer reports a dead gateway as running after a container restart or a reboot. The lock file now records when its process started (on Linux from `/proc`, on macOS and BSD from `ps`), so a pid that was handed to a different process — the old gateway's pid 1 or 7 in a restarted container, any pid after a reboot — is recognized: `status` says `not running (stale lock file: pid N is now a different process)` and leaves the file for `run` to take over. The same check stops `run` from refusing to start (exit 6) behind such a lock, and `init` and `doctor` from calling the gateway running. A lock written by 0.1.0, or on Windows, keeps the previous pid-only check.
- `status` right after a restart no longer shows the previous run's uptime, version and connection as the new process's: until the new process writes its first snapshot it says `running (pid N, starting up)` and marks the values as the last run's. `status --json` adds `runtimeCurrent` and `staleLock`.

## [0.1.0] - 2026-09-28

The first release: a complete gateway for the Synacl Gateway Protocol v1, with three drivers, a driver API, a CLI, and a conformance suite.

### Added

**Gateway core**
- One MQTT connection per gateway (client id = gateway id, clean session, keepalive 60 s, retained Last Will `{"online":false}`), over `mqtt://`, `mqtts://`, `ws://` or `wss://`, with TLS verified by default and a `--ca` option for private brokers.
- Reconnect with exponential backoff (1 s to 60 s, ±20 % jitter; 5 minutes after the broker rejects the credentials or a subscription), and detection of a second instance with the same gateway id (session takeover) and of a tenant/gateway mismatch (refused subscriptions).
- Device configuration sync: hash of the exact bytes received (FNV-1a), stored on disk, applied at boot before the connection is up, confirmed with the platform after every apply, opt-in chunked transfer for large configurations, unprompted pushes applied without a reconnect.
- Per-device scheduling on the platform's pacing rules: one message per interval, timestamps never closer than an interval, staggered start, backoff after repeated failures, a separate faster read interval for local alarm bands, and read-once handled outside the interval check.
- Commands: read now, set interval, pause (manual, timed, until restart) and resume — persisted across restarts —, Modbus coil and register writes, restart, configuration reset, simulation mode, diagnostics snapshot and live log tail with category mask and rate limit. Unknown commands and retained commands are ignored; macros are refused; firmware update requests are logged (updates come from npm).
- Presence: heartbeat every 60 s without a timestamp (a wrong clock can never make the gateway look offline), per-device retained status every 30 s and on every change, `{"online":false}` published on a clean stop.
- Store-and-forward: readings taken while offline (or while a device's live publish is backlogged) are appended to a disk buffer and replayed on `data/backfill` after the connection has been stable for 10 s — at most 40 records and 3 500 bytes per batch, one batch per second, oldest first, never on the live topic. Limits: 64 MiB and 7 days by default.
- Local alarm bands: each tag's threshold band evaluated at the edge in engineering units, edge-triggered (`THRESHOLD_VIOLATION` / `THRESHOLD_CLEARED`), reset on band change and on unreachability, queued while offline.
- Logging with categories, levels, JSON or text output, a diagnostics ring, and redaction of every registered secret, credential-looking field and URL user-info before a line is written anywhere.
- Clock-skew check against the platform API at start-up and every six hours; readings are not buffered while the clock is obviously unset.
- Single-instance lock per gateway id with safe takeover of locks left by another host or an earlier container.
- `SIGHUP` reload: re-reads `config.json`; changed connection settings restart the gateway in-process, otherwise the device configuration is requested again.

**Drivers**
- `host` — CPU temperature and load, load average, memory, disk (`host.diskPath`), uptime and network throughput of the machine the gateway runs on; unavailable metrics are left out rather than published as 0.
- `mqtt-bridge` — topics on a local broker (Tasmota, zigbee2mqtt, Home Assistant, …) mapped onto device tags with MQTT filters and dot-path JSON extraction; pooled connections per broker and credentials; own reconnect; `bridge/disconnected` and `bridge/no_message` reachability.
- `modbus-tcp` — holding and input registers, coils and discrete inputs; `u16`, `s16`, `u32`, `s32`, `f32` with big or little word order, decoded exactly as the ESP32 firmware does; one pooled, serialised connection per `ip:port`; one retry per tag; writes with FC05 and FC06.
- Driver API v1 (`synacl-gateway/driver`): `defineDriver`, `DriverError`, third-party packages loaded from `$SYNACL_GATEWAY_HOME/drivers` and listed in `config.json`, per-driver options and data directory, a guard that keeps sloppy results inside the wire contract.
- Driver test harness (`synacl-gateway/testing`): `assertDriver`, `testDriver`, `createMemoryLogger`, spec builders.
- An example driver (`examples/drivers/synacl-driver-example`, protocol `http`) with tests.

**CLI**
- `init` — writes `config.json` (mode 0600, atomic), validates every value without ever echoing the password, and proves the credentials and all seven subscriptions against the broker with a throwaway session. `--pass-stdin`, `--api`, `--ca`, `--insecure-tls`, `--no-verify`, `--config`.
- `run` — the gateway in the foreground; `--log-level`, `--log-format`; identity from the environment (`SYNACL_BROKER`, `SYNACL_TENANT`, `SYNACL_GATEWAY`, `SYNACL_USER`, `SYNACL_PASS` or `SYNACL_PASS_FILE`); `SYNACL_GATEWAY_HOME`.
- `status` — process, connection, configuration sync, buffer and per-device view from the gateway's state files, also while it is stopped; `--json`.
- `metrics` — what a Host metrics device on this machine would publish, with the source of each value and the reason for each missing one; `--watch`.
- `doctor` — checks Node, file permissions, the clock, the broker (reachability, TLS, credentials, subscriptions) and the local process; after signing in, the gateway record, configuration currency, capabilities, account features, every device's status and rate limits, and the last 24 hours of relevant events. Exit 5 on problems; `--skip-cloud`, `--json`.
- `conformance` — the protocol suite (`--offline`, `--scenario`) and driver contract checks (`--driver`).
- Exit codes: 0 ok, 1 runtime error, 2 usage, 3 connect/auth, 4 conformance failure, 5 doctor problems, 6 lock held. The password from `--pass` or the environment is scrubbed from everything the CLI prints.

**Service**
- `service print | install | uninstall | status` — a hardened systemd unit (runs as the invoking user, waits for network and time sync, restart on failure, 20 s stop grace, `SIGHUP` on reload, read-only system and home); `--user` for a per-user unit; `--dry-run`. Refuses to pin the npx cache.

**Docker**
- `ghcr.io/synacl-iot/synacl-gateway` for `linux/amd64` and `linux/arm64`: runs as `node`, state in `/data`, `SYNACL_HOST_DISK_PATH=/data`, `init` and `run` as container commands, `synacl-gateway` on the path for `docker exec`. A Compose example with secrets.

**Conformance**
- 23 scenarios (C01–C23) that run the real core against an in-memory broker, a scripted platform following the published behaviour, and a virtual clock: the connection sequence, full/unchanged/chunked/oversized/unprompted configuration, pacing over a simulated half hour, read-once, set-interval, pause, writes, gateway commands, firmware request, macros, a 20-minute outage with replay, Last Will, thresholds, refused subscriptions, unsupported protocols, and every vendored example against its schema. An end-to-end test over a real socket against an in-process broker with a platform-like ACL.

**Protocol**
- `protocol/v1/` vendored from synacl.com/protocol/v1 (24 schemas, 65 examples, the topic table); `npm run schemas:check` and `npm run schemas:sync`; a weekly drift check.

### Known limitations

- Local MQTT bridge devices are read-only; `cmdTopic` is reserved for writes in a later release.
- Modbus TCP writes are single-register and single-coil only (FC05, FC06); FC15/FC16 are refused with an error acknowledgement. Modbus RTU (serial) is not included.
- Macros do not run on this gateway; a run request is answered with an error status.
- The conformance suite has an offline mode only; there is no mode against the live platform yet.
- `synacl-gateway conformance --driver` checks a driver with a generic device (empty connection settings), so a driver that requires settings to open fails that check; `assertDriver` with real settings is the full test.
- `service` supports systemd only. On macOS and Windows the gateway runs in the foreground or in Docker.
- Host metrics in a container report the container's network interface unless the container uses the host network.
- Chunked configuration transfer is opt-in (`configCap`) and off by default.
