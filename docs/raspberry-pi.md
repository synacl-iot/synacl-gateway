# Raspberry Pi

A Raspberry Pi is the typical home for synacl-gateway: it sits next to the equipment, stays on, and has enough of everything. This page covers what is specific to a Pi; the general setup is in the [README](../README.md).

Tested target: a Pi 3, 4, 5 or Zero 2 W on **64-bit Raspberry Pi OS**. Use the 64-bit image (Raspberry Pi Imager offers it for every board that supports it); the Node.js packages below are built for `arm64`.

## 1. Node.js

synacl-gateway needs Node.js 20.11 or newer, and 22 LTS is recommended. Check what you have:

```sh
node --version
```

- **Raspberry Pi OS Bookworm** (Debian 12): `apt` ships Node 18, which is too old — synacl-gateway refuses to start with `synacl-gateway needs Node.js 20.11 or newer (22 LTS recommended); this is v18.19.0.` Install Node 22 from NodeSource instead:

  ```sh
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

  This replaces Bookworm's `nodejs` package and includes `npm`.

- **Raspberry Pi OS Trixie** (Debian 13): `apt` ships Node 20, which works:

  ```sh
  sudo apt install nodejs npm
  ```

  `synacl-gateway doctor` will note `Node 20 is past end of life`; NodeSource's Node 22 (the same two commands as above) removes the note.

Node from NodeSource or `apt` lives in `/usr/bin/node`, which is what the systemd unit expects. A Node from `nvm` or another version manager works for running in the foreground, but a service pinned to it breaks when you switch versions; `service install` warns about that.

## 2. Install and register

```sh
sudo npm i -g synacl-gateway
synacl-gateway --version
```

In the Synacl app create the gateway (**Gateways → Add gateway → Software gateway**) and paste its **Quick start (Node.js)** line into a terminal on the Pi **as the normal user** (`pi`, or whatever you named it) — not with `sudo`, so that `config.json` lands in that user's home:

```sh
 npx -y synacl-gateway@latest init --broker mqtts://mqtt.synacl.com:8883 --tenant <id> --gateway <gw_…> --user <username> --pass <password> && npx -y synacl-gateway@latest run
```

(With the package installed globally you can write `synacl-gateway` instead of `npx -y synacl-gateway@latest`; the leading space keeps the password out of the shell history.) When `init` prints `Connected: credentials accepted, 7/7 subscriptions granted.` and `run` shows `connected`, the gateway is online in the app. Stop it with Ctrl-C and install the service:

```sh
synacl-gateway service install
```

It prints the commands it is about to run, asks for your `sudo` password, and starts the unit. The unit runs as your user with `SYNACL_GATEWAY_HOME=/home/<user>/.synacl-gateway`, waits for the network and time sync at boot (`After=network-online.target time-sync.target`), restarts 5 s after a crash, and gives the gateway 20 s to publish `{"online":false}` on stop. It also confines the process: a read-only view of the system and of `/home` except the gateway's own directory, no new privileges, a private `/tmp`.

```sh
synacl-gateway status                  # the gateway's own view: connection, config sync, buffer, devices
systemctl status synacl-gateway
journalctl -u synacl-gateway -f        # JSON lines; add --output cat for the raw lines
```

The Pi shows up as a device too: add a **Host metrics** device under the gateway with tags for `cpu.temp`, `cpu.load`, `mem.used_pct` and `disk.used_pct`. `synacl-gateway metrics` shows the values first.

## 3. The clock

A Pi has no real-time clock. It boots with a wrong time and corrects it once it reaches an NTP server — which, on a slow link or a network that blocks NTP, can take a while or never happen. Readings are timestamped on the Pi, so this matters:

- The gateway checks its clock against the platform at start-up and every six hours and logs `the system clock is 47.0 s behind the platform — readings carry this machine's timestamps; enable time sync (e.g. timedatectl set-ntp true)` when it is off by more than two seconds. `synacl-gateway doctor` reports the same.
- Readings taken while the clock still reads a year before 2025 are **not buffered** (`the system clock is not set (year before 2025); readings are not buffered until it is`); they would be replayed with an impossible timestamp.
- The gateway's own presence is unaffected: the heartbeat carries no timestamp, so a wrong clock never makes the gateway look offline.

Check and enable time sync:

```sh
timedatectl                            # "System clock synchronized: yes"
sudo timedatectl set-ntp true
```

The unit orders itself after `time-sync.target`, but on Debian that target is reached as soon as the time service has *started*, not when the clock is actually set. If your systemd has `systemd-time-wait-sync.service`, enabling it makes the target wait for a real sync:

```sh
sudo systemctl enable --now systemd-time-wait-sync
```

A Pi that runs where NTP cannot be reached is best given a real-time clock module (the Pi 5 has a header for one).

## 4. Networking

- **Wi-Fi or Ethernet** is reported in the heartbeat (`uplink`), read from the default route and `/sys/class/net/<iface>/wireless`; the app shows it on the gateway card.
- Outbound TCP **8883** to `mqtt.synacl.com` is all the gateway needs. If a firewall blocks it, `init` says `no answer from mqtt.synacl.com:8883 within 15 s (ETIMEDOUT)` and suggests `--broker wss://mqtt.synacl.com/mqtt` (MQTT over WebSocket on 443).
- Modbus TCP devices and local brokers are reached on the LAN; give them fixed addresses (a DHCP reservation) so the device settings stay valid.
- The gateway opens no listening port.

## 5. Disk

Everything the gateway writes is under `~/.synacl-gateway`: `config.json`, the per-gateway state (a few small files) and the store-and-forward buffer. Readings taken while the cloud is unreachable are appended to the buffer synchronously, one line per reading, up to 64 MiB and 7 days by default (`backfill.maxBytes`, `backfill.maxAgeHours` in `config.json`); on an SD card that is a modest write load even during a long outage. `synacl-gateway status` shows how much is waiting.

## 6. Updating and removing

```sh
sudo npm i -g synacl-gateway@latest && sudo systemctl restart synacl-gateway
```

The version the gateway reports to the platform (shown as its firmware in the app) is the package version. To remove it:

```sh
synacl-gateway service uninstall       # stops and removes the unit; config.json and state are kept
sudo npm rm -g synacl-gateway
rm -rf ~/.synacl-gateway               # the settings, state and buffer
```

## Docker on a Pi

The image is built for `linux/arm64` and runs on a 64-bit Pi OS with Docker installed; see [docker.md](docker.md). Prefer the native install on a Pi that does nothing else: it is smaller, starts faster, and `cpu.temp` and the network counters need no extra flags.
