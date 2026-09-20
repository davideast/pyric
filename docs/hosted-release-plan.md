# Hosted sandbox: path to a releasable main

Written 2026-09-18. Companion documents: `docs/hosted-review-ledger.md` (the item-level acceptance record, cited here by item id) and `docs/hosted-persistence-plan-review.md` (the persistence plan review and its addendum).

This document is the working plan for landing the `hosted-live-mode` branch on `main` in reviewable slices, with every known regression fixed in the slice that owns it, and with acceptance evidence that runs in CI. It is written for both the implementing agent and the reviewing agent. Sections 3 and 4 are the tracking surface; update them as items move.

## 1. Where things stand

- `main` is at `f7e90081` and has not moved since the branch's last merge from it.
- `origin/hosted-live-mode` is at `26a6ae0d`: 141 commits past main, 700 files, roughly 40,000 lines of code change plus about 35,000 lines of results JSON and progress docs.
- Typecheck passes for `packages/pyric` and `packages/cli` at the tip.
- One unit test fails deterministically at the tip (ledger I2). The branch's own code-form CI gate fails on the branch (ledger B4).
- The SQLite persistence core holds nine of twelve contract checks (review of 2026-09-17). Salvage exists.
- The committed multi-client acceptance run failed: 62,599 of 90,000 operations completed, 27,401 refused, p95 mutation latency 4,250 ms, maximum capture delay 1,025 s against a 2 s contract bound.
- Fourteen ledger items from the first review remain open at the tip, including the rule-method blocker (A1). Thirteen new items were added from the delta review (section I).

## 2. Why the branch does not merge as one pull request

The branch cannot be reviewed as a single diff. A 231-file move commit bundled behavior changes with relocations, two merges from main sit in the middle of the history, and the worst regressions are in shared foundations under `packages/pyric` and the shared browser entries, not under the hosted directory. Those regressions reach every user the moment the branch merges, whether or not they enable hosted mode.

The branch therefore becomes a reference, not the thing that merges. Slices are extracted from it by path onto fresh branches cut from `main`, fixed in place, reviewed at a size one person can hold, and merged in dependency order. Each later slice rebases on the previous one and shrinks because its dependencies are already on `main`.

Path-based extraction (`git diff main...hosted-live-mode -- <paths>` applied as one commit) is used instead of cherry-picking so the mixed history of the move commit does not matter.

## 3. Working rules

These apply to every agent touching this work.

1. **Nothing closes on the implementer's word.** A ledger item closes only when its named acceptance evidence runs green on the current tip, executed by the reviewer, not the implementer. The reviewer records the commit hash in the ledger entry. Acceptance is executable: `scripts/ledger-acceptance.json` maps items to tests and `bun scripts/verify-ledger.ts <item>` runs them. The implementing agent's brief is `docs/hosted-agent-brief.md`.
2. **Failing test first.** Every fix starts with a test or probe that fails at the seam the ledger names. Record the failing run in the commit message body.
3. **One slice per commit.** Tag commits with the slice: `fix(core): ...`, `fix(host): ...`, `fix(transport): ...`, `fix(evidence): ...`. Never mix slices in one commit.
4. **Claims cite committed, re-runnable evidence.** A verification doc may only claim what a committed test, fixture, or CI job reproduces. Results stored under `ignored/` do not count. Results JSON that nothing consumes is not evidence; either a test reads it or it is deleted.
5. **No new features on this branch.** Until section 5 phase 5 is complete, the branch accepts fixes and extractions only. Undo history and backups were the last feature added; see decision D1.
6. **No push and no pull request without the owner's approval, and no agent ever merges one.** Work stays local until the owner says push. With approval, the reviewer pushes the slice and opens the pull request using the repository template; the owner reviews and merges in order.
7. **Report cost at every phase boundary.** Agent runs, test sweeps, and long harness runs are quota. State what a phase cost before starting the next.
8. **Terminology.** Code, docs, and commit messages use direct technical prose. Do not call pyric's own surfaces "legacy". Do not reference issue numbers or tools in code or docs.

## 4. Decisions required from the owner

| Id | Decision | Recommendation | Status |
| --- | --- | --- | --- |
| D1 | Revert undo history and rotating backups (commit `6b450256`, about 3,000 lines) from this release and reintroduce it later as its own slice | Revert. It was not in the accepted persistence plan and it carries ledger items I2, I3, I9, I11, and part of I13. Removing it closes five items at once. | ruled 2026-09-18: revert during the phase 3 extraction; I2, I3, I9, I11, and the I13 export item close by deletion; schema stays at version 1 so I4 is moot |
| D2 | Hosted mode ships flag-gated and unannounced until phase 4 acceptance passes; the three public site-docs pages come out now | Yes. Ledger I10. | ruled 2026-09-18: flag-gated and unannounced; the three site-docs pages come out in the evidence slice and return only when the phase 4 harness passes in CI with a committed artifact |
| D3 | Live mode is removed from the browser entry and all docs until it forwards the full Firestore surface or documents each refusal with a scenario | Remove. Ledger D1. The current entry forwards one function and throws at module evaluation for other services. | ruled 2026-09-18: remove `entries/live`, `serve/live`, and every doc reference; the live work parks on its own branch with gates 7 through 9 open; the emulator-backed tests under `test/e2e/live` are deleted |
| D4 | Bun adapter now, or Node only with the standalone-binary limitation stated in the support contract | Already ruled Node only in the accepted plan. The contract statement must land with the host slice. | ruled |
| D5 | Fail-closed on malformed application records with salvage as a release requirement | Ruled fail-closed. Salvage exists; ledger H1 is at `verify`. | ruled |
| D6 | Quota approval for the phases below, reported at each boundary | Approve phases 1 through 3; re-approve phase 4 after the first instrumented acceptance run sizes it. | ruled 2026-09-18: phases 2 and 3 approved at the current cadence with per-item verification and no fan-outs; phase 4 held until the reviewer reports the first instrumented run's numbers |

## 5. Phases

Each phase has an entry condition, the ledger items it owns, an owner, and an exit gate. A phase does not start until the previous phase's exit gate passed, except where noted.

### Phase 0. Freeze and prepare

Owner: reviewing agent. Entry: now.

- Stop feature work on `hosted-live-mode`. Fixes and extractions only.
- Confirm `main` still at `f7e90081`; if it moved, note the delta before extraction.
- Record the baseline test state at the tip: the failing retention fixture, the code-form gate result, the hosted SQLite suite counts.
- Resolve D1 through D3 and D6 with the owner.

Exit gate: decisions recorded in section 4; this document and the ledger are on the branch.

### Phase 1. Foundation slice: `packages/pyric` and shared entries

Owner: reviewing agent implements; a fresh verifier agent runs acceptance. Entry: phase 0 exit.

Extract the branch's changes under `packages/pyric` and the shared browser entries under `packages/cli/src/serve/entries` (excluding `entries/live`) onto a branch from `main`. Fix inside the slice:

| Item | What | Acceptance summary |
| --- | --- | --- |
| A1 | Batch and transaction writes evaluate the wrong rule | Rule name and error code tests for update-on-missing, create-on-existing, delete, in batch and transaction |
| A2 | Sandbox reset no longer clears RTDB rules | Rules cleared after `reset()` and `resetAll` |
| A3 | Persistence restore aborts on one bad document | Shared codec path restores readable records and reports the unreadable ones; hosted fail-closed is layered above this in phase 3 |
| A4 | 30-minute history expiry makes replay and verify throw | No age bound on served limits, or age eviction produces no replay gap; test over a history older than the window |
| I1 | Live state can consume the whole history budget | Live state capped independently; pending observations beyond the reserve do not evict retained events |
| I13 | Evicted listener-attach entries counted as omitted | `omittedCount` matches events actually missing from the snapshot |
| A5 | Top-level await in the worker runtime entry | Payload consulted lazily; entry evaluates in a Service Worker realm |
| A6 | RTDB connection-metadata listeners leak their activity | Activity count returns to zero after unsubscribe |
| A7 | Non-exhaustive switches fail open | Exhaustive typing or refusing default, with test (the worker-side file lands here only if it is in the extracted paths; otherwise phase 2) |
| A8, A9, A10 | Field-mask error path, reset bypassing `setOnline`, sign-out clearing all tenants' tokens | As in the ledger |
| C11 (part) | Pending observations never terminated for dropped clients | Serve side emits a terminal status when a client drops; needed for I1 to hold in practice (the emitting code is in phase 2; the history-side contract lands here) |

Also in this slice: the `changed-buckets` incremental flush and `validate-services` from the delta, because they live under `packages/pyric`. The verifier confirms the SharedWorker IndexedDB path behaves identically to `main` after the change.

Exit gate:

- `bun test packages/pyric` green; `bun test packages/cli/test/serve/worker` green against the slice (the worker code is still main's, so this proves the shared shapes did not break the existing plane).
- The rule-method probe passes with the caller's method in the evidence.
- Typecheck green for both packages.
- Verifier closes each item with a commit hash. Pull request opened, not merged.

### Phase 2. Transport and worker slice

Owner: implementing agent, with the reviewing agent verifying. Entry: phase 1 pull request approved by the owner (merge not required to start, but rebase on merge).

Extract `packages/cli/src/serve/worker`, `packages/cli/src/bridge`, `packages/cli/src/remote`, and their tests. Fix inside the slice:

| Item | What |
| --- | --- |
| C1 | Resume after host restart drops RTDB, presence, and event-stream subscriptions |
| C2 | `worker-sub` and `remote-set-lens` honor a caller-supplied session id |
| C4 | Subscription error close ignores the logical session |
| C7 | Unwrapped throw in the worker-message path |
| C8 | One malformed peer reply fails every pending call (decide and document) |
| A7 (worker side) | `operation-arguments.ts` refusing default |
| C11 (part) | Emit a terminal status for a dropped client's pending observations |
| D3 (ledger) | Observation backpressure: implement the per-consumer queue with drop reporting, or amend the contract table and every doc that cites it |

Exit gate: `bun test packages/cli/test/serve packages/cli/test/bridge packages/cli/test/remote` green; the served-app conformance job green in CI on the pull request; verifier closures recorded. Pull request opened.

### Phase 3. Node host and persistence slice

Owner: implementing agent, with the reviewing agent verifying. Entry: phase 2 pull request approved.

Extract `packages/cli/src/serve/hosted`, `packages/cli/src/cli` (hosted, salvage, history, diagnostics commands), `packages/cli/src/serve` top-level hosting files, `packages/cli/test/serve/hosted*`, and the Node fixtures. If D1 is ruled revert, the undo history and backups are removed during extraction and do not enter this slice.

Fix inside the slice:

| Item | What |
| --- | --- |
| I4 | Migration mutates a store before refusing it (moot for v1 if D1 reverts schema 2; keep the validate-before-migrate order regardless) |
| I5 | Transient `SQLITE_BUSY` latches the host unhealthy |
| I7 | Salvage and archive open the copy read-only |
| I8 | Storage reads do not wait behind queued mutations |
| I3, I9, I11, I2 | Close by revert under D1; otherwise fix as in the ledger |
| I12 | Bun refusal branch test |
| I13 (rest) | Export temp files, rollback error masking, seed bypassing the queue, history route header order, capture re-arm timing |
| C5 | Restore double-delivers to live listeners |
| C6 | `--allow-production` dropped on the hosted CLI path |
| C9 | Hosted runtime disposes before draining in-flight work |
| C10 | Service Worker install fails permanently on a transient bridge outage (decide and document) |
| D2 (ledger) | Close during startup returns success instead of the contracted error |
| D4 (ledger) | Capture flush deadline: the 2 s bound is enforced and tested under continuous traffic |
| H1 | Salvage command: verify with the I3 and I7 sub-items closed |
| Contract | Support contract states hosted mode requires Node and is unavailable in the standalone binary until the Bun adapter ships |

Exit gate: `bun test packages/cli/test/serve/hosted-sqlite.test.ts` green with no skipped cases; Node fixtures run under both the minimum Node version and current; typecheck green; verifier closures recorded. Pull request opened.

### Phase 4. Acceptance and evidence

Owner: implementing agent runs; reviewing agent verifies and sizes. Entry: phase 3 pull request approved. This phase is not sized yet; see D6.

| Item | What |
| --- | --- |
| I6 | Baseline re-run at a commit that predates the backend; both ceilings encoded in the harness so it fails above them; pre- and post-implementation runs stored under distinct commit hashes |
| F1 | A CI job or one documented command runs the hosted Playwright suites and the hosted SQLite fixtures |
| F2 | Evidence regenerated by a CI job or removed from the docs; delete the unconsumed results JSON under `docs/` (about 28,000 lines) |
| F3, F4 | Verification docs distinguish automated from manual and state skipped counts |
| D5 (ledger) | Support-contract validation resolves scenario ids to spec files and includes named-database cases |
| I10 | Public site-docs pages removed until this phase passes (D2) |
| Acceptance | The multi-client run passes the frozen ceilings with zero refusals under stable load; the overload case is documented as the bound, not hidden |

The first task in this phase is one instrumented multi-client run against the phase 3 branch. Its output decides whether the 30 percent refusal rate is an admission-budget setting or the cost of one fsync per acknowledgment under load. The reviewing agent reports which, with the numbers, before any further spend. If it is the fsync cost, the remedy is the coalescing window the persistence plan deferred, implemented with acknowledgment-after-commit preserved and the frozen gates re-run.

Exit gate: the acceptance harness passes in CI on the branch; the passing artifact is committed; no claim in any hosted doc lacks a committed reproduction.

### Phase 5. Studio, diagnostics, and peel

Owner: implementing agent. Entry: phase 3 pull request approved (can run in parallel with phase 4).

- Extract `packages/studio` hosted changes and the runtime diagnostics as their own slice. The Studio event cap change (500 to 10,000 with a full remap per event) is measured before it lands.
- Peel into separate branches that do not enter the sequence: Orbit messaging and the `messaging_deliveries` tool (fix the sign-out bug at `examples/teams-workspace/notifications.tsx:85` there), AI observability and Studio model routing, the Vite functions retry, the code-form gate with its conventions change (B4: scoped to changed lines or advisory before it becomes required).
- Delete `packages/cli/test/e2e/live/emulators.ts` and every doc claim that cites an emulator oracle.
- Live mode (`entries/live`, `serve/live`, gates 7 through 9) stays on a branch until it meets its contract (D3).

Exit gate: `main` contains no live entry, no emulator dependency, and no code-form gate as a required job; peeled branches exist with their own tracking.

## 6. Tracking

Update this table as pull requests open and merge. Ledger item status is tracked in the ledger, not here.

| Phase | Branch | Pull request | Verifier sign-off | Merged |
| --- | --- | --- | --- | --- |
| 1 Foundation | `slice/foundation` at `3dcc9d4a`, pull request https://github.com/davideast/pyric/pull/653 opened 2026-09-19 (two commits on `main` `f7e90081`: package diff byte-equal to `origin/main...origin/hosted-main-integration -- packages/pyric packages/pyric-admin` at `1138983b`, plus the seven handoff files) | to open | verified 2026-09-19 by the reviewer on the slice: 8 phase 1 items pass; pyric 7648 pass including the 33 network parity tests; pyric-admin 660; conformance 391; cli worker 512 against the slice; cli, Studio, pyric, pyric-admin typechecks exit 0; main's Studio unchanged. Exit gate on the integration branch verified 2026-09-18; the 6 bridge failures are C13, transport slice | squash-merged as `main` `9ec53e1f` on 2026-09-19 after a `Conformance-Exempt:` trailer commit satisfied the engine coupling gate |
| 2 Transport | `slice/transport` at `d8d33e10` (four commits on `main` `9ec53e1f`: full `packages/cli` diff byte-equal to the remote at `984e75e6`, reverse diff for the 26 excluded paths, one follower line in `cli/serve.ts`, handoff docs) | https://github.com/davideast/pyric/pull/654 opened 2026-09-19 | verified 2026-09-19 by the reviewer: phase 2 acceptance A5, C13, A15 pass; bridge and remote 1340 pass; serve 1427 pass; cli, Studio, UI typecheck exit 0; no path outside `packages/cli` and the handoff files | squash-merged as `main` `bbf30034` on 2026-09-19 at `65536ea7`, after four CI followers: parity manifest and annotation for `messaging_deliveries`, the branch's messaging app-boundary spec, the browser-boundary check held for the evidence slice, and the composite served-entry test double gaining `addEventListener` (C14) |
| 3 Host | spec written 2026-09-19: `docs/hosted-extraction-spec-host.md`; boundary proven on `main` `bbf30034` (82 files; every suite green with the live files present). Prerequisites in order: D3 live removal on the shared branch, D1 undo revert on `main` as `slice/undo-revert`, then C9, C10, D2, D4, H1, I12, I13 rest, and the support contract statement closed | | | |
| 4 Acceptance | | | | |
| 5 Studio and peel | | | | |

## 7. What "users can rely on it" means here

Release confidence is judged against these, in order:

1. Every user, hosted or not, is at least as safe as on `main` today. Phase 1 is the whole of this claim.
2. A hosted host under normal load completes every accepted operation, acknowledges only after commit, and comes back after restart with the data it acknowledged. Phase 3 plus the stable-load acceptance in phase 4.
3. A hosted host under overload refuses work explicitly and stays up. It never latches, never partially persists, and never loses acknowledged data. Phase 3 items I5 and shutdown ordering, plus the overload case documented as the bound in phase 4.
4. When persistence fails, the user sees it in the chip and Studio, the database is preserved, and the recovery command works on a crashed host's files. Phase 3 items I7, H1, and the degraded-state visibility.
5. Every claim in the docs is reproducible from the repository. Phase 4.

Anything not covered by these five is not part of the release promise and is not announced.
