# Main integration checkpoint

2026-09-15. Integrated main `8bf806d07b526c293231a87cff98b339f5432fd4`
(including AI observability PR #651) into feature revision
`5f8129f95a7b1a0b6f3089a84169ca548f5902bb` on `hosted-main-integration`.
The integration worktree is `/tmp/pyric-hosted-main-integration`. The original
`hosted-live-mode` checkout and manual demos were not modified.

## Resolutions

The merge conflicted in 19 files. Resolutions retain:

- Typed Firestore values, converters, modular transaction snapshots, captured
  write options, request validation and cloneable aggregate replies, with main's
  single public SDK activity reporting and host-side duplicate suppression.
- Listener recovery, auth/lens ownership, RTDB connection metadata projection and
  app deletion cleanup. Flow consumes the activity journal instead of receiving
  a second direct delivery notification.
- Bounded event history and explicit gaps, plus main's 64-record Rules-evidence
  lifetime. Evidence retention now tracks entry identity, releases evicted
  entries, and updates byte accounting when evidence expires. Returned snapshots
  remain unchanged. Two additional regressions cover eviction, clear, expiry,
  byte bounds, and the browser fallback without Buffer.
- Hosted admission, state ownership, payload limits and startup/shutdown together
  with project captures, thresholds, indexes, repeated atomic Rules-file saves,
  and missing-Studio handling.
- Main's AI configuration display and evidence metadata, including the validator
  boundary. Hosted and in-page runtime labels remain accurate.

A clean merge also required changing main's new capture tool registry from a
name list to this branch's read/write effect map. Package versions and the
jsonc-parser dependency follow main. Generated manifests/projections were
regenerated; generated artifacts are not committed.

## Verification

- Pyric production, CLI production and dedicated hosted-fixture TypeScript
  projects pass without diagnostics.
- 269 distinct tests in 27 isolated files pass. Files execute serially in
  separate Bun processes; repeated checks are not added to the count.
- 13 browser cases in five files pass with one worker and no retries, in 1.5
  minutes: converter lifecycle (three runtimes), transaction converters (three
  runtimes and reference reuse), hosted identity-preserving reconnect, malformed
  reply envelopes (three paths), and count/byte history retention.
- Conflict-resolution code-form review covers 22 files against the fetched main
  revision, with zero findings. This is not a new whole-repository style audit.
- All five browser leaves pass unchanged byte ceilings: client 67,976/98,304,
  socket 13,452/16,384, RTDB 18,485/32,768, codec 18,649/24,576 and live
  387,843/524,288 in the initial integration measurement. Exact browser diagnostics
  leaves from main were reviewed and added to the module allowlist; no broad
  engine exception or increased byte limit was introduced. The ownership document
  records the added responsibilities.
- The new AI in-page display initially failed its existing test, then passed
  after preserving the in-page runtime row alongside the hosted row.
- A capture HTTP test initially could not bind localhost within the execution
  sandbox. The unchanged test passed with local networking permitted. This setup
  failure is excluded from passing evidence.

The browser run used stable generated assets. Subsequent edits name equivalent
conditions; the affected history/core/UI/routing tests and strict type projects
were repeated. Full browser/package/soak acceptance was not repeated.

Local reports are `/tmp/pyric-integration-*-types-final.log`,
`/tmp/pyric-integration-checks/`, `/tmp/pyric-integration-browser-tests.log`,
`/tmp/pyric-integration-*-boundary-final.json`, and
`/tmp/pyric-integration-form.json`. They are local artifacts, not committed
passing assertions for another revision.

Browser command from the integration root:

```sh
/tmp/node-v22.15.0-darwin-arm64/bin/node node_modules/@playwright/test/cli.js test \
  -c packages/cli/test/e2e/hosted/playwright.config.ts \
  converter-lifecycle.pw.ts transaction-converter.pw.ts reply-envelope.pw.ts \
  reconnect-listener.pw.ts section-five-history.pw.ts --workers=1 --max-failures=1
```

## Remaining work

This checkpoint closes merge resolution, not the full hosted/live release.
The slow-client RSS gate remains open and has not been rerun here. The packaging
script's orphan-process cause remains to be fixed before more packaging runs.
No package was published, no PR was opened, and no fresh installed-package or
phone/Tailscale acceptance is claimed. SharedWorker remains the default and hosted
remains opt-in. Live mode is still the early read proof described in the existing
milestone documents.

Next: repair packaging-process teardown, then evaluate the existing RSS workload
on this integrated source before resuming broader live-mode development.
