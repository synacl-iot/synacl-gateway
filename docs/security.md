# Security

What the gateway's credential can do, where every secret lives, what the code does to keep them there, and how to report a problem. This is the operator's view; vulnerability reports go through [SECURITY.md](../SECURITY.md).

## What the gateway credential is

`init` stores one credential: the gateway's MQTT username and password from Connection Info. On the Synacl broker that credential is confined to the gateway's own topic prefix (`tenants/<account>/sources/gateway/<gateway id>/…`). With it, a process can:

- connect as this gateway and publish what a gateway publishes — its presence, its capability report, and for its devices: readings, status, alerts and command acknowledgements;
- receive what the platform sends this gateway: its device configuration and commands (read now, pause, set interval, Modbus writes, restart, diagnostics).

It cannot read or publish for other gateways or accounts (the broker refuses the subscriptions — that refusal is how `init` and `doctor` detect a mismatched line), sign in to the app, call the platform's REST API, or change anything on the account. Two things follow:

- **Whoever holds the password can impersonate the gateway**: publish fabricated readings, status and alerts for its devices, acknowledge commands in its name, and receive everything the platform sends it — the commands meant for it and its device configuration, which for a Local MQTT bridge device carries the local broker's username and password. Connecting with the gateway's id also disconnects the real gateway (the broker allows one session per client id).
- **Rotate it when in doubt.** An administrator rotates a gateway's credentials in the app; then run the new `init` line (`init` keeps your other settings) and restart the gateway. The old password stops working at once.

The account password `doctor` asks for is a different thing: it is your Synacl sign-in, used once to read what the platform sees. It is read with echo off (or from `SYNACL_PASSWORD`), the session token stays in memory for the duration of the command, and nothing of it is written anywhere. The sign-in is recorded on the account like any other.

## Where secrets live

All under `$SYNACL_GATEWAY_HOME` (`~/.synacl-gateway`, mode `0700`; `/data` in the Docker image):

| File | Contains | Mode |
|---|---|---|
| `config.json` | the broker password, and `tls.caFile` if set | `0600`, written atomically (temp file + rename) so it is never half-written or briefly world-readable |
| `state/<gateway>-<hash>/config.raw` | the device configuration exactly as the platform sent it — including each **Local MQTT bridge** device's broker username and password, and anything else a device's connection settings hold | `0600`, directory `0700` |
| `state/<gateway>-<hash>/backfill/*.jsonl` | buffered readings (device id, timestamp, values) | `0600` |
| `state/<gateway>-<hash>/runtime.json`, `overrides.json`, `seq.json`, `run.lock` | operational state; no credentials | `0600` |
| `driver-data/<driver>/` | whatever a driver stores | `0700` |

The systemd unit (`/etc/systemd/system/synacl-gateway.service`, `0644`) holds no secret — only the path of the home directory. Environment variables (`SYNACL_PASS`, `SYNACL_PASSWORD`) are visible to other processes of the same user through `/proc`; prefer `SYNACL_PASS_FILE` (a Docker secret) or `config.json`.

`run` warns when `config.json` is readable by other users; `doctor` reports it as a problem. On Windows file modes are not checked.

## Redaction

Credentials must never reach a log, the terminal, a diagnostics message or the wire. The rules, applied before a line is written anywhere:

1. The broker password, every local-broker password (from a bridge device's settings or its URL) and any string a driver registers with `log.redact()` are replaced by `***` wherever they appear — in messages and in fields, however deeply nested, including their URL-encoded and JSON-escaped forms.
2. A field whose key looks like a credential (`pass`, `secret`, `token`, `authorization`) is `***`.
3. User-info in URLs (`mqtt://user:pw@host`) is masked, so a URL is always safe to log.

The CLI wraps its own stdout and stderr in the same way for the `--pass` value and the `SYNACL_PASS`/`SYNACL_PASSWORD` environment variables, so even an unexpected error message cannot echo them; error messages are written never to quote what you typed. `status --json` prints a fixed list of fields, never the raw state. The remote diagnostics the platform can request carry device ids and protocols only — never device names or connection settings — and log lines that have already been redacted.

## The network

- The gateway **opens no listening port**. It connects out: to the broker, to the local brokers and Modbus devices you configure, and with an HTTPS `HEAD` to the platform API (`api.synacl.com`) at start-up and every six hours to check the clock. `doctor` additionally calls the platform's REST API with your sign-in.
- **TLS to the broker is verified by default** against the system's certificate store. `init --ca <file>` pins a private CA for a self-hosted broker; `--insecure-tls` turns verification off and warns loudly — anything on the path could then impersonate the broker and read the password. `mqtt://` to a host outside the local network sends the password in clear text; `init` warns.
- **TLS to local brokers** (a bridge device on `mqtts://`) is verified too; `bridge.rejectUnauthorized: false` in `config.json` turns that off for the whole gateway.
- **Modbus TCP has no security of its own.** Anyone on the LAN can read and write a Modbus device; the gateway does not change that. Put Modbus devices on a network segment you control.
- The gateway publishes nothing while disconnected and never replays an outage on the live data topic, so a reconnect cannot be mistaken for a flood.

## Commands from the platform

The platform can command this gateway through its credential: read a tag now, pause or resume a device's reads, change its interval, write a Modbus coil or register, restart, reset its configuration, request a diagnostics snapshot or a five-minute live log tail, and switch simulation mode on. Anything it does not recognise is ignored. A retained command left on the broker is ignored (a retained `restart` would otherwise loop forever). Macros are refused (`this gateway does not run macros`) and a firmware update request is logged and ignored — updates come from npm. A Modbus write moves real equipment; the app controls who may send one.

## Drivers are code

A third-party driver from `config.json` is loaded in-process, as your user, with everything the gateway process can do — the network, the filesystem, `config.json`. The gateway wraps a driver to keep the wire contract honest (it drops unusable values, caps reasons, tracks handles), not to contain it. Install only drivers you would run as yourself, pin their versions, and read the source of anything small.

## Under systemd

The unit `service install` writes runs the gateway as your user (not root — `service` warns if you try), with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` except the gateway's own directory, `PrivateTmp`, `ProtectControlGroups`, `RestrictSUIDSGID` and `LockPersonality`. A user unit (`--user`) keeps the options the kernel enforces without privileges.

## Supply chain

Releases are published to npm with provenance from this repository's release workflow (npm trusted publishing) and the Docker image with provenance and an SBOM; the workflows pin every action by commit. `npm audit signatures` verifies the package. The four runtime dependencies are `mqtt`, `modbus-serial`, `systeminformation` and `ajv`; Dependabot proposes updates weekly.

## Reporting a problem

Use GitHub's private vulnerability reporting on this repository, or write to support@synacl.com. Details and what to expect are in [SECURITY.md](../SECURITY.md). Problems with the platform, the broker or the app go to support@synacl.com directly.
