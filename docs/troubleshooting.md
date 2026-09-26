# Troubleshooting

Three commands answer most questions:

```sh
synacl-gateway status        # what the gateway is doing, from its own state files; works while it is stopped
synacl-gateway doctor        # checks this machine, the broker and — after you sign in — what the platform sees
journalctl -u synacl-gateway -f        # the log (systemd); docker logs -f synacl-gateway; or the terminal for `run`
```

`doctor` prints `[ok]`, `[!!]` (a problem, with a fix on the next line) and `[--]` (skipped or informational), and exits `5` when it found problems. `--skip-cloud` runs only the local and broker checks; otherwise it asks for your Synacl account e-mail and password (the account password, not the gateway's broker password; `SYNACL_EMAIL` and `SYNACL_PASSWORD` in the environment skip the prompts). Signing in is recorded on the account like any sign-in.

`run --log-level debug` shows every config request, publish and command. Under systemd the log is JSON lines; `journalctl -u synacl-gateway -o cat | jq -r .msg` reads well.

## Exit codes

| Code | Meaning | Commands |
|---|---|---|
| `0` | fine | all |
| `1` | a runtime error (the message starts with `error:`) | all |
| `2` | usage: a bad flag, a missing or invalid setting, no `config.json` | all |
| `3` | the broker could not be reached, or refused the credentials or the subscriptions | `init` |
| `4` | a conformance scenario or driver check failed | `conformance` |
| `5` | problems found | `doctor` |
| `6` | another synacl-gateway is running for this gateway | `run` |

## `init` errors

`init` validates the line before it touches anything and never repeats a value you typed (the password is on that line).

| Message | What it means |
|---|---|
| `missing --tenant, --gateway, …` | Part of the line is missing. Copy the whole **Quick start (Node.js)** line from Connection Info. |
| `--tenant must be the 24-character account id from Connection Info (0-9, a-f)` | The tenant is the account id (24 hex characters), not a name. |
| `--gateway must be 3-64 characters: letters, digits and _ . : - …` | The gateway id contains a space, `/`, `+` or `#`, or is too short. |
| `--broker has no host name: this Synacl deployment has no public MQTT hostname` | The line came out as `mqtt://:1883`. Use the address this machine can reach the broker at. |
| `--broker must not contain credentials — pass them with --user and --pass` | `mqtt://user:pass@host` is not accepted. |
| `--broker must start with mqtt://, mqtts://, ws:// or wss://` | e.g. an `https://` URL. |
| `unknown option --x` · `--x needs a value` · `unexpected argument — this command takes only --flags (quote values that contain spaces)` | A flag is misspelt or a value contains a space. |
| `use either --pass or --pass-stdin, not both` · `no password entered` | Self-explanatory; `--pass-stdin` reads one line from stdin (echo off on a terminal). |
| `cannot read the --ca file …` | The PEM file path is wrong. |
| `… was written by a newer synacl-gateway — upgrade before running init` | `config.json` has a schema this version does not know. |
| `cannot write … (EACCES)` | The directory belongs to another user (you ran `init` with `sudo` earlier?). Fix the ownership, or point `SYNACL_GATEWAY_HOME` elsewhere. Exit `1`. |

Warnings (the file is still written): `the password does not look like one the platform generates (24 letters and digits)` — the value was probably cut off when copying; `mqtt:// sends the password in clear text to <host>` — use `mqtts://` unless the broker is on your LAN; `TLS certificate verification is OFF` after `--insecure-tls`; `the previous --ca / --insecure-tls setting is not carried over`.

### The connection check (exit `3`)

After saving, `init` connects once with its own client id and checks that the credentials are accepted and all seven subscriptions are granted. It says where it stopped:

| Message | Fix |
|---|---|
| `cannot resolve <host> (DNS lookup failed)` | Check the host name and this machine's DNS / internet connection. |
| `<host>:<port> refused the connection` | Wrong port, or no broker listening there. |
| `no answer from <host>:<port> within 15 s (ETIMEDOUT)` | A firewall blocks outbound 8883. The broker is also reachable over WebSocket: `--broker wss://mqtt.synacl.com/mqtt`. |
| `<host>:<port> closed the connection during the TLS handshake` · `<host>:<port> did not answer TLS` | `mqtts://` was pointed at a plain port. Use the TLS port (8883), or `mqtt://` for a plain one. |
| `<host>:<port> closed the connection before answering` | A plain `mqtt://` was pointed at a TLS port. Try `mqtts://`. |
| `the broker's TLS certificate was not accepted (<code>)` | A private broker with its own CA: pass `--ca <file>`. Never needed for `mqtt.synacl.com`; a wrong system clock can also cause `CERT_NOT_YET_VALID`. |
| `the broker rejected the username/password (CONNACK 4)` or `(CONNACK 5)` | Copy the line from Connection Info again. The password changes whenever the gateway's credentials are rotated or it is re-registered. |
| `the broker accepted the credentials but refused N of 7 subscriptions (…)` | `--tenant` or `--gateway` do not belong to this username and password. Copy all four from the same Connection Info panel. |

The settings stay saved, so once the cause is fixed you can run `synacl-gateway run` directly; when only the network was the problem, `run` keeps retrying on its own.

If a gateway is already running with these settings, `init` skips the check and says `synacl-gateway is already running for this gateway (pid N), so the connection check was skipped.` — restart the service (`sudo systemctl restart synacl-gateway`) to pick up the new settings.

## `run` and `status` errors

| Message | Fix |
|---|---|
| `no configuration at …/config.json` (exit `2`) | Run the `init` line first, as the same user, or set `SYNACL_GATEWAY_HOME` to where it is. Under `sudo`, `~` is root's home. |
| `…/config.json is not valid JSON — fix it or run init again` | A hand edit broke the file. |
| `…/config.json has schema N; this version understands schema 1 — upgrade synacl-gateway` | The file was written by a newer version. |
| `set SYNACL_PASS or SYNACL_PASS_FILE, not both` · `cannot read SYNACL_PASS_FILE (ENOENT)` | Environment overrides: only one password source, and the file must exist. |
| `another synacl-gateway is running for this gateway (pid N) — only one instance per gateway id can be connected` (exit `6`) | The quick-start `run` is still going in another terminal while the service started, or two services point at the same home. Stop one of them. |
| `synacl-gateway needs Node.js 20.11 or newer (22 LTS recommended); this is v18.19.0.` | See the [Raspberry Pi page](raspberry-pi.md) for installing Node 22. |
| `warning: …/config.json is readable by other users (mode 644) — run: chmod 600 …` | The file holds the broker password. Run the `chmod`. |

`status` says `not running — last seen 5m ago (it did not shut down cleanly)` after a crash or a `kill -9`; `not running — stopped …` after a clean stop; `no record of a previous run with these settings` when it never ran with this `config.json`.

## The gateway card stays offline

Work down the list; `doctor` covers every step.

1. **Is it running?** `synacl-gateway status` — `Process running (pid …)`. If not: `synacl-gateway run`, or `systemctl status synacl-gateway` for why the service died (`journalctl -u synacl-gateway -n 50`).
2. **Is it connected?** `status` shows `MQTT connected for …`. While it is not, the log says why, in the same words as the `init` table above, plus:
   - `the broker rejected this gateway's credentials (CONNACK 4) — re-run synacl-gateway init with the line from Connection Info` — the password was rotated or the gateway re-registered. The gateway keeps trying with a growing delay, up to one attempt every 5 minutes, until you fix it.
   - `ACL_DENIED: the broker refused the subscription to … — the tenant/gateway in config.json do not match this credential; retrying in 5 minutes` — a mixed-up Connection Info line. Re-run `init` with all four values from one panel.
   - `another process with gateway id <id> is connected (session takeover) — only one instance per gateway can be online; stop the other one` — two gateways share an id (a second machine, a container and a service, a leftover `npx … run`). The broker disconnects whichever connected first, and they keep kicking each other off. Stop one, or register a second gateway.
   - `reconnecting inMs=…` after `connection error` — the network. The backoff goes 1 s, 2 s, … up to 60 s (±20 %) and resets after a connection that held.
3. **Registered as the right kind?** `doctor` says `the gateway is registered as an ESP32, so the app offers firmware updates for it` when it was added as hardware. Register it as a **Software gateway** and use its line.
4. **Timing.** The heartbeat goes out every 60 s and the platform shows the gateway offline when the last one is older than 180 s. A clean stop (`Ctrl-C`, `systemctl stop`, `docker stop` with `--init`) publishes `{"online":false}` at once; after a crash or a pulled cable the broker publishes it for the gateway when the keepalive (60 s) expires, so up to about 90 s later.

A wrong system clock cannot make the gateway look offline: the heartbeat carries no timestamp on purpose.

## "no device configuration received yet" / config not in sync

`status` shows the configuration line in three states:

- `no device configuration received yet — add devices in the app, then press Resend config` — the platform has not sent a device list. With no devices under the gateway that is normal. Otherwise, the log line `no reply to config/request — the platform may be refusing an oversized configuration (event gateway/config-too-large) or has not stored this gateway's capabilities yet; asking again` names the two causes: `doctor` (signed in) reports `config-too-large` events and whether a capability report is stored. The gateway asks again after 10, 20, 40 and 80 s, then every 10 minutes; a restart asks immediately.
- `hash N, not confirmed by the platform yet` — a configuration was applied and the gateway has asked the platform to confirm it is the current one. It normally takes a second. If it stays, the platform keeps answering with a different configuration: `doctor` shows `the gateway is not on the latest configuration (gateway H1, platform H2)`, and **Resend config** on the gateway page or a restart resolves it.
- `hash N, in sync with the platform` — fine.

A software gateway receives changes to its devices automatically (the platform pushes the new list); **Resend config** exists for it too and is harmless.

If the log says `the platform keeps sending the configuration this gateway already runs; pausing requests for 10 minutes`, something on the platform side answers every request with a full push instead of `unchanged`; the gateway is running the right configuration and will settle on its own.

`reset/config` from the app clears the stored configuration and restarts the gateway, which then asks for everything from scratch.

## A device is unreachable

`status` lists each device with `ok`, `paused`, or `unreachable: <reason>`; the app shows the same reason on the device. The reasons are per driver and each has a fix in [drivers.md](drivers.md); the ones that come from the gateway rather than a driver:

| Reason | Meaning | Fix |
|---|---|---|
| `unsupported protocol: <name>` | No driver serves this protocol. | Attach the device to a gateway that lists the protocol, or install a driver for it ([writing-a-driver.md](writing-a-driver.md)). `doctor` shows the protocols this gateway reported. |
| `timeout` | The driver did not answer within 0.8 × the interval (at most 10 s). | The equipment is slow or the interval is very short. |
| `driver read never returned — abandoning it` (log) | A driver ignored the timeout for a further 60 s. | A driver bug; report it. The device resumes reading. |
| `<driver> device <id>: …` | The driver refused to open the device because a setting is invalid, e.g. `modbus-tcp device …: no valid device IP configured`. | Fix the setting in the app. |

A device that stays unreachable is retried with a doubling delay after three failures, up to `max(interval, 60 s)`, and read normally again as soon as it answers. The device's 30-second retained status keeps the platform informed either way; the platform marks a device offline only when it hears nothing for 90 s, which on a running gateway means the gateway itself is offline.

`paused` means someone disabled the device's reads in the app (`read/disable`); the device is still reported reachable. A timed pause ends on its own; a manual one lasts until **Enable** in the app.

## A device is suspended for publishing too fast

The platform measures the gap between a device's data messages and suspends a device that keeps publishing faster than its plan allows — without telling the gateway. `doctor` shows it: `suspended for publishing too fast (until …)`, `N rate violation(s) in the last 24 h`, or `interval N ms is below the plan's minimum M ms`.

synacl-gateway itself never sends two messages for a device closer together than its interval, replays buffered readings on a separate topic that is not rate-gated, and staggers devices that start together. So a suspension means:

- **Two processes publish for the same gateway id** — the usual cause. See *session takeover* above.
- **The device's interval is below the plan minimum.** Raise the publish interval in the app to at least the plan minimum.
- Something else publishes on the device's topic with the gateway's credentials.

Fix the cause and wait for the suspension to lift.

## Readings are missing after an outage

While the connection is down the gateway keeps reading and buffers every reading on disk; after the connection has been stable for 10 s it replays them, oldest first, at one batch of up to 40 readings per second on the `data/backfill` topic. `status` shows `Buffer N readings waiting`; the number falls to 0 as the replay proceeds. Replayed readings are stored as history; they do not update dashboards' live values or fire rules.

If they never appear: `doctor` reports `store-and-forward replay is not enabled for this account, so replayed readings are discarded` when the account lacks the feature — ask support. Buffered readings are dropped, with a warning in the log, when the buffer exceeds `backfill.maxBytes` (64 MiB) or `backfill.maxAgeHours` (7 days), and readings are not buffered at all while the clock reads a year before 2025.

## Alarm bands do not fire

The alarm band set on a tag in the app is evaluated by the gateway, in engineering units (raw × scale + offset). A band of `0` to `0` means *no band*. The gateway raises `THRESHOLD_VIOLATION` once when the value leaves the band and `THRESHOLD_CLEARED` once when it returns — not on every reading. Transitions while offline are queued (100 at most) and sent after reconnect. Check that the value you see is the engineering value and that the tag's band is not `0…0`; `run --log-level debug` logs each evaluation.

## The clock

`the system clock is 47.0 s behind the platform — readings carry this machine's timestamps; enable time sync (e.g. timedatectl set-ntp true)` in the log, or `[!!] clock is … ahead of the platform's` from `doctor`: enable NTP. On a Raspberry Pi without a real-time clock see [raspberry-pi.md](raspberry-pi.md#3-the-clock). The check uses the platform API's `Date` header and needs `api` in `config.json` (derived from the broker host; `init --api <url>` sets it for a private deployment).

## A protocol is not offered in the app

The app offers **Host metrics** and **Local MQTT bridge** only on a gateway whose capability report lists them, and only when the protocol is enabled for the account. Start the gateway first, then add the device. `doctor` (signed in) prints `capabilities: host, mqtt-bridge, modbus-tcp` for the gateway and `not enabled for this account: …` for protocols the account cannot use.

## `service` errors

| Message | Fix |
|---|---|
| `service install needs Linux with systemd` · `systemd is not running on this machine` | `service` is Linux/systemd only. On macOS and Windows use Docker or keep `run` running another way; `service print` still shows the unit. |
| `synacl-gateway is running from the npx cache, which npm cleans up — a service pointing there would break.` | `npm i -g synacl-gateway`, then `synacl-gateway service install`. |
| `no configuration at /home/<user>/.synacl-gateway/config.json` | Run the `init` line as that user first (without `sudo`). |
| `--user installs a unit for the account running this command; run it without sudo` | Drop the `sudo`. |
| `cannot find the home directory of <user>` | Set `SYNACL_GATEWAY_HOME` explicitly: `sudo --preserve-env=SYNACL_GATEWAY_HOME synacl-gateway service install`. |
| `warning: Node runs from a version manager (…)` | The unit pins that exact binary; after switching Node versions run `service install` again, or install Node system-wide. |
| `"sudo install …" failed (exit 1)` | The printed command failed; run it by hand to see why. |

`service uninstall` keeps `config.json` and the state. A user unit (`--user`) needs `sudo loginctl enable-linger <user>` to start at boot without a login; `install --user` says so when lingering is off.

## `conformance` errors

`say --offline (the only mode in this version)` — the suite runs against a scripted platform only; `--offline` is required. `unknown scenario X (known: C01 … C23)` — scenario ids are `C01`–`C23`. `cannot load driver "x": …` (exit `2`) — see the load-error table in [writing-a-driver.md](writing-a-driver.md#installing-a-driver-on-a-gateway). A failed scenario or driver check exits `4` with the failed assertions listed.

## Still stuck

Open an issue with the output of `synacl-gateway --version`, `node --version`, `synacl-gateway status --json` (it contains no secrets, but check before pasting), `synacl-gateway doctor --skip-cloud` and the relevant log lines; the bug report form asks for exactly these. Problems with your account, plan, devices or the app itself go to support@synacl.com rather than this repository.
