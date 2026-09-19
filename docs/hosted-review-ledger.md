# Hosted sandbox and live mode: review ledger

Review baseline: `origin/main` at `f7e90081` against `origin/hosted-live-mode` at `470ba3d4` (123 commits, 678 files), reviewed 2026-09-16. Delta review of `470ba3d4..26a6ae0d` (18 commits) on 2026-09-17; statuses below reflect the later tip. Section I holds the delta findings.

This ledger is the acceptance record for the branch. Each item stays open until its acceptance evidence runs green on the current branch tip. A fix without the named evidence does not close the item.

## How to use this ledger

Status values:

- `open`: not started.
- `fixing`: an agent owns it. Record the owner and the commit range in the entry.
- `verify`: a fix is on the branch and the acceptance evidence exists. The reviewer runs it.
- `closed`: acceptance evidence ran green on the branch tip. Record the commit.
- `declined`: the behavior is intended. Record the decision and update the docs or tests that pin it.

Executable acceptance: `scripts/ledger-acceptance.json` maps items to test files; `bun scripts/verify-ledger.ts <item>` runs them and prints pass or fail with the commit hash. Phase 1 items A1, A2, A3, A4, A5, A6, I1, and I13 (omitted count) have tests committed under `*/test/**/ledger/` that fail at 26a6ae0d. A fix submission is the runner output, per `docs/hosted-agent-brief.md`.

Rules for a fix:

1. Write the failing test or probe first, at the seam named in the entry. Record the failing run.
2. Tag the fix commit with the slice from the entry, for example `fix(core): ...` or `fix(host): ...`. The slice decides which pull request the commit lands in.
3. Do not bundle fixes across slices in one commit.
4. Do not close an item by relabelling the behavior as unsupported. The support contract forbids that.

Slices:

| Slice | Lands as | Contents |
| --- | --- | --- |
| `core` | Small pull requests against `main`, before anything else | Regressions in `packages/pyric` and the worker that affect every user, including non-hosted ones |
| `transport` | First branch pull request | Wire bounds, admission, budgets, consumer isolation |
| `host` | Second branch pull request | Node host, persistence, restart, hosted Studio and diagnostics |
| `live` | Held until complete | Live Firestore execution and recording |
| `peel` | Separate pull requests, unrelated to hosting | Orbit messaging, AI observability, Vite functions retry, code-form gate |
| `evidence` | Alongside `host` | CI wiring for the hosted suites, evidence retention |

## A. Core regressions

These affect users who never enable hosted mode. Fix against `main` first.

### A1. Batch and transaction writes evaluate the wrong rule

- Severity: blocker. Slice: `core`. Status: closed at `100031ac`. Reviewer acceptance: 5 pass, 0 fail; suites and typecheck reproduced.
- Location: `packages/pyric/src/firestore/sandbox/atomic-write-pipeline.ts:143`.
- Defect: `evaluateAndApply` discards the operation's method and derives it from the batch projection. On `main` the method came from `operation.method`.
- Failure: rules `allow create: if false; allow update: if true; allow delete: if true`, then `WriteBatch.update` on a missing document. The projection is `null`, the pipeline treats it as a delete, the delete rule runs and allows, and the result reports method `delete`. Conversely `create` on an existing document under `allow create: if true; allow update: if false` runs the update rule and returns `permission-denied` instead of `already-exists`. Same for `Transaction.update` and `Transaction.create`.
- Seam: application SDK, `WriteBatch` and `Transaction` through `pyric/firestore`.
- Acceptance: unit tests in `packages/pyric/test/sandbox/firestore` asserting the evaluated rule name and the error code for `update` on missing, `create` on existing, and `delete`, for both batch and transaction. The rules evidence must name the method the caller used.

### A2. Sandbox reset no longer clears RTDB rules

- Severity: should-fix. Slice: `core`. Status: closed at `abc7efbb` (branch `hosted-main-integration`). Verified 2026-09-18 by the reviewer: `verify-ledger A2` 1 pass, 0 fail; acceptance unchanged; `bun test packages/pyric/test/database` plus RTDB persistence and active-listener suites 532 pass, 0 fail beyond the still-open A6; pyric typecheck exit 0. Cross-plane residual filed as C12.
- Location: `packages/pyric/src/database/sandbox/persistence-state.ts:193`.
- Defect: `reset()` no longer routes through `restore(null)`, so `activeRules` and `rules.setRules(null)` are skipped. On `main`, the backend reset path (`resetAll`) cleared them through `restore(null)`; a plain `sandbox.reset()` did not reach the RTDB backend at all. The fix restores the backend path and also clears on the session boundary, which matches Firestore, whose rules are wiped by the environment swap on every reset.
- Failure: set RTDB rules, call `sandbox.reset()`, read active rules. They are unchanged.
- Acceptance: unit test in `packages/pyric/test/database` asserting rules are cleared after reset and after `resetAll`. If the new behavior is intended, mark `declined`, document it on `getActiveRules`, and pin it with a test.

### A3. Persistence restore aborts on one bad document

- Severity: should-fix. Slice: `core`. Status: closed at `9115b78d` (branch `hosted-main-integration`). Verified 2026-09-18 by the reviewer: `verify-ledger A3` 1 pass, 0 fail; acceptance unchanged; persistence, chunk-format, incremental, partial-restore, auth and RTDB persistence, checkpoint, and branch suites 174 pass, 0 fail; pyric typecheck exit 0. The decoder is strict by default and the shared restore opts into per-document skipping, so imports and hosted validation keep refusing. Follow-ups A12 and A13.
- Location: `packages/pyric/src/sandbox/persistence/chunk-format.ts:393`; caller `controller.ts:492` has no error handling.
- Defect: `deserializeFromBuckets` throws on a non-object document, a document nested deeper than 64 containers, or an unknown bucket encoding. The checksum branch still warns and skips. On `main` restore rehydrated whatever was readable.
- Failure: one malformed document in the store makes `enablePersistence` reject and no Firestore state restores.
- Acceptance: the shared restore path restores every readable document, skips and reports unreadable documents by path and bucket, and does not reject the entire restore. The owner confirmed that this core acceptance is independent of hosted fail-closed recovery; hosted validation and H1 remain separate.

### A4. Hosted history expires after 30 minutes and then replay and verify throw

- Severity: should-fix. Slice: `core`. Status: closed at `cf3dccb9`. Reviewer acceptance: 2 pass, 0 fail; shims removed, call sites clean, suites and typecheck reproduced after a pyric rebuild.
- Location: `packages/pyric/src/sandbox/internal/observation-history.ts` (`maxAgeMs`), `event-history.ts:315`, `replay/index.ts:116`, `database/replay.ts:60`.
- Defect: served sandboxes use limits with a 30 minute age bound. Aged events become a `history-limit` gap and `assertCompleteHistory` rejects replay and fixture parsing. The support contract bounds history by count and bytes only. On `main` history was unbounded.
- Failure: a developer works in a served app for more than 30 minutes, then runs verify or capture and gets "Cannot replay or verify incomplete observation history".
- Acceptance: remove the age bound from served limits, or make age eviction produce no gap for replay purposes, and add a test that replay succeeds over a history older than the window. If an age bound is kept, the contract document must state it and the runtime must warn before the window closes.

### A5. Top-level await in the worker runtime entry breaks Service Worker installs

- Severity: should-fix. Slice: `core`. Status: closed at `703a384c`. Reviewer acceptance: 4 pass, 0 fail; suites and typecheck reproduced.
- Location: `packages/cli/src/serve/entries/worker-runtime.ts:34`.
- Defect: `const payload = await initPayload` at module scope. `main` had no top-level await in this module. The module is imported by every SDK entry and is designed for Service Worker realms on both branches. Module Service Workers reject top-level await at evaluation. The branch's own `messaging-sw-client.ts` documents this and works around it for messaging only.
- Failure: an application Service Worker imports `firebase/firestore` through Vite. Script evaluation fails and the Service Worker does not install.
- Acceptance: the payload is consulted lazily inside the functions that need it, matching the messaging client. A test that evaluates the entry in a realm where `ServiceWorkerGlobalScope` is defined and asserts it loads.

### A6. RTDB connection-metadata listeners leak their activity handle

- Severity: should-fix. Slice: `core`. Status: closed at `1ad8580a`. Reviewer acceptance: 3 pass, 0 fail; suites and typecheck reproduced.
- Location: `packages/pyric/src/database/listeners.ts:205`.
- Defect: `onValue` opens an activity through `beginDatabaseActivity`, then the `.info` and `.info/connected` branch returns `observeConnectionMetadata(...)` without closing or failing the activity. Sibling branches close it.
- Failure: each connection-state listener leaves one activity open for the sandbox lifetime; listener accounting and retirement drain wait on it.
- Acceptance: unit test asserting the activity count returns to zero after unsubscribing a `.info/connected` listener.

### A7. Non-exhaustive switches fail open

- Severity: should-fix. Slice: `core`. Status: open.
- Locations: `packages/cli/src/serve/hosted/persistence-admission.ts` (`requiresHealthyPersistence` falls to `default`), `packages/cli/src/serve/worker/inbound-validation/operation-arguments.ts` (`assertOperationArguments` has no refusing default).
- Defect: neither switch is exhaustively typed. A newly added mutation kind bypasses the unhealthy-persistence guard and passes without argument validation.
- Acceptance: exhaustive typing with a `never` check so a new kind fails to compile, or a refusing default with a test that an unknown kind is refused.

### A8. Field-mask merge error escapes without a request event

- Severity: nit. Slice: `core`. Status: open.
- Location: `packages/pyric/src/firestore/sandbox/write-engine.ts:82`, `field-merge.ts:181`.
- Defect: the new `mergeFields` throw fires inside `applyWrite`, after rules passed but before `eventLog.append` and `emitRequest`. Every other invalid-argument path records a deny. State stays unchanged.
- Acceptance: the error is raised in `execute` like other invalid-argument paths and a request event is recorded.

### A9. Reset bypasses `setOnline` for connection observers

- Severity: nit. Slice: `core`. Status: open.
- Location: `packages/pyric/src/database/connection-lifecycle.ts:16`.
- Defect: `synchronizeReset` assigns `online = true` directly. Observers of `/.info/connected` attached while offline never receive `true` after a reset, and a later `goOnline()` is a no-op because the state is already online.
- Acceptance: route through `setOnline` and add a test for the offline, reset, observe sequence.

### A10. Sign-out deletes cached tokens for every tenant of a uid

- Severity: nit. Slice: `core`. Status: open.
- Location: `packages/pyric/src/auth/sandbox-backend.ts:1375`.
- Defect: sign-out deletes the whole per-uid token map. Another port holding the same uid under a different tenant gets a silent token rotation on its next `getIdToken(false)`.
- Acceptance: delete only the signed-out tenant's entry; test with two ports, one uid, two tenants.

### A11. Set followed by delete evaluates set under the delete rule

- Severity: nit. Slice: `core`. Status: open. Non-blocking reviewer follow-up to A1.
- Location: `packages/pyric/src/firestore/sandbox/atomic-write-pipeline.ts`.
- Defect: a batch with set then delete on the same path classifies the set from the final projection, so the set evaluates under the delete rule.
- Acceptance: a batch test pins the set operation's evaluated rule method independently of a later delete on the same path.

### A12. A skipped document is dropped from its bucket on the next flush

- Severity: nit. Slice: `core`. Status: open. Follow-up from the A3 verification; same behavior as `main`.
- Location: `packages/pyric/src/sandbox/persistence/controller.ts:541` with the flush path.
- Defect: the shared restore skips an unreadable document and warns, but the bucket's in-memory content no longer holds it. The first flush that touches that bucket rewrites it without the skipped document. The stored bytes are then gone. This is the concern the hosted fail-closed ruling addressed for the SQLite store; the SharedWorker and in-page stores have no equivalent.
- Acceptance: either the skipped document's raw record is carried through to the next flush of its bucket unchanged, or the warning states that the document will be dropped on the next write and the contract document says so.

### A13. The in-process MCP store load is strict with no recovery path

- Severity: nit, needs a ruling. Slice: `core`. Status: open.
- Location: `packages/cli/src/bridge/server/in-process.ts:244`.
- Defect: the MCP host decodes its JSON store with the strict default. One malformed document makes `pyric mcp` fail to load its state. On `main` the decoder did not validate document roots or depth, so this store restored whatever it held. Hosted is fail-closed by ruling but has salvage; this store has neither the ruling nor a recovery command.
- Acceptance: the owner rules whether the in-process store skips like the shared restore or fails closed like hosted. If fail-closed, the error names how to recover, and `pyric sandbox salvage` accepts this store's format or a sibling command exists.

## B. Failing tests on the branch tip

Stale pinned lists. Each is a one-line fix but must be verified by run.

### B1. Composite filter error text

- Slice: `core`. Status: closed at 26a6ae0d (test passes).
- Location: `packages/cli/test/serve/worker/composite-filters.test.ts:181`.
- Defect: the new `host/query-structure.ts` check runs before `pyricOr` and returns "Invalid Firestore query structure." for an empty composite. The test expects the SDK's "at least one filter" text, which was the parity the old `resolveConstraint` comment promised.
- Acceptance: decide which message is the contract. If the SDK text is the contract, the structure check must not intercept empty composites. Run `bun test packages/cli/test/serve/worker/composite-filters.test.ts`.

### B2. Frozen client export set

- Slice: `host`. Status: closed at 26a6ae0d.
- Location: `packages/cli/test/serve/worker/client-surface.test.ts:57`; exports added at `packages/cli/src/serve/worker/index.ts:254`.
- Acceptance: update the frozen set for `getHostedFirestore` and `readHostedTarget`. Run `bun test packages/cli/test/serve/worker/client-surface.test.ts`.

### B3. Pinned sandbox tool names

- Slice: `peel` (messaging). Status: closed at 26a6ae0d (pin updated; the tool still belongs to the messaging slice).
- Location: `packages/cli/test/bridge/premortem-fixes.test.ts:103`; new family `packages/cli/src/bridge/server/tool-family-records/messaging-inspection.ts`.
- Acceptance: update the pinned list for `messaging_deliveries`, or move the tool with the messaging slice. Run `bun test packages/cli/test/bridge/premortem-fixes.test.ts`.

### B4. The code-form gate fails on the branch itself

- Severity: blocker for the gate, not for the product. Slice: `peel`. Status: open.
- Location: `scripts/check-changed-code-form.ts:22`, `.github/workflows/build.yml:238`.
- Defect: `bun scripts/check-changed-code-form.ts origin/main` exits 1 with 705 issues in 84 of 595 checked files. Any touched top-level statement or class member is checked in full, so unchanged lines inside an edited function count. Every future pull request that touches a legacy function will be red until that function is rewritten.
- Acceptance: either scope the check to changed lines, or land the gate as advisory until the offenders are fixed. The gate moves to its own pull request with its conventions change.

## C. Hosted correctness

### C1. Resume after host restart drops RTDB, presence, and event-stream subscriptions

- Severity: should-fix. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/worker/client/websocket-connection.ts:224`; `restoreFirestoreSubscriptions` filters on `service === 'firestore'`; `client/rtdb-listeners.ts` subscriptions carry no service tag.
- Failure: host restart or retention expiry. Pending calls are rejected, but `onValue` listeners silently stop delivering with no error callback.
- Seam: application SDK over the hosted transport.
- Acceptance: browser scenario in `packages/cli/test/e2e/hosted` where an `onValue` listener receives an update after a host restart. Same for presence and the event stream.

### C2. Consumer isolation is half fixed

- Severity: should-fix. Slice: `transport`. Status: open.
- Location: `packages/cli/src/bridge/server/peer.ts:350` (`worker-sub` honors `msg.clientSessionId`), `peer.ts:300` (`remote-set-lens` applies `frame.clientSessionId` unchecked). `worker-op` at line 315 is already pinned to the attached identity.
- Failure: consumer A sends a subscription naming consumer B's session and receives B-scoped snapshots. Any consumer can rewrite another consumer's lens, and the registry pushes the change to the victim.
- Acceptance: bridge consumer tests asserting both frames are refused or rewritten to the attached identity.

### C3. Live capture grows without bound and re-posts everything

- Severity: should-fix. Slice: `live`. Status: open.
- Location: `packages/cli/src/serve/live/capture.ts:84`.
- Defect: `events` is never trimmed and every read serializes the cumulative array to the capture endpoint. Flushes run concurrently, so an older post can overwrite a newer fixture.
- Acceptance: bounded buffer, incremental posts, serialized flushes, and a test with many reads asserting bounded payload size and fixture order.

### C4. Subscription error close ignores the logical session

- Severity: should-fix. Slice: `transport`. Status: open.
- Location: `packages/cli/src/serve/worker/client/core.ts:353`; host side `host/subscriptions.ts:273`.
- Defect: on a `snap` error the client closes the subscription without its `clientSessionId`. For bridge-relayed subscriptions the `unsub` reaches the worker on the physical port, finds nothing, and the remote port's listener and retained intent stay alive until the remote disconnects. A later auth transition re-registers it.
- Acceptance: test that a relayed subscription which errors is fully removed from the host.

### C5. Restore double-delivers to live listeners

- Severity: nit. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/worker/host/connection.ts:118`, `host/studio.ts:59`.
- Defect: `restoreSubscriptions` re-registers every retained intent after `importState`, `restore`, and `resetAll`, but `loadSnapshot` and `restoreCheckpoint` already re-evaluate live listeners. Each page listener gets two deliveries per restore. Explicit-lens Studio subscriptions are re-registered too, unlike the session-only rule on `main`.
- Acceptance: test counting deliveries per listener across a restore.

### C6. Production flag is dropped on the hosted CLI path

- Severity: should-fix, low. Slice: `host`. Status: open.
- Location: `packages/cli/src/cli/surface-method-runner.ts:96`; host default at `serve/hosted/runtime.ts:341`.
- Defect: `--allow-production` is parsed but not sent with the hosted method call. The host runs with the flag off and refuses without saying why.
- Acceptance: the flag travels with the call; CLI test asserting the hosted path honors it.

### C7. Unwrapped throw in the worker-message path

- Severity: should-fix, low. Slice: `transport`. Status: open.
- Location: `packages/cli/src/bridge/server/bridge.ts:776`, `peer.ts:344`.
- Defect: `forwardWorkerMessage` throws when the peer is null or lacks a worker port, and the socket message listener does not catch it. Under `pyric serve` the process guard logs it; under other mounts it is uncaught. The client's request is stranded until its own timeout.
- Acceptance: the client receives a refusal response; test with a consumer attaching during a host restart.

### C8. One malformed peer reply fails every pending call

- Severity: nit. Slice: `transport`. Status: open.
- Location: `packages/cli/src/bridge/server/bridge.ts:612`.
- Defect: a `tool-result` or `worker-res` frame with a non-string id calls `failAllPending` across all consumers.
- Acceptance: decide whether global failure is intended. If it is, document it as a peer-integrity rule. If not, refuse the frame alone.

### C9. Hosted runtime disposes before draining in-flight work

- Severity: nit. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/hosted/runtime.ts:392`.
- Defect: `close()` disposes the initialized host before accepted method and tool work settles, so late failures surface to callers as spurious errors.
- Acceptance: drain, then dispose; test with an in-flight call across `close()`.

### C10. Service Worker install fails permanently on a transient bridge outage

- Severity: nit. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/entries/messaging-sw.ts:335`, `messaging-sw-client.ts:248`.
- Defect: `waitUntil(ready)` on install and activate means a failed hosted attach fails the install, retried only on the next registration.
- Acceptance: decide whether install must wait for the host. If not, install succeeds and the attach retries.

### C11. Behavior changes that need an explicit decision

Each is `declined` or `open` once you decide. Record the decision here.

- `auth.setTenantId` no longer retargets a live session (`packages/cli/src/serve/worker/host-auth.ts:305`). The real SDK only affects future sign-ins, so this may be a fix, but no test pins either behavior and listeners opened under the old tenant keep the old claim.
- The in-page tab-sync fallback no longer propagates sign-in and sign-out across tabs (`packages/cli/src/serve/entries/tab-sync-wiring.ts`). The rewritten tests pin the new behavior. This is a visible change for users of the fallback.
- Pending observations with no terminal status are exempt from every history limit (`packages/pyric/src/sandbox/internal/event-history.ts:232`). No code under `packages/cli/src/serve` emits `interrupted` or `cancelled` for a dropped client.

### C12. Served worker does not re-deploy RTDB rules after a reset

- Severity: should-fix. Slice: `transport`. Status: open. Pre-existing on `main`; surfaced by the A2 verification.
- Location: `packages/cli/src/serve/worker/host/studio.ts:52`; the RTDB rules source is retained at `ctx.activeRules.database` by `serve-init.ts:103`.
- Defect: after `resetAll`, the worker re-deploys only the Firestore rules. Its comment assumes RTDB rules survive the reset. On `main` the backend reset already cleared them, and after A2 the session boundary clears them too, so a Studio reset in served mode leaves RTDB under the default deny policy until the rules file next changes.
- Failure: served app with `database.rules.json` granting reads; Studio reset; every RTDB read is refused until the developer edits the rules file.
- Acceptance: the worker re-deploys `ctx.activeRules.database` after `resetAll` the same way it re-deploys Firestore rules, and `packages/cli/test/serve/worker/reset-all-op.test.ts` gains a case mirroring its Firestore case at line 107: an RTDB read governed by active rules still succeeds after `resetAll`.

## D. Spec gaps and contract violations

Contract: `docs/hosted-sandbox-live-mode-support.md`.

### D1. The live Firestore surface is a stub

- Slice: `live`. Status: open.
- Contract: "Reads, queries, document listeners, query listeners, writes, batches, transactions, converters, metadata options, and the network/cache controls exposed by the normal Firestore entry need explicit forwarding or a documented refusal backed by a scenario."
- State: `packages/cli/src/serve/entries/live/firestore.ts` forwards `getDoc`, `doc`, `getFirestore`, `connectFirestoreEmulator`, and `DocumentSnapshot`. Everything else is a missing export. `live/unsupported.ts` throws at module evaluation, which breaks the importing module rather than refusing per operation. Gates 7 through 9 have no implementation.
- Acceptance: either the full surface with scenarios, or per-operation refusals each backed by a scenario. Until then the live entry is removed from the playground and the site docs.

### D2. Close during startup returns success

- Slice: `host`. Status: open.
- Contract: "The start caller receives a closed-startup error."
- State: `packages/cli/src/serve/bridge-mount.ts:258` returns on `closed` and `startHostedSandbox` resolves. `section-one-lifecycle-startup.pw.ts:22` uses `Promise.allSettled` and never asserts the error.
- Acceptance: the start promise rejects with the contracted error; the scenario asserts it.

### D3. Observation backpressure closes the socket instead of reporting drops

- Slice: `transport`. Status: open.
- Contract: per-consumer queue of 1,000 events or 16 MiB, report the dropped sequence range, keep operation and control traffic independent.
- State: `packages/cli/src/bridge/server/socket-message.ts:25` hard-codes a 24 MiB backlog and closes with 1013. The contract text notes this is unresolved.
- Acceptance: implement the per-consumer queue with drop reporting, or amend the contract table and every doc that cites it.

### D4. Capture flush deadline does not exist

- Slice: `host`. Status: open.
- Contract: maximum capture delay of 2 seconds under continuous traffic.
- State: no timer or deadline in `packages/cli/src/serve/capture-store.ts` or `rate-capture-service.ts`.
- Acceptance: a max-age flush with a test under continuous traffic.

### D5. Support contract validation checks shape only

- Slice: `evidence`. Status: open.
- Contract: "The support inventory must account for default and named app/database cases before declaring either supported."
- State: `scripts/check-support-contract.ts` checks referential integrity. Gate ids are unchecked strings. The manifest has no named-database cases. Deleting every hosted scenario file still passes.
- Acceptance: each scenario id in the manifest resolves to a spec file, and named-database cases are present.

### D6. History age eviction is not in the contract

- Slice: `core`. Status: open. Same fix as A4.
- Contract bounds history by count and bytes. The implementation adds 30 minutes.

## E. Scope to peel into separate pull requests

Not hosted or live work. Each moves to its own branch with its own tests, or waits.

- `peel`: Orbit messaging feature. Commits `d9ea705e`, `cf0d9607`. FCM service worker, Cloud Function with its own lockfile, notifications UI, `messaging_deliveries` tool, broker delivery history and persistence, messaging verification doc. Also fix the sign-out bug at `examples/teams-workspace/notifications.tsx:85`: `stop()` caches a rejected promise, so one failed token revocation blocks sign-out until reload, and revocation failure should not gate leaving the session.
- `peel`: AI observability and Studio model routing. Commits `dfe664ea`, `19794202`, `a14f3f8c`. Note the Studio event cap moves from 500 to 10,000 with a full snapshot and remap per event on the render path (`packages/studio/src/shell/studio-events.ts:57`); measure before landing.
- `peel`: Vite functions startup retry. Commit `89103da5`.
- `peel`: code-form gate and conventions change (`scripts/check-code-form.ts`, `check-changed-code-form.ts`, `test-isolated.ts`, `docs/code-conventions.md` section 3, `.github/workflows/build.yml:181`). See B4.
- Delete: `packages/cli/test/e2e/live/emulators.ts` spawns the Firebase Emulator. This conflicts with the project position that pyric never integrates with or tests against the emulator. Any gate evidence that cites an emulator oracle is not evidence.

## F. Evidence and CI

### F1. No hosted suite runs in CI

- Slice: `evidence`. Status: open.
- State: 215 Playwright specs, 6 packed cases, and the manual suites under `packages/cli/test/e2e/hosted`, `e2e/live`, and `test/manual` are not referenced by any workflow or package script. They run only from commands in the docs.
- Acceptance: a workflow job or a documented single command that runs the hosted suites, with the run linked from `GATES.md`. Until then no claim that cites them counts as verified.

### F2. Evidence lives in an ignored directory

- Slice: `evidence`. Status: open.
- State: all recorded evidence is under `ignored/` (`.gitignore:21`). `docs/hosted-sandbox-live-mode-evidence.md` is a historical candidate. None of the case counts in `GATES.md`, the handoff, or the verification docs are reproducible from the repository. `docs/hosted-sandbox-live-mode-evidence.json` (88,450 lines) is consumed by nothing.
- Acceptance: evidence is either regenerated by a CI job or removed from the docs. Delete the unconsumed JSON.

### F3. Manual QA cited as gate evidence

- Slice: `evidence`. Status: open.
- State: the gates doc says handwritten passed evidence does not pass, yet `hosted-milestone-verification.md` and the section-four docs rest on manual QA. `hosted-section-one-results.md` declares automated verification complete while D2 is asserted only as "no late registration".
- Acceptance: each claim maps to an automated case or is reworded as manual.

### F4. Skipped or mode-filtered cases counted as passes

- Slice: `evidence`. Status: open.
- State: `vite-plugin-bridge-e2e.test.ts:42` is skipped unless an environment flag is set; `examples/teams-workspace/notifications.pw.ts` skips 8 cases by mode, so "6 browser checks passed" is a partial selection.
- Acceptance: counts in the docs state the total and the skipped number.

## G. Coordination with the persistence work

The SQLite unified backend touches `packages/pyric/src/sandbox/persistence/chunk-format.ts`, `controller.ts`, `packages/cli/src/serve/worker/durable-persistence.ts`, and `packages/cli/src/serve/hosted/runtime.ts`. Items A3, C5, C9, D2, and D4 touch the same files. Before the persistence agent starts, a one-page contract should state:

- what an acknowledged write guarantees, and when the acknowledgment is sent relative to the fsync
- what a partial restore does with unreadable records (see A3)
- how legacy chunk blobs and hosted v2 bundles migrate, and whether both readers survive
- which process owns the file, and what a second host on the same directory sees

That contract becomes the acceptance reference for the persistence items and closes the premortem's "durability without acknowledgment semantics" risk.

## H. Items added from the persistence plan review

See `docs/hosted-persistence-plan-review.md` for the discussion.

### H1. Salvage command for a preserved hosted database

- Severity: should-fix. Slice: `host`. Status: verify. Implemented at 26a6ae0d in `packages/cli/src/cli/salvage.ts` and `serve/hosted/persistence/salvage.ts`: source preserved by hash, output revalidated, empty output refused. Open sub-items I3 and I7 block closure. Companion to A3.
- Context: the persistence slice fails closed on a malformed application record and preserves the database directory for repair. Until a repair path exists, one malformed record blocks the host and `fresh` is the only remedy in practice.
- Acceptance: a CLI command reads a preserved database, reports unreadable records by namespace and id, and writes a repaired copy without modifying the original. The startup refusal message names this command. A3 closes when the command exists and the refusal names it.

### H2. Experimental warning on every hosted start

- Severity: nit, first-run. Slice: `host`. Status: open.
- Context: `node:sqlite` prints `ExperimentalWarning` at first use. The ownership lock already triggers it on the branch. Node can only disable the whole category, not one module.
- Acceptance: decide whether to disable the category on the hosted CLI path or accept the warning until Node marks the module stable. Either way, the getting-started path must not show an unexplained warning on first run.

## I. Delta review, 2026-09-17 (`470ba3d4..26a6ae0d`)

Unless noted, earlier items A1, A2, A4, A5, A6, A7, C1, C2, C3, D1, D2, D3, F1, and F2 remain present at 26a6ae0d. Typecheck passes for pyric and cli.

### I1. Live state can consume the whole history budget and evict every event

- Severity: blocker. Slice: `core`. Status: verify. Owner: Codex; branch: `hosted-main-integration`; base: `1ad8580a`.
- Location: `packages/pyric/src/sandbox/internal/event-history.ts:203`.
- Defect: `liveCount` and `liveBytes` reserve capacity but are themselves uncapped and never evictable. Once live state alone reaches `maxEvents` or `maxBytes`, every appended event is evicted into a `history-limit` gap.
- Failure: dangling `pending` observations accumulate because nothing under `packages/cli/src/serve` emits `interrupted` or `cancelled` for a dropped client (see C11). At 10,000 of them, retained history is zero and stays zero; replay and verify are refused permanently. Confirmed by probe at `maxEvents: 10`.
- Acceptance: cap live state independently of retained history, or count only the reserve against the limits. Test that pending observations beyond the reserve do not evict retained events.

### I2. Retention fixture fails deterministically on the tip

- Severity: should-fix. Slice: `host`. Status: open.
- Location: `packages/cli/test/serve/fixtures/hosted-sqlite-retention.ts:59`.
- Defect: `assert.deepEqual` on two `DocumentSnapshot.data()` results, which are Proxy objects. Node's strict deep equality never treats two distinct proxies as equal. Verified at the assertion point: same prototype, equal fields, equal `Timestamp`, spread copies compare equal. The codec is not at fault.
- Failure: the hosted SQLite suite reports 22 pass, 1 fail on every run. Introduced in `6b450256`.
- Acceptance: compare plain copies or named fields; suite green.

### I3. Salvage overwrites readable history when it meets an unknown codec version

- Severity: should-fix. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/hosted/persistence/history-codec.ts:4`, `history.ts:198`, `history-salvage.ts:33`.
- Defect: the history codec pins `encoding` to one literal, contradicting the shared `validatePersistenceEncoding` policy in `packages/pyric/src/sandbox/persistence/import-bundle.ts` that unknown codecs are not corruption. A record written by a newer encoding fails to parse, startup refuses, and salvage then replaces the record with an exclusion boundary. Bucket salvage already uses the shared validator at `salvage.ts:105`.
- Acceptance: history uses the shared seam; a fixture with a newer-encoding record salvages with the record retained.

### I4. Migration mutates a store before refusing it

- Severity: should-fix. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/hosted/persistence/database.ts:57`; validation order at `persistence.ts:19`.
- Defect: the v1 to v2 history migration writes tables and bumps `user_version` before `validateHostedDatabase` runs. A v1 store with malformed application records is modified, then refused. The contract requires refusal to leave the database unchanged.
- Acceptance: validate before migrate; test that a refused v1 store is byte-identical after refusal.

### I5. Transient `SQLITE_BUSY` latches the host unhealthy

- Severity: should-fix. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/hosted/persistence/database.ts:34`, `commits.ts:40`.
- Defect: the persistence connection sets `busy_timeout=0` and any busy result calls `markUnhealthy()`, a permanent latch until restart. A checkpoint, a snapshot reader, a backup agent, or antivirus produces the same outcome as corruption.
- Acceptance: a bounded busy policy on persistence connections (the ownership lock keeps 0), retry on busy, and a test that a concurrent reader during commit does not latch unhealthy.

### I6. Baseline was not frozen before implementation

- Severity: should-fix. Slice: `evidence`. Status: open.
- Location: `docs/hosted-persistence-baseline.md:4,18`; commit `1ac597ff`.
- Defect: the baseline doc, its JSON, the plan, the contract, and the entire SQLite backend land in one commit. The 25 ms acknowledgment budget was chosen after two of three runs. The post-implementation results JSON records the same commit hash as the baseline because the implementation was uncommitted when the script ran. Neither ceiling appears in any script or test; the harness fails only on errors.
- Acceptance: re-run the baseline at a commit that predates the backend and record its hash; encode both ceilings in the harness so it fails above them; store pre- and post-implementation runs under distinct commit hashes.

### I7. Salvage and archive open the copy read-only

- Severity: should-fix. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/hosted/persistence/salvage.ts:54`, `archive.ts:49`.
- Defect: a crashed host leaves `state.sqlite-wal`. Without the `-shm` file SQLite cannot open a WAL database read-only, so salvage fails on the input it exists for.
- Acceptance: open the disposable copy read-write, or recover the WAL first; fixture with a `-wal` and no `-shm`.

### I8. Storage reads do not wait behind queued mutations

- Severity: should-fix. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/hosted/persistence/storage.ts:57,93`.
- Defect: `getBlob` and `listByPrefix` skip the mutation queue that `getMetadata` awaits. A reader can see metadata for an object whose bytes are still queued, or a listing that omits it.
- Acceptance: all reads await the queue; test upload-then-list ordering.

### I9. Undo history grows the database without bound

- Severity: should-fix. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/hosted/persistence/undo.ts:14`, `history.ts:45`, `archive.ts:44`.
- Defect: every allowed write stores prior and next documents in `history_records` forever; nothing prunes. The history contract admits unbounded disk; the persistence contract does not mention it. `fresh` also copies the whole directory to the temp filesystem to run `quick_check`.
- Acceptance: a retention bound on `history_records` with a test, the bound stated in the persistence contract, and `quick_check` run in place.

### I10. Hosted mode is announced in the site docs while acceptance is failing

- Severity: should-fix. Slice: `evidence`. Status: open.
- Location: `packages/site-docs/src/content/build/hosted-persistence.md`, `reference/cli.md`, `get-started/vite.md`; `docs/hosted-multiclient-results.json`.
- Defect: the plan forbids release claims until every gate passes. Step 6 is open. The committed acceptance artifact is a failing run: 62,599 of 90,000 operations completed, p95 4,250 ms, maximum capture delay 1,025 s against a 2 s bound. The passing run the verification docs cite lives in gitignored `ignored/`.
- Acceptance: remove the public pages until step 6 passes, or commit the passing artifact and make the harness re-runnable.

### I11. Synchronous history decode on the request path

- Severity: should-fix. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/hosted/persistence/history.ts:151`; callers `undo.ts:139,167`.
- Defect: `recentEngineEvents` decodes up to 1,000 records with hash, parse, and schema validation synchronously, and backs `size()` as well as the event getters. A count request blocks the event loop for the full page.
- Acceptance: a separate count query; decode only on demand.

### I12. Bun refusal branch untested

- Severity: nit. Slice: `host`. Status: open.
- Location: `packages/cli/src/serve/hosted/persistence/sqlite.ts:18`.
- Defect: only the Node-version refusal is tested. Nothing spoofs `process.versions.bun`, so the branch that decides whether the standalone binary refuses cleanly is unverified.
- Acceptance: the same spoofing fixture for the Bun case.

### I13. Smaller items

- `history-export.ts:275` leaves `.segment-*.tmp` and `.checkpoint-*.tmp` behind on a failed export.
- `sqlite.ts:43` a throwing `ROLLBACK` after a failed `COMMIT` replaces the original error.
- `state-view.ts:96` the storage seed bypasses the mutation queue.
- `history-route.ts:9` writes the 200 status before evaluating the body, so a throw sends headers twice.
- `serve-init.ts:365` capture delivery re-arms after the POST settles, so the worst case is interval plus POST latency; the new test asserts no time bound against the 2 s contract.
- `event-history.ts:209` counts evicted listener-attach entries as omitted although `snapshot()` still returns them. `I13-omitted`: verify with I1; owner: Codex; branch: `hosted-main-integration`.
- `persistence.ts:12` and `undo.ts:138` call pyric's own surfaces "legacy".
