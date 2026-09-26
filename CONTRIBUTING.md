# Contributing

Thank you for helping. Bug reports, fixes, drivers and documentation are all welcome. This page says how the project is built and what a change needs to land.

## Setting up

You need **Node.js 22** (the CI also runs the suite on 20 and 24, and the release on 24) and git.

```sh
git clone https://github.com/synacl-iot/synacl-gateway.git
cd synacl-gateway
npm ci                        # exact versions from package-lock.json
npm test                      # 445 tests with node:test, about 30 s
npm run conformance           # the 23 protocol scenarios against the scripted platform
node bin/synacl-gateway.js --help
```

`npm test` runs every `test/**/*.test.js`; extra arguments go to `node --test`, so `npm test -- --test-name-pattern modbus` runs a subset. Shared test helpers live in `test/_support/` and are never named `*.test.js`. There is no build step, no transpiler and no linter to run: the code is plain ES modules with JSDoc types.

To try a change against the real platform, register a software gateway in your Synacl account and run `node bin/synacl-gateway.js init …` and `… run` from the checkout with `SYNACL_GATEWAY_HOME` pointed at a scratch directory, so your real settings are untouched.

## How the code is organised

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the map: the lifecycle, the rules that keep a gateway in good standing with the platform, and how the modules fit.
- **`src/core/types.js`** freezes the interfaces between modules — the driver API, the transport, the CLI command shape, every module's factory signature. Changing a shape there changes a contract: it is edited only by the maintainer, and a change lands together with every module it touches. If your change needs a new shape, say so in the issue first.
- Every module is a factory that receives its collaborators (`clock`, `log`, `transport`, …) as arguments. Nothing reaches for a singleton or a global timer. That is what lets the conformance suite run the real core against an in-memory broker and a virtual clock, and it is what makes a module testable on its own — keep it that way.
- **`protocol/v1/`** is the wire contract (topics, JSON Schemas, examples), vendored from its home at [synacl.com/protocol/v1](https://synacl.com/protocol/v1/). **It is never edited by hand.** `npm run schemas:check` compares the vendored copy with the mirror (a weekly workflow opens a `protocol-drift` issue when they differ); `npm run schemas:sync` rewrites it from the mirror. A protocol change is a platform change first; this repository follows.
- Drivers live in `src/drivers/`, the CLI in `src/cli/` (one module per command, each owning its flags and help), the conformance suite in `src/conformance/` (scenarios in `scenarios/`, one file each, also run by `test/conformance/`).

## Making a change

1. Open an issue for anything beyond a small fix, so the approach can be agreed before you spend time on it.
2. Write a test. A bug fix comes with the test that failed before it; a feature comes with tests for its behaviour and, when it touches the wire, a conformance assertion.
3. Keep the wire honest. Anything the gateway sends must validate against the schema for its topic (the publisher checks this; the conformance suite runs strict), and the pacing rules in the architecture document are not negotiable — the platform enforces them silently.
4. Never log or print a credential. Register secrets with `log.redact()`; the harness and the tests check for leaks.
5. Add a line to `CHANGELOG.md` under *Unreleased*.
6. Sign off your commits (below) and open a pull request. The template lists what reviewers look for.

Style: small modules, plain functions, JSDoc for every exported function, comments that explain *why* (the platform behaviour a line exists for), no dependencies added without a reason stated in the PR. Spelling is US English.

## Sign-off (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/) instead of a contributor agreement. Every commit needs a `Signed-off-by` line stating that you wrote the change or have the right to submit it under the project's licence:

```sh
git commit -s
```

adds it from your git name and e-mail. Pull requests whose commits lack it cannot be merged.

## Proposing a driver

Most drivers should be **separate packages**, not part of this repository: publish `synacl-driver-<protocol>` with the `synacl-driver` keyword, `synacl-gateway` as a peer dependency, and a test that runs `assertDriver` from `synacl-gateway/testing`. [`docs/writing-a-driver.md`](docs/writing-a-driver.md) is the API and [`examples/drivers/synacl-driver-example`](examples/drivers/synacl-driver-example) the template. Open an issue titled *Driver: <name>* with the package link and we will list it.

A driver belongs **in this repository** when it serves a protocol the Synacl app offers on a software gateway and most users of that protocol would expect it to be there. Propose it in an issue first: what equipment, which protocol name the platform uses, what the device and tag settings are, and what the reachability reasons will be. A built-in driver is held to the same standard as the three existing ones — pooled connections, reasons that name the cause, no value published in place of a failed read, logs on change only — and comes with unit tests against a fake of the equipment (see `test/drivers/`).

## Releases

Maintainers release by tagging: `vX.Y.Z` on `main` runs the tests, publishes to npm with provenance, builds the multi-arch image, and creates the GitHub release from the matching `CHANGELOG.md` section. A tag with a `-` (`v0.2.0-rc.1`) is a pre-release: npm dist-tag `next`, no `latest` image tag.

## Questions

Open a discussion or an issue. Problems with a Synacl account, plan or the app itself go to support@synacl.com. Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.
