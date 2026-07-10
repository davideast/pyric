---
title: "How to promote sandbox state to a committable fixture"
navLabel: "Promote sandbox state"
group: "pyric-tools"
section: "How-to"
order: 39
---
# How to promote sandbox state to a committable fixture

You have been working in the sandbox interactively (signing in test users,
creating documents) and you want to commit that state so teammates, tests, and
CI all start from the same place. `pyric snapshot` promotes the lived sandbox
state into a single fixture file that `pyric verify` and `pyric dev --seed`
can consume.

The flow is: build state in `dev` → run `pyric snapshot` → commit the file →
re-seed with `pyric dev --seed <file>`.

For the full flag list, see the [`pyric snapshot`
reference](../pyric-tools-reference-cli/).

## Build up the state

Run a persisted dev server and use the app: sign in, write documents, whatever you
want the fixture to capture:
```sh
pyric dev --persist
```
`--persist` writes runtime state to `.pyric/state/state.json` as you go, so
your data survives between sessions while you build it up.

## Promote it to a fixture

With that dev server still running, snapshot it:
```sh
pyric snapshot
```
This reads the live dev server and writes a re-servable fixture to
`pyric-state.json` (both docs and auth users). Choose a different path with
`--out`:
```sh
pyric snapshot --out fixtures/onboarding.json
```
`pyric snapshot` refuses to clobber an existing file. Pass `--force` to
overwrite it.

If the live dev server is on a non-default port, point at it with `--port`:
```sh
pyric snapshot --port 5002
```
If no dev server is running, `pyric snapshot` falls back to the on-disk
`.pyric/state/state.json`, so you can still promote state from a dev server you have
since stopped.

## Commit the fixture

The fixture is a plain JSON file meant to live in your repository:
```sh
git add fixtures/onboarding.json
git commit -m "Add onboarding fixture"
```
User passwords are **redacted by default**: `.pyric/` is gitignored, but a
promoted fixture is not, so committing raw passwords would leak them. The
redaction sentinel round-trips through seeding, so re-serving still works
(popup and helper sign-in need no password).

To keep passwords for a local-only fixture you do not intend to commit, opt in
explicitly:
```sh
pyric snapshot --out local-fixture.json --include-passwords
```
Only do this for trusted, local fixtures. Never commit a fixture produced this
way.

## Re-seed from the fixture

Anyone with the committed file can start from exactly the same state:
```sh
pyric dev --seed fixtures/onboarding.json
```
See [serve persistence and multi-tab](../pyric-tools-how-to-serve-persistence-and-multi-tab/) for
more on `--seed` and how seeded state interacts with `--persist`.

## Machine-readable output

For scripts and CI, `--json` emits the result (output path, doc and user
counts, source, redacted-password count) to stdout:
```sh
pyric snapshot --out fixtures/onboarding.json --json
```