# synacl-gateway

**The reference gateway for [Synacl](https://synacl.com): turn any machine that runs Node.js — a Raspberry Pi, a mini PC next to your panel, a container — into a Synacl gateway.**

> **Status: in development.** The first release, 0.1.0, is being built in the open here. The npm name `synacl-gateway` is reserved; until 0.1.0 is published, `npx synacl-gateway` only prints a notice.

## What it does

A Synacl gateway sits between your equipment and the platform. It keeps one MQTT connection to the cloud, receives its device list from the platform, reads each device on its interval, and publishes the readings. This project does that in Node.js, so you don't need our ESP32 hardware or firmware.

0.1.0 ships with three drivers:

| Driver | Reads |
|---|---|
| **Host metrics** | CPU load and temperature, memory, disk, uptime and network throughput of the machine it runs on |
| **Local MQTT bridge** | Topics on a broker you already have — Tasmota, zigbee2mqtt, Home Assistant — mapped onto Synacl devices |
| **Modbus TCP** | Holding/input registers and coils on any Modbus TCP device, including 32-bit integers and floats |

It also buffers readings while the connection is down and replays them afterwards, evaluates each tag's alarm band locally, runs as a systemd service, ships as a Docker image, and includes a conformance suite you can run against your own driver or gateway.

## The protocol is public

Everything a gateway says and hears is documented at **[synacl.com/protocol](https://synacl.com/protocol/)**, with a JSON Schema for every message. This project is one implementation of it; you can write your own in any language.

## License

[Apache-2.0](LICENSE). Copyright 2026 Synacl Labs.
