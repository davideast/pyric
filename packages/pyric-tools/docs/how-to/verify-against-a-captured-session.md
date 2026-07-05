# How to verify your rules against a captured session

`pyric verify` replays a captured sandbox session against a ruleset and reports
**real divergences** — writes that succeeded in the sandbox while you were
building, but that your new rules would deny or silently change. It answers the
one question that makes "build in the sandbox, swap to prod" safe: *will the
rules I'm about to ship break what I built?*

## Capture a session, then verify

Capture is on by default in `pyric serve`, so the loop is just three steps.

1. Start the sandbox. The session is written to `.pyric/last-session.json` as
   you go:

   ```sh
   pyric serve
   ```

   (Pass `--no-capture` to disable the recording.)

2. Exercise your app against the running sandbox — sign in, create documents,
   run the journeys you care about. Every write is recorded.

3. Replay the latest capture against the rules you intend to deploy:

   ```sh
   pyric verify
   ```

   With no positional argument, `verify` reads `.pyric/last-session.json` and
   checks it against `firestore.rules` in the current directory.

## Verify against edited rules

If you've tightened or rewritten your rules and want to check them before
deploying, point `--rules` at the file:

```sh
pyric verify --rules path/to/firestore.rules
```

The capture stays fixed; only the ruleset changes. The diff between what the
sandbox allowed and what these rules allow is exactly what surfaces.

## Verify a specific fixture

To replay a saved fixture instead of the latest capture, pass its path:

```sh
pyric verify journeys/checkout.json
```

## Interpreting the result

A session **fails** (exit code `1`) when the replay finds a real divergence: a
write that succeeded in the sandbox would now be denied, or would land with
different data. Each failing leaf is named with its path and the
`before → after` delta so you can see which rule bites:

```
✗ checkout — 1 real-divergence(s)
    orders/abc123.status: "paid" → null
```

Other divergences — `autoid-alias`, `time-drift`, `sentinel-drift` — are
**informational**. The replay engine licenses them (they're expected artefacts
of replaying server-generated IDs, timestamps, and sentinels), so they're
listed but do **not** fail the run. A clean run exits `0`:

```
✓ checkout — 0 informational divergence(s)

✓ all sessions replay cleanly under firestore.rules.
```

## Run a suite in CI

To verify many captured journeys at once, point `verify` at a directory. Every
`*.json` fixture in it is replayed and the command exits non-zero if any one
diverges:

```sh
pyric verify journeys/ --rules firestore.rules
```

Add `--json` for machine-readable output to feed into a dashboard or gate.

A minimal CI step — fail the build if any captured journey would break under
the rules being shipped:

```yaml
- name: Verify rules against captured journeys
  run: pyric verify journeys/ --rules firestore.rules
```

The non-zero exit on a real divergence is what blocks the merge.

For the full flag list, see the [`pyric verify` reference](../reference/cli.md#pyric-verify).
