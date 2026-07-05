# How to promote sandbox state to a committable fixture

You have been working in the sandbox interactively — signing in test users,
creating documents — and you want to commit that state so teammates, tests, and
CI all start from the same place. `pyric snapshot` promotes the lived sandbox
state into a single fixture file that `pyric verify` and `pyric serve --seed`
can consume.

The flow is: build state in `serve` → run `pyric snapshot` → commit the file →
re-seed with `pyric serve --seed <file>`.

For the full flag list, see the [`pyric snapshot`
reference](../reference/cli.md#pyric-snapshot).

## Build up the state

Run a persisted serve and use the app — sign in, write documents, whatever you
want the fixture to capture:

```sh
pyric serve --persist
```

`--persist` writes runtime state to `.pyric/state/state.json` as you go, so
your data survives between sessions while you build it up.

## Promote it to a fixture

With that serve still running, snapshot it:

```sh
pyric snapshot
```

This reads the live serve and writes a re-servable fixture to
`pyric-state.json` (both docs and auth users). Choose a different path with
`--out`:

```sh
pyric snapshot --out fixtures/onboarding.json
```

`pyric snapshot` refuses to clobber an existing file. Pass `--force` to
overwrite it.

If the live serve is on a non-default port, point at it with `--port`:

```sh
pyric snapshot --port 5002
```

If no serve is running, `pyric snapshot` falls back to the on-disk
`.pyric/state/state.json`, so you can still promote state from a serve you have
since stopped.

## Commit the fixture

The fixture is a plain JSON file meant to live in your repository:

```sh
git add fixtures/onboarding.json
git commit -m "Add onboarding fixture"
```

User passwords are **redacted by default** — `.pyric/` is gitignored, but a
promoted fixture is not, so committing raw passwords would leak them. The
redaction sentinel round-trips through seeding, so re-serving still works
(popup and helper sign-in need no password).

To keep passwords for a local-only fixture you do not intend to commit, opt in
explicitly:

```sh
pyric snapshot --out local-fixture.json --include-passwords
```

Only do this for trusted, local fixtures — never commit a fixture produced this
way.

## Re-seed from the fixture

Anyone with the committed file can start from exactly the same state:

```sh
pyric serve --seed fixtures/onboarding.json
```

See [serve persistence and multi-tab](./serve-persistence-and-multi-tab.md) for
more on `--seed` and how seeded state interacts with `--persist`.

## Machine-readable output

For scripts and CI, `--json` emits the result (output path, doc and user
counts, source, redacted-password count) to stdout:

```sh
pyric snapshot --out fixtures/onboarding.json --json
```
