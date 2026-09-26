# Examples

| File | What it is |
|---|---|
| [`config.example.json`](config.example.json) | Every key of `config.json`, at its default. `synacl-gateway init` writes this file for you; edit it by hand only for the settings below. |
| [`docker-compose.yml`](docker-compose.yml) | Running the gateway with Docker Compose: `init` once, then `up -d`. |
| [`systemd/synacl-gateway.service`](systemd/synacl-gateway.service) | The unit `synacl-gateway service install` writes, for reference. Generate your own with `synacl-gateway service print`: the paths must match your machine. |

## `config.json`

It lives in `$SYNACL_GATEWAY_HOME` (default `~/.synacl-gateway`) with mode `0600`, because it holds the broker password. After editing it, reload the gateway: `sudo systemctl reload synacl-gateway` (the unit sends `SIGHUP`), or `kill -HUP <pid>` for one running in the foreground. A reload with unchanged connection settings only asks the platform for the device configuration again; changed settings restart the gateway inside the same process.

| Key | Default | Meaning |
|---|---|---|
| `schema` | `1` | File format version. |
| `broker` | — | Broker URL from Connection Info: `mqtts://host:8883`, `mqtt://host:1883`, or `wss://host/mqtt` when outbound port 8883 is blocked. |
| `tenant` | — | The 24-character account id from Connection Info. |
| `gateway` | — | The gateway id. One running gateway per id: a second connection with the same id takes the session over. |
| `username`, `password` | — | The gateway's MQTT credentials from Connection Info. |
| `api` | derived | Platform REST address, used for the clock check and `doctor`. Derived from the broker host (`mqtt.example.com` → `https://api.example.com`); `null` when it can't be. |
| `tls.caFile` | `null` | PEM file with the CA that signed the broker's certificate (a private broker). |
| `tls.rejectUnauthorized` | `true` | `false` turns certificate checks off. Avoid: prefer `caFile`. |
| `drivers` | `[]` | Extra driver packages (npm names or absolute paths), loaded after the built-ins. |
| `driverDir` | `null` | Where extra drivers are installed; `null` = `$SYNACL_GATEWAY_HOME/drivers` (`npm i --prefix ~/.synacl-gateway/drivers <package>`). |
| `configCap` | `null` | Opt-in: fetch the device configuration in chunks of this many bytes. Leave `null` unless a very large configuration can't be delivered in one message. |
| `minIntervalMs` | `1000` | Floor for every device's publish interval (never below 250). |
| `backfill.maxBytes` | `67108864` | Disk space for readings buffered while offline (64 MiB); the oldest are dropped beyond it. |
| `backfill.maxAgeHours` | `168` | Buffered readings older than this are dropped (7 days). |
| `backfill.batchIntervalMs` | `1000` | Pause between replay batches after reconnecting. Use `2000` when several gateways of one account may replay at once. |
| `host.diskPath` | `"/"` | Filesystem the host metrics report as `disk.used_pct` (the Docker image uses `/data`). |
| `bridge.rejectUnauthorized` | `true` | Certificate checks for local brokers used by MQTT bridge devices. |
| `log.level` | `"info"` | `debug`, `info`, `warn` or `error`. `run --log-level` overrides it. |
| `log.format` | `"auto"` | `text`, `json`, or `auto` (text on a terminal, JSON lines otherwise). |
| `createdAt` | — | When `init` wrote the file. |

Environment variables override the file: `SYNACL_BROKER`, `SYNACL_TENANT`, `SYNACL_GATEWAY`, `SYNACL_USER`, `SYNACL_PASS` (or `SYNACL_PASS_FILE`, a file holding the password), and `SYNACL_HOST_DISK_PATH`. With all five identity variables set, no `config.json` is needed.
