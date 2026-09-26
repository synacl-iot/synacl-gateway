# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- **Preferred:** GitHub's private vulnerability reporting on this repository — *Security* tab → *Report a vulnerability*. It keeps the report, the discussion and the fix private until an advisory is published.
- **Or** e-mail support@synacl.com with `synacl-gateway security` in the subject.

Include what you found, how to reproduce it, the version (`synacl-gateway --version`) and, if you have one, a suggested fix. Plain text is fine.

## What to expect

synacl-gateway is maintained by a small team. We will acknowledge a report within five business days, tell you whether we agree it is a vulnerability and how we intend to fix it, and keep you informed until a fix ships. Fixes go out as a patch release on npm and as a new image tag, with a GitHub security advisory that credits you unless you prefer otherwise. We ask that you give us a reasonable time to release a fix before disclosing publicly; we will not take action against good-faith research on your own gateway and account.

There is no bug bounty.

## Scope

In scope here: this repository — the CLI, the gateway core, the built-in drivers, the driver API and test harness, the Docker image and the release workflows. Examples: a credential that reaches a log or the wire, a way for a device on the local network to make the gateway misbehave, a message from the broker that crashes or hangs the gateway, a file written with the wrong permissions, a dependency with a known vulnerability that the gateway is exposed to.

Not in scope here: the Synacl platform, its broker, API and web apps, and the ESP32 firmware. Report those to support@synacl.com directly. Third-party drivers are the responsibility of their authors.

## Supported versions

The latest release of the current minor line receives security fixes. Older lines do not. Update with `npm i -g synacl-gateway@latest` or by pulling the image.

## Verifying what you install

Releases are published with npm provenance (`npm audit signatures` verifies them) and the Docker image carries build provenance and an SBOM. The threat model and where secrets live are described in [docs/security.md](docs/security.md).
