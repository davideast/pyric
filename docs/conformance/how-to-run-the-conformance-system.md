# How to run the conformance system

This guide shows you how to operate Pyric's conformance system — the
machinery that proves the public Firebase mirror matches real Firebase
behaviour. It assumes you know what the system is; each section is a task.
All commands run from the repository root.

The one rule that governs every task here: **evidence flows in, claims flow
out, and only the registry changes claims.** Whatever you run below either
produces evidence, checks evidence against claims, or regenerates views of
claims. Nothing else edits `COMPAT.md` — ever.

## Run the everyday gates

To check the whole system is coherent:

```sh
bun run compat:validate    # registry/observation linkage — must report 0 problems
bun run compat:report      # coverage inventory (rows, statuses, evidence counts)
bun run compat:audit       # high-risk conforming rows lacking evidence, vs the ratchet baseline
```

To check the generated docs match the registry:

```sh
bun run compat:generate    # regenerates packages/pyric/docs/*/COMPAT.md
git diff --stat packages/pyric/docs
```

If `git diff` shows changes you did not intend, you edited a `COMPAT.md` by
hand or forgot to regenerate after a registry edit. Fix the registry, never
the generated file.

To check the pinned baseline is still valid for the installed SDKs:

```sh
bun run compat:oracle-versions
```

If this fails after a `firebase` or `firebase-admin` bump, the committed
observations no longer vouch for the installed version — re-capture (see
below) before trusting any conformance result.

## Run the conformance suites

The suites replay every committed observation against the sandbox. They run
inside the normal package tests:

```sh
bun test packages/pyric/test/auth/oracle-conformance.test.ts
bun test packages/pyric/test/firestore/oracle-conformance.test.ts
bun test packages/pyric/test/database/oracle-conformance.test.ts          # rtdb-* (non-modular)
bun test packages/pyric/test/database/modular/oracle-conformance.test.ts  # rtdb-modular-*
bun test packages/pyric/test/storage/oracle-conformance.test.ts
bun test packages/pyric-admin/test/app/oracle-conformance.test.ts         # admin-app-*
```

Each suite ends with a completeness test: every observation with that
surface's filename prefix must be asserted in the suite or listed in its
`NOT_APPLICABLE` map with a written reason. If you add an observation and the
completeness test fails, that is the system working — write the replay test
or the exception, never delete the capture.

If a suite fails after a `src/` change, rebuild first: package exports
resolve to `dist/`, while many tests import `src/` directly, so an unbuilt
tree tests two different versions of your change.

```sh
bash scripts/build.sh
```

## Run the registry-linked conformance probes

```sh
bun run compat:oracle-check
```

This replays each registry `conformanceChecks` entry and verifies the
committed observation's values still match the row's `expect` block (so a
capture cannot be edited to make a probe pass). A failure is classified as
either an infrastructure problem or a genuine contradiction of the pinned
baseline — read the classification before assuming which.

## Capture new observations (behaviour oracle)

You need a dedicated Firebase project and its web config. This is the only
task here that touches the network.

```sh
export PYRIC_ORACLE_FIREBASE_CONFIG='{"apiKey":"…","authDomain":"…","projectId":"…","storageBucket":"…","appId":"…"}'
bun run scripts/oracle/run.ts
```

Each probe writes `scripts/oracle/observations/<name>.json`. Re-running
overwrites in place — **the git diff is the drift report**: an unchanged file
means production still behaves as pinned; a changed file means cloud
behaviour moved and the affected rows need review before you commit.

To add a probe, append to the `probes` array in `scripts/oracle/run.ts` with
a `name`, `rowIds` (the registry rows it locks), a one-line `description`,
and an `observe()` returning a small JSON-serialisable object of
environment-independent facts. Keep prod noise (UIDs, wall-clock timestamps,
run ids) out of values you intend tests to assert.

Admin bootstrap captures (`admin-app-*`) need no credentials or network —
`firebase-admin`'s app registry is in-process code. They carry
`adminSdkVersion` instead of `fbSdkVersion`.

## Record a divergence

When the sandbox contradicts a committed observation:

1. **Pin both sides in the surface's conformance suite** — assert the prod
   value from the JSON where it holds, and the sandbox's actual behaviour
   alongside, with a comment naming the divergence. Never weaken an
   assertion to make it pass.
2. **Flip the registry row** to `diverged-documented` and rewrite its
   `behavior`/`evidence` to state both sides and cite the observation and
   the pinning test.
3. Regenerate the docs and re-run `compat:validate`.

When a divergence is later fixed, reverse the flow: the pinned test flips to
full-conformance assertions, the row flips to `conforms`, docs regenerate.
The two-sided pin is what makes the fix's regression test already exist.

## Run the surface census

```sh
bun run compat:census            # gate: exits non-zero on UNMAPPED symbols
bun run compat:census -- --report
```

The census diffs runtime export sets per mirror pair. Every upstream export
must be mapped by the mirror or listed in
`scripts/compat/surface-denylist.ts` with a reason. Triage an UNMAPPED
symbol into exactly one of: implement it, deny it with an honest reason, or
file it as a registry gap. Extra Pyric-only exports are reported
informationally and never fail. The census is not yet wired into CI — it
still reports unmapped symbols from its first run.

## Run the live rules parity packs

Requires the `PARITY_SA_BASE64` secret (a service account holding only
`firebaserules.rulesets.test`), base64-encoded:

```sh
set -a; source /path/to/.env; set +a   # or export PARITY_SA_BASE64=…
bun test packages/pyric/test/rules/parity
```

This is a synchronous dual-run against Google's hosted Rules Test API (not
the emulator — Pyric never uses the emulator). Note the stress packs
currently *report* their `SIM_BUG` tallies rather than asserting on them;
read the pack summaries, not just the exit code.

## Run the full pre-release sequence

From a clean tree, in order:

```sh
bash scripts/build.sh
bun test packages/pyric packages/pyric-admin packages/pyric-tools packages/ui
bun run compat:validate
bun run compat:generate && git diff --exit-code packages/pyric/docs
bun run compat:oracle-versions
bun run compat:oracle-check
bun run compat:audit
bun run test:packaging
bash scripts/install-matrix.sh npm && bash scripts/install-matrix.sh pnpm && bash scripts/install-matrix.sh bun
```

If any gate fails, fix and restart from the failed gate; the sequence is
ordered so cheap, specific failures surface before expensive, broad ones.
Note that CI runs the packaging and install-matrix gates only on PRs
carrying the `ci-packaging` label — an ordinary green PR has **not** run
them, so this sequence is mandatory before any publish.
