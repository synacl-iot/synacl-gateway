<!-- Thanks. A few lines are enough; the checklist is what reviewers look for. -->

## What this changes

<!-- What and why. Link the issue: "Fixes #12". For a behaviour change, say what a user sees before and after. -->

## How it was tested

<!-- The test you added or the one that failed before this fix; anything you ran against real equipment or the live platform. -->

## Checklist

- [ ] `npm test` and `npm run conformance` pass locally.
- [ ] A test covers the change (a bug fix includes the test that failed before it).
- [ ] `CHANGELOG.md` has a line under *Unreleased*.
- [ ] Commits are signed off (`git commit -s`, the DCO).
- [ ] Nothing under `protocol/v1/` was edited by hand (only `npm run schemas:sync` changes it), and `src/core/types.js` is unchanged — or the issue agreed on the contract change and every module it touches is in this PR.
- [ ] No credential can reach a log line, an error message, a status reason or the wire (new secrets are registered with `log.redact()`).
- [ ] Documentation under `docs/` and the CLI `--help` text still match the behaviour.
