# Hosted persistence implementation checkpoint

Status: core implementation and focused verification complete; combined acceptance
is still open. This is an implementation checkpoint, not release approval.

Worktree: `/tmp/pyric-hosted-main-integration`, branch `hosted-main-integration`.
Base: `470ba3d493b5890d4bb4df24269613410a81bdb0`. These results exercise the
persistence implementation added after that base, not the base commit by itself.

## Automated evidence

- Actual Node 22.15 subprocess fixtures: **14 passed**. Covers records/BLOBs,
  rollback, namespace/version/malformed-record refusal, unchanged legacy JSON,
  cold runtime restoration, password-redacted snapshots, fail-closed health,
  atomic seed, fresh archives, corrupt-sidecar preservation, killed transactions,
  transient/exhausted archive retries, stale metadata and salvage. A subsequent
  focused test also proved an unsupported Node version is refused before fresh.
- Core sandbox and Storage suite: **2,131 passed, 2 existing skips**, 11.12 s.
- Worker persistence and runtime suite: **369 passed**, 8.27 s.
- Initial affected browser selection: 53 passed before stopping at three failures.
  Two failures exposed upload/reset ordering; the third expected the old JSON
  failure outcome. After fixing ordering and updating fault injection, the
  recovery selection passed 20 tests with one stale-Studio-build failure.
- Rebuilt Studio/Vite selection: **13 passed**, 26.8 s. Includes the Studio warning,
  idle-browser health propagation, Node and SharedWorker 8 MiB Storage, provider
  preservation, Vite hosted restart, ownership, and unchanged default runtime.
- Ordered Storage upload/reset checks: **4 passed** in the subsequent selection.
- MCP admission and execution checks: **5 passed**, 5.1 s, using the injected
  persistence-backend seam rather than depending on a whole-store Storage export.
- Isolated local tarball install: **6 passed**, 14.8 s. CLI and Vite each exercised
  hosted, SharedWorker and in-page runtimes through reload/restart; Vite also HMR.
  Tarballs were packed before the final Node-version guard; that guard was checked
  separately against the rebuilt Node artifact.
- Pyric, CLI and Studio compilation passed. Documentation/Studio site built.
- Changed-code-form and whitespace checks passed at this checkpoint.

These are overlapping selections, not a summed count of unique browser tests.
The complete monorepo and hosted browser suites have not passed for this change.

## Performance

The preimplementation gates remain unchanged in
[the frozen baseline](hosted-persistence-baseline.md).

At 50 writes/sec over three 60-second browser runs, all **9,000** operations
completed with **zero service errors or harness refusals**. Acknowledgment p95
was **11.2 / 9.7 / 8.9 ms**, below the absolute 25 ms budget. Worst measured
10-second event-loop p95 was **2.260991 ms**, below 4.382719 ms. Raw evidence:
[SQLite results](hosted-persistence-sqlite-results.json).

The original 200 writes/sec overload case failed: 11,979 offered, 11,019
completed, 960 harness refusals, zero service errors, p95 336 ms. RSS reached
roughly 528 MB. [Original overload results](hosted-persistence-overload-results.json).

The subsequent [capacity diagnosis](hosted-capacity-diagnosis.md) attributed the
browser overload primarily to repeated runtime-chip history processing. The
[incremental chip implementation](hosted-chip-incremental-verification.md) now
completes the same 60-second, 200/sec workload with the chip enabled: all 12,000
writes, zero errors/refusals and **3.0 ms p95**. That checkpoint also records the
new frozen-gate runs and their exact source digests. Host undo retention and the
separate slow-reader memory acceptance test remain open; the throughput result
does not close either.

The original SQLite-only workload measurements preceded the final Storage
ordering and strict-codec validation fixes. The incremental-chip measurements
include those fixes. Both workloads mutate only Firestore documents and do not
measure concurrent Storage traffic.

At the baseline 100 documents with 256-byte padding, SQLite open plus full
validation took **1.43 / 2.96 / 1.55 ms**. Total in-process hosted-runtime readiness
took **6.06 / 4.64 / 2.85 ms**, excluding CLI module loading, asset preparation,
and HTTP binding. [Startup measurements](hosted-persistence-startup.json).

## Retention and Orbit follow-up (2026-09-17)

The retention-fixture and Orbit walkthrough gaps are closed by the changes after
`1ac597ff`. This is agent-operated browser/CLI verification, not a human or phone
sign-off. The original Orbit server and its state were not used or reset.

The retention fixture now holds the actual persistence interface, supports
rearming and releasing a single flush, and holds unchanged flushes after the
first mutation. Holding only changed buckets incorrectly lets repeated writes
drain in the second round. The migrated tests preserve the original 64-session,
256-operation and 24 MiB assertions, including ±1-byte boundaries, cancellation,
queued rules failures, and charge reuse. Browser SDK reads still run against the
same host while MCP work is held. The affected retention selection passed
**12 tests in 29.7 s**, including the unchanged SharedWorker cancellation cases.
After the Auth and CLI fixes below, the final affected browser selection passed
**35 tests in 59.5 s**, adding Auth persistence and checkpoint coverage.

Orbit's real account-creation and message/attachment UI exposed two defects:

- Generated email-account UIDs included dots from the email address. Orbit used
  those UIDs in RTDB presence/typing paths and crashed. New password and email-link
  accounts now use opaque generated IDs, consistent with the existing anonymous
  and provider flows. Existing and explicitly supplied UIDs remain unchanged.
  Regression tests cover owner-scoped RTDB writes, denied access to another UID,
  sign-out, and signing back into the same identity. Auth plus worker parity:
  **389 passed**.
- The CLI parsed `sandbox salvage` as a child command and never parsed its source
  and output flags. Recovery is now recognized before child-command passthrough.
  Tests cover spaced and equals-form flags, including paths containing spaces.
  The sandbox runner/parser selection passed **26 tests**.

The repeatable [Orbit walkthrough](../examples/teams-workspace/verify-persistence.mjs)
ran with Node 22.15 and a disposable copy of the actual app, rules, seed, and
Functions source. It verified:

1. Create an account through the UI, send a message with an 8-byte binary file,
   and write a separate RTDB value.
2. Close the host and browser context, reopen, sign in with the same password,
   and compare the UID, message, RTDB value, bytes and complete Storage metadata.
   Also read the attachment URL rendered by Orbit and compare its bytes.
3. Start with `fresh: true` and no seed; reject the old account's sign-in and
   preserve exactly one archive.
4. Run the documented salvage CLI on that archive, confirm zero exclusions and
   unchanged source file hashes, activate the copy, and repeat the Orbit checks.
5. Add one malformed record to the disposable database. Startup fails closed.
   Salvage reports precisely that record, preserves every source file, recovers
   16 documents, 2 services and 1 Storage object, and restores usable Orbit state.

[Recorded results](hosted-persistence-orbit-results.json) report zero browser
errors and removal of the disposable project. The script closes browser contexts,
Vite and its owned Functions child. It also retains the partially created Vite
server when the deliberate corrupt-start check rejects, so that server's bundler
cannot leak. The final run exited with code 0; process inspection found no remaining
walkthrough or owned bundler/Functions process. Screenshots of the created and recovered
workspace are written to the OS temporary directory.

Run it from this worktree after installing its existing dependencies:

```sh
bun x tsc -p packages/pyric/tsconfig.json
bun x tsc -p packages/cli/tsconfig.json
node examples/teams-workspace/verify-persistence.mjs
```

Use Node 22.15 or later. The script binds a separate local server with strict port
selection (Vite's initial default is 5173), never reuses an existing server, and
prints the path of its JSON evidence. A busy port causes failure rather than
connecting to another app. It copies no `.pyric` state or `.env` files.

The hosted e2e typecheck still reports the three pre-existing file-level issues
listed below; it reports no errors in the changed retention fixtures. An additional
surface-derivation check found an unrelated mismatch in generated MCP descriptions;
the parser method-word invariant passed. Neither result is a full-suite pass.

## Remaining acceptance work

1. Run native Windows archive/open-file checks. Injected EBUSY/EPERM retries
   passed on macOS; that is not a native Windows result.
2. Finish combined acceptance and review the final candidate. The hosted e2e
   typecheck currently also reports pre-existing errors in
   `connection-diagnostics.pw.ts`, `messaging-recipients.pw.ts`, and
   `section-one-protocol-fixture.ts`; no errors were reported in this slice's new
   persistence test files.

## Reproducible commands

From the worktree root, with a supported Node executable:

```sh
bun x tsc -p packages/pyric/tsconfig.json
bun x tsc -p packages/cli/tsconfig.json
bun run --cwd packages/studio build
PYRIC_TEST_NODE="$(command -v node)" bun test packages/cli/test/serve/hosted-sqlite.test.ts
bun test packages/pyric/test/sandbox/ packages/pyric/test/storage/
bun scripts/check-changed-code-form.ts HEAD
git diff --check
```

For the browser checks, rebuild and copy the Studio assets first:

```sh
DOCS_BASE=/__pyric/ui/ bun run --cwd packages/site-docs build
cp -R packages/site-docs/dist/. packages/cli/dist/serve/site-ui/
node node_modules/@playwright/test/cli.js test \
  --config packages/cli/test/e2e/hosted/playwright.config.ts \
  sqlite-health section-six-studio vite-hosted vite-auth-preservation \
  storage-frame-capacity host-persistence-ordering host-reset-persistence \
  --workers 1 --timeout 30000
```

The concrete executable used for recorded Node results was
`/tmp/node-v22.15.0-darwin-arm64/bin/node`. Tests own temporary projects and stop
their hosts in `finally`; no benchmark or browser-test host is intentionally
left running.

For a human checkpoint, follow the
[recovery commands](../packages/site-docs/src/content/build/hosted-persistence.md)
in a disposable project. Confirm restart preserves a document, an account and
an uploaded file's bytes; confirm `--fresh` leaves an archive; inspect salvage's
report before activating a repaired copy. The agent-operated Orbit walkthrough above now exercises these steps; a separate
human checkpoint has not been recorded.
