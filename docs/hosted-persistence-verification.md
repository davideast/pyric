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

The 200 writes/sec overload case remains **unsupported**: 11,979 offered,
11,019 completed, 960 harness refusals, zero service errors, p95 336 ms.
RSS reached roughly 528 MB. This is not a passing load case and does not resolve
the separate capacity/memory issue. [Raw overload results](hosted-persistence-overload-results.json).

These workload measurements preceded the final Storage ordering and strict-codec
validation fixes; their workload only mutates Firestore documents. They do not
measure concurrent Storage traffic.

At the baseline 100 documents with 256-byte padding, SQLite open plus full
validation took **1.43 / 2.96 / 1.55 ms**. Total in-process hosted-runtime readiness
took **6.06 / 4.64 / 2.85 ms**, excluding CLI module loading, asset preparation,
and HTTP binding. [Startup measurements](hosted-persistence-startup.json).

## Remaining acceptance work

1. Adapt the Node cases in `host-tool-sessions.pw.ts` and
   `section-one-capacity-retention.pw.ts`. Their original fault injection holds
   Firestore commits by blocking exports of existing Storage BLOBs. SQLite
   intentionally performs no such exports. Two initial MCP suites were migrated
   successfully; a trial migration of these stronger retention checks did not
   reproduce their exact hold/release boundaries and was reverted. Preserve
   their 64-session, 256-operation and 24 MiB assertions. Do not skip them or
   claim a capacity pass based only on the simpler suites.
2. Complete the Orbit restart/file walkthrough in a disposable copy. Do not
   overwrite or reset the user's running Orbit state.
3. Run native Windows archive/open-file checks. Injected EBUSY/EPERM retries
   passed on macOS; that is not a native Windows result.
4. Finish combined acceptance and review the final candidate. The hosted e2e
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
report before activating a repaired copy. These manual observations are not
recorded as completed here.
