# synacl-gateway

**The reference gateway for [Synacl](https://synacl.com): turn any machine that runs Node.js — a Raspberry Pi, a mini PC next to your panel, a container — into a Synacl gateway.**

A Synacl gateway sits between your equipment and the platform. It keeps one MQTT connection to the cloud, receives its device list from the platform, reads each device on its interval, and publishes the readings. This project does that in Node.js, so you do not need Synacl's ESP32 hardware or firmware. Everything it says and hears on the wire is the public [Synacl Gateway Protocol](https://synacl.com/protocol/), with a JSON Schema for every message; this repository is one implementation of it, and you can write your own in any language.

Apache-2.0 · Node.js 20.11 or newer (22 LTS recommended) · Linux, macOS, Windows, Docker

## Quick start

1. In the Synacl app open **Gateways → Add gateway → Software gateway**, give it a name and save. The **Connection Info** panel shows a **Quick start (Node.js)** line like this one:

   ```sh
   npx -y synacl-gateway@latest init --broker mqtts://mqtt.synacl.com:8883 --tenant <id> --gateway <gw_…> --user <username> --pass <password> && npx -y synacl-gateway@latest run
   ```

2. Paste it into a terminal on the machine that will be the gateway. npm downloads the package on the first run. `init` saves the settings to `~/.synacl-gateway/config.json` (readable only by you), checks them against the broker, and prints:

   ```
   Connected: credentials accepted, 7/7 subscriptions granted.
   ```

   then `run` starts the gateway in the foreground. Within a few seconds the gateway shows **online** in the app.

   The password is in that line. Start it with a space so your shell keeps it out of history (bash with `HISTCONTROL=ignorespace`/`ignoreboth`, the default on Raspberry Pi OS and most distributions; zsh with `HIST_IGNORE_SPACE`), or replace `--pass <password>` with `--pass-stdin` and type it when asked.

3. **Start the gateway first, then add devices.** On connect the gateway tells the platform which protocols it can serve, and the app only offers **Host metrics** and **Local MQTT bridge** for a gateway that has reported them. Add devices under the gateway in **Devices → Add device**; a software gateway receives every device change automatically — there is no "resend config" step.

Stop it with Ctrl-C. The gateway publishes `{"online":false}` before it disconnects, so the app shows it offline at once.

## Run it permanently

Install it globally and let systemd keep it running across reboots and crashes (Linux):

```sh
sudo npm i -g synacl-gateway          # sudo is needed with a system-wide Node
synacl-gateway init --broker … --tenant … --gateway … --user … --pass …   # skip if you already ran the npx line
synacl-gateway service install        # writes /etc/systemd/system/synacl-gateway.service, enables and starts it
```

`service install` prints every command before it runs it and asks for `sudo` for the ones that need it; run it as the user the gateway should run as, not as root. Then:

```sh
synacl-gateway status                 # what the gateway is doing (works while it is stopped, too)
systemctl status synacl-gateway
journalctl -u synacl-gateway -f       # logs (JSON lines under systemd)
sudo systemctl reload synacl-gateway  # re-read config.json without dropping the connection
synacl-gateway service uninstall      # removes the unit; config.json and state are kept
```

Without root, `synacl-gateway service install --user` writes a per-user unit instead (`~/.config/systemd/user/`); add `sudo loginctl enable-linger $USER` so it starts at boot without a login. On macOS and Windows use Docker, or keep `synacl-gateway run` running with launchd, a task scheduler or a terminal multiplexer; `service` is Linux-only.

Updates come from npm, not over the air: `sudo npm i -g synacl-gateway@latest && sudo systemctl restart synacl-gateway`.

## Raspberry Pi

Use 64-bit Raspberry Pi OS. Bookworm's `apt` Node.js is 18, which is too old — install Node 22 from NodeSource; Trixie's `apt` ships Node 20, which works. Then follow the steps above. `cpu.temp` is available on every Pi. Details, including a Pi without a real-time clock: [docs/raspberry-pi.md](docs/raspberry-pi.md).

## Docker

```sh
docker run --rm -it -v synacl:/data ghcr.io/synacl-iot/synacl-gateway init --broker … --tenant … --gateway … --user … --pass …
docker run -d --init --restart unless-stopped -v synacl:/data --name synacl-gateway ghcr.io/synacl-iot/synacl-gateway
```

State lives in the `synacl` volume. Add `--network host` for the machine's real network counters. A Compose file is in [`examples/docker-compose.yml`](examples/docker-compose.yml); secrets, host metrics inside a container and updates are covered in [docs/docker.md](docs/docker.md).

## Drivers

| Protocol in the app | Driver | Reads | Writes |
|---|---|---|---|
| **Host metrics** | `host` | CPU temperature and load, load average, memory, disk, uptime, network throughput of the machine the gateway runs on | — |
| **Local MQTT bridge** | `mqtt-bridge` | Topics on a broker you already have — Tasmota, zigbee2mqtt, Home Assistant, a PLC — mapped onto device tags | not in 0.1 |
| **Modbus TCP** | `modbus-tcp` | Holding and input registers, coils and discrete inputs; u16/s16/u32/s32/f32 with either word order | one coil (FC05) or one register (FC06) |

Every driver, its settings and every status reason it can report: [docs/drivers.md](docs/drivers.md). `synacl-gateway metrics` shows what a Host metrics device on this machine would publish, and which metrics it cannot provide.

The gateway also buffers readings on disk while the connection is down and replays them afterwards (7 days / 64 MiB by default), evaluates each tag's alarm band locally, honours read-once, pause and interval commands from the app, and answers the platform's remote diagnostics (snapshot and live log tail).

## Commands

| Command | What it does |
|---|---|
| `init` | Save the settings from Connection Info and check them against the broker |
| `run` | Run the gateway in the foreground (what systemd, Docker and the quick-start line start) |
| `status` | Show the process, connection, configuration sync, buffer and devices, also while stopped; `--json` |
| `metrics` | Show the host metrics this machine would publish and where each comes from; `--watch <s>` |
| `service` | `print`, `install`, `uninstall` or `status` the systemd unit (Linux); `--user`, `--dry-run` |
| `doctor` | Check this machine, the broker and — after signing in — what the platform sees; exit 5 on problems |
| `conformance` | Run the protocol conformance suite (`--offline`, 23 scenarios) or check a driver (`--driver`) |
| `help <cmd>`, `--version` | |

Exit codes: `0` ok · `1` runtime error · `2` usage error · `3` the broker could not be reached or refused the credentials (`init`) · `4` conformance failure · `5` doctor found problems · `6` another instance is running for this gateway.

`SYNACL_GATEWAY_HOME` moves `config.json` and all state (default `~/.synacl-gateway`). `SYNACL_BROKER`, `SYNACL_TENANT`, `SYNACL_GATEWAY`, `SYNACL_USER` and `SYNACL_PASS` (or `SYNACL_PASS_FILE`) override the file; with all five set, no file is needed. Every key of `config.json` is documented in [`examples/README.md`](examples/README.md).

## Troubleshooting

`synacl-gateway doctor` checks Node, file permissions, the clock, the broker (reachability, TLS, credentials, the seven subscriptions), the local process and, after you sign in with your Synacl account, the gateway record, its capabilities, every device's status and rate limits, and the last 24 hours of relevant events. Every CLI error, exit code and device status reason, with what to do about it: [docs/troubleshooting.md](docs/troubleshooting.md).

## Writing a driver

A driver is an npm package that default-exports `defineDriver({...})` from `synacl-gateway/driver`, implements `open` / `read` / `close` (plus optional `write` and `status`), and is listed in `config.json`. Test it with `synacl-gateway/testing` and `synacl-gateway conformance --driver`. The API, the rules a read result has to follow, and a walk through the example driver in [`examples/drivers/synacl-driver-example`](examples/drivers/synacl-driver-example): [docs/writing-a-driver.md](docs/writing-a-driver.md).

## Security notes

- `config.json` holds the gateway's broker password. `init` creates it with mode `0600` in a `0700` directory; `run` warns when it is readable by others.
- A Local MQTT bridge device's broker password arrives in the device configuration and is stored, verbatim, in the gateway's state directory (mode `0600`) so the devices can start before the connection is up.
- Passwords are registered with the logger and replaced by `***` in every log line, field and diagnostics message before it is written anywhere.
- Third-party drivers run in-process with full trust. Install only code you would run as yourself.
- The gateway opens no listening ports. It connects out to the broker (TLS verified by default), to the local brokers and Modbus devices you configure, and to the platform API for a clock check.

The threat model, where every secret lives and how to report a vulnerability: [docs/security.md](docs/security.md) and [SECURITY.md](SECURITY.md).

## Contributing

Bug reports and pull requests are welcome. Development needs Node 22: `npm ci`, `npm test` (445 tests, about 30 s), `npm run conformance`. The protocol under `protocol/v1/` is vendored from [synacl.com/protocol](https://synacl.com/protocol/) and changes only through `npm run schemas:sync`. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[Apache-2.0](LICENSE). Copyright 2026 Synacl Labs.
