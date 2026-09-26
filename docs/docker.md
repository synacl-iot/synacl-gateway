# Docker

The image `ghcr.io/synacl-iot/synacl-gateway` runs the gateway as an unprivileged user with its state in a volume. It is built for `linux/amd64` and `linux/arm64` (a 64-bit Raspberry Pi), from `node:24-alpine`, with an SBOM and build provenance attached.

| Tag | What it is |
|---|---|
| `latest` | the newest release |
| `0.1` | the newest 0.1.x release |
| `0.1.0` | exactly that release |

Pre-releases (`0.2.0-rc.1`) are published under their full version only.

Inside the image `SYNACL_GATEWAY_HOME=/data` and `SYNACL_HOST_DISK_PATH=/data`, the entrypoint is the `synacl-gateway` CLI, and the default command is `run`. `/data` is declared as a volume and owned by the `node` user (uid 1000), mode 0700.

## Run it

Save the settings once. This runs the CLI's `init` command inside a throwaway container and writes `/data/config.json` into a named volume called `synacl`:

```sh
docker run --rm -it -v synacl:/data ghcr.io/synacl-iot/synacl-gateway init \
  --broker mqtts://mqtt.synacl.com:8883 --tenant <id> --gateway <gw_…> --user <username> --pass <password>
```

The values are the ones from **Gateways → Connection Info** in the Synacl app. `init` checks the credentials against the broker before it returns; a failure exits non-zero and says why (see [troubleshooting](troubleshooting.md)).

Then start the gateway:

```sh
docker run -d --init --restart unless-stopped -v synacl:/data --name synacl-gateway ghcr.io/synacl-iot/synacl-gateway
```

Two things in that line matter:

- `--init` runs a tiny PID 1 that forwards signals. Without it `docker stop` cannot deliver SIGTERM to Node, the container is killed after the grace period, and the gateway never publishes `{"online":false}` — the app then shows it offline only after the broker's keepalive expires.
- `-v synacl:/data` is the same volume `init` wrote to. `config.json`, the applied device configuration, the message counters and the store-and-forward buffer live there and survive updates.

Add `--network host` for the machine's real network counters and to reach the LAN exactly as the host does (see below).

```sh
docker logs -f synacl-gateway                          # JSON lines (not a TTY); see below for text
docker exec synacl-gateway synacl-gateway status       # the gateway's own view
docker exec -it synacl-gateway synacl-gateway doctor   # -it so it can prompt for your account password
docker stop synacl-gateway                             # SIGTERM → online:false → clean disconnect
```

After changing the settings (`init` again with a new password, or editing `config.json` in the volume): `docker restart synacl-gateway`.

## Compose

[`examples/docker-compose.yml`](../examples/docker-compose.yml) is the same thing as a service: `init: true`, `restart: unless-stopped`, `stop_grace_period: 20s`, the named volume, and commented-out `network_mode: host` and secrets blocks.

```sh
docker compose run --rm gateway init --broker mqtts://mqtt.synacl.com:8883 --tenant <id> --gateway <gw_…> --user <username> --pass <password>
docker compose up -d
docker compose logs -f gateway
docker compose exec gateway synacl-gateway status
```

## Secrets instead of `init`

The identity can come from the environment, with no `config.json` at all. All five are required, and the password may come from a file, which is how Docker and Compose secrets are delivered:

```yaml
services:
  gateway:
    image: ghcr.io/synacl-iot/synacl-gateway:0.1
    init: true
    restart: unless-stopped
    volumes:
      - synacl-data:/data
    environment:
      SYNACL_BROKER: mqtts://mqtt.synacl.com:8883
      SYNACL_TENANT: "<id>"
      SYNACL_GATEWAY: "<gw_…>"
      SYNACL_USER: "<username>"
      SYNACL_PASS_FILE: /run/secrets/synacl_pass
    secrets:
      - synacl_pass
secrets:
  synacl_pass:
    file: ./synacl_pass.txt      # the password on one line; chmod 600
volumes:
  synacl-data:
```

`SYNACL_PASS` works too (plain environment); setting both is an error. The environment overrides `config.json` when both exist, so a file in the volume can carry the non-identity settings (`backfill`, `minIntervalMs`, `drivers`, …) while the credentials stay in secrets. The volume is still needed: the gateway's state goes there.

## Host metrics inside a container

A **Host metrics** device in a container reads the container's view of the machine:

| Metric | In a container |
|---|---|
| `cpu.load`, `load.1m`, `mem.used_pct`, `uptime_s` | the host's figures (read from `/proc`) |
| `cpu.temp` | read from `/sys/class/thermal`; available where the container can see the host's sysfs, which is the default on most Docker hosts. If `synacl-gateway metrics` reports it unavailable, add `-v /sys/class/thermal:/sys/class/thermal:ro`. |
| `disk.used_pct` | the `/data` volume (the image sets `SYNACL_HOST_DISK_PATH=/data`). To report the host's root filesystem instead, mount it read-only and point at it: `-v /:/host:ro -e SYNACL_HOST_DISK_PATH=/host`. |
| `net.rx_bps`, `net.tx_bps` | the container's own interface, which is not the machine's traffic. Use `--network host` for the real counters. |

Run `docker run --rm -v synacl:/data ghcr.io/synacl-iot/synacl-gateway metrics` to see exactly what a container on this host would publish and why anything is missing.

## Reaching the LAN

Modbus TCP devices and local MQTT brokers are reached by IP address from the default bridge network without extra flags. What does not work from a bridge network: `.local` names (mDNS is not available inside the container — use the IP address), and anything that has to see the connection come from the host's own address. `--network host` removes both limits and is the simplest choice on a dedicated machine.

## Updating

```sh
docker pull ghcr.io/synacl-iot/synacl-gateway:latest
docker rm -f synacl-gateway
docker run -d --init --restart unless-stopped -v synacl:/data --name synacl-gateway ghcr.io/synacl-iot/synacl-gateway
```

or `docker compose pull && docker compose up -d`. The state in the volume carries over; the gateway reports the new version to the platform on its next connect.

## Details worth knowing

- **Logs** are JSON lines because the container's stdout is not a terminal. For human-readable lines pass the command explicitly: `… ghcr.io/synacl-iot/synacl-gateway run --log-format text`. `--log-level debug` works the same way.
- **The instance lock.** The gateway records its pid and hostname in `/data/state/…/run.lock`. A recreated container has a new hostname, so a lock left by the previous container is taken over with one log line (`taking over a lock left by another host`) rather than refusing to start; a restarted container reuses pid 1 and is handled too. Never run two containers on the same volume at the same time — and never two gateways with the same gateway id anywhere, which the broker answers by disconnecting one of them (`session takeover` in the log).
- **Bind mounts.** A named volume inherits the image's ownership of `/data`. A bind mount does not: `chown 1000:1000` the host directory first, or `init` fails with `cannot write /data/config.json (EACCES)`.
- **Stopping.** `docker stop` waits 10 s by default; the gateway needs about a second to publish its offline status and disconnect. The Compose file allows 20 s.
- **Time.** The container uses the host's clock; keep the host synchronised. The gateway warns when it is more than two seconds off the platform.
- **Third-party drivers** install into the volume, because `driverDir` defaults to `$SYNACL_GATEWAY_HOME/drivers`:

  ```sh
  docker run --rm -v synacl:/data --entrypoint npm ghcr.io/synacl-iot/synacl-gateway i --prefix /data/drivers synacl-driver-example
  ```

  then add the package to `drivers` in `/data/config.json` (for example with `docker run --rm -it -v synacl:/data --entrypoint sh ghcr.io/synacl-iot/synacl-gateway`) and restart the container.
- **What is in the image**: `bin/`, `src/`, `protocol/`, the production dependencies and the licence files — no tests, examples or scripts. The Modbus simulator (`scripts/modbus-sim.js`) needs a checkout of the repository.
