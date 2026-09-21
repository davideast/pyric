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

Executable acceptance: `scripts/ledger-acceptance.json` maps items to test files; `bun scripts/verify-ledger.ts <item>` runs them and prints pass or fail with the commit hash. Phase 1 items A1, A2, A3, A4, A5, A6, I1, and I13 (omitted count) have tests committed under `*/test/**/ledger/` that fail at 26a6ae0d. A fix submission is the runner output, per `docs/hosted-agent-brief.md`. The `packages/cli` suites resolve `pyric` through its built `dist`; run `bun run --cwd packages/pyric build` before verifying any item whose fix touches `packages/pyric/src`, or a stale build reports a false failure.

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

- Severity: blocker. Slice: `core`. Status: closed at `100031ac` (branch `hosted-main-integration`). Verified 2026-09-18 by the reviewer: `verify-ledger A1` 5 pass, 0 fail on that commit; acceptance tests byte-identical to the reviewer's copy; `bun test packages/pyric/test/sandbox/firestore packages/pyric/test/firestore packages/pyric/test/e2e-soundness` 1920 pass, 0 fail; pyric typecheck exit 0. Residual filed as A11.
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
- Acceptance depends on the owner's ruling in `docs/hosted-persistence-plan-review.md` decision 3. Under quarantine-with-retention: a bucket with one malformed and one valid document restores the valid one, retains the malformed one in a quarantine table, and warns by namespace and id. Under fail-closed: startup refuses with a message that names the salvage command in H1, the database directory is preserved unmodified, and A3 closes only when H1 exists. In both cases the JSON path on `main` restores what it can, so the `core` fix against `main` restores that behavior regardless of the hosted ruling.

### A4. Hosted history expires after 30 minutes and then replay and verify throw

- Severity: should-fix. Slice: `core`. Status: closed at `cf3dccb9` (branch `hosted-main-integration`). Verified 2026-09-18 by the reviewer: `verify-ledger A4` 2 pass, 0 fail; acceptance identical to the reviewer's revised copy (`e49ce111`); age eviction and both option fields removed with no shim; retention, replay-gap, traffic-observation, chip-traffic, and worker init suites 135 pass, 0 fail after rebuilding `packages/pyric`; pyric typecheck exit 0. First submission returned once for keeping the fields as ignored inputs.
- Location: `packages/pyric/src/sandbox/internal/observation-history.ts` (`maxAgeMs`), `event-history.ts:315`, `replay/index.ts:116`, `database/replay.ts:60`.
- Defect: served sandboxes use limits with a 30 minute age bound. Aged events become a `history-limit` gap and `assertCompleteHistory` rejects replay and fixture parsing. The support contract bounds history by count and bytes only. On `main` history was unbounded.
- Failure: a developer works in a served app for more than 30 minutes, then runs verify or capture and gets "Cannot replay or verify incomplete observation history".
- Acceptance: remove the age bound from served limits, or make age eviction produce no gap for replay purposes, and add a test that replay succeeds over a history older than the window. If an age bound is kept, the contract document must state it and the runtime must warn before the window closes.

### A5. Top-level await in the worker runtime entry breaks Service Worker installs

- Severity: should-fix. Slice: `core`. Status: closed at `703a384c` (branch `hosted-main-integration`). Verified 2026-09-18 by the reviewer: `verify-ledger A5` 4 pass, 0 fail across the source-form check, the page ordering fixture, and the Service Worker relay and hosted fixtures; entries, worker, injection, Vite plugin, runtime, and bridge-mount suites 934 pass, 0 fail; cli typecheck exit 0. Returned twice: first for exported live bindings that let SDK entries bind in-page before the init fetch resolved, then for Service Worker realms that never initialized. Final shape: pages read an inline payload synchronously; Service Workers bind the worker side synchronously and defer only the transport behind a port that keeps its identity (`worker/client/deferred-connection.ts`). The inline endpoint is asserted equal to `bridge.wsUrl()`.
- Location: `packages/cli/src/serve/entries/worker-runtime.ts:34`.
- Defect: `const payload = await initPayload` at module scope. `main` had no top-level await in this module. The module is imported by every SDK entry and is designed for Service Worker realms on both branches. Module Service Workers reject top-level await at evaluation. The branch's own `messaging-sw-client.ts` documents this and works around it for messaging only.
- Failure: an application Service Worker imports `firebase/firestore` through Vite. Script evaluation fails and the Service Worker does not install.
- Acceptance: the payload is consulted lazily inside the functions that need it, matching the messaging client. A test that evaluates the entry in a realm where `ServiceWorkerGlobalScope` is defined and asserts it loads. In addition, no SDK entry may bind a backend before the payload is known: a page-realm test evaluates `firestore.ts`, `auth.ts`, and `database.ts` with `SharedWorker` present and the init response resolving after evaluation, then asserts a read goes to the worker transport.
- Review note 2026-09-18: first submission (`1daa6cbd`) returned. It replaced the module-scope await with an async initializer and exported live bindings, but `auth.ts:36`, `database.ts:86`, `firestore.ts:33`, `storage.ts:37`, and `init.ts:37` still bind their backend from `useWorker` at module scope, and none of them import the bootstrap that awaits initialization. Top-level await blocks only importers, not sibling module scripts, so an app whose module graph reaches an SDK entry before the init fetch resolves binds the in-page sandbox permanently while the chip reports shared-worker mode. On `main` the payload was not fetched at all; `useWorker` was computed synchronously from the environment.

### A6. RTDB connection-metadata listeners leak their activity handle

- Severity: should-fix. Slice: `core`. Status: closed at `1ad8580a` (branch `hosted-main-integration`). Verified 2026-09-18 by the reviewer: `verify-ledger A6` 3 pass, 0 fail; acceptance unchanged; database, active-listener, rate, and listener-attach suites 541 pass, 0 fail; pyric typecheck exit 0. The handle is passed into `observeConnectionMetadata` and closed once in its idempotent stop; the agent's added test covers both metadata paths through unsubscribe, `off`, `onlyOnce`, and app deletion.
- Location: `packages/pyric/src/database/listeners.ts:205`.
- Defect: `onValue` opens an activity through `beginDatabaseActivity`, then the `.info` and `.info/connected` branch returns `observeConnectionMetadata(...)` without closing or failing the activity. Sibling branches close it.
- Failure: each connection-state listener leaves one activity open for the sandbox lifetime; listener accounting and retirement drain wait on it.
- Acceptance: unit test asserting the activity count returns to zero after unsubscribing a `.info/connected` listener.

### A7. Non-exhaustive switches fail open

- Severity: should-fix. Slice: `core`. Status: closed at `5538e1d2` (branch `hosted-main-integration`). Verified 2026-09-18 by the reviewer: `verify-ledger A7` 6 pass, 0 fail on the agent-authored acceptance approved at `709bfc54` (runtime refusal of an unknown wire method at both boundaries, plus compiler-enforced exhaustiveness by injecting a protocol variant in the compiler's view). `isFirestoreWriteOp` is now a type predicate over a `satisfies`-typed list, so the write set has one source. Classification of existing methods is unchanged; the gap that enumeration exposed is filed as I14.
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

- Severity: should-fix. Slice: `host`. Status: closed at f2eb1830 (verified 2026-09-20). After a reconnect the client reissues every live observation it owns (Firestore, RTDB, presence, and the event stream) and does not replay operations or AI requests. Acceptance is a Chromium page against a real Node host that is killed and restarted on its port. Reviewer probe: with restoration reduced to Firestore only, the RTDB and presence cases fail.
- Location: `packages/cli/src/serve/worker/client/websocket-connection.ts:224`; `restoreFirestoreSubscriptions` filters on `service === 'firestore'`; `client/rtdb-listeners.ts` subscriptions carry no service tag.
- Failure: host restart or retention expiry. Pending calls are rejected, but `onValue` listeners silently stop delivering with no error callback.
- Seam: application SDK over the hosted transport.
- Acceptance: browser scenario in `packages/cli/test/e2e/hosted` where an `onValue` listener receives an update after a host restart. Same for presence and the event stream.

### C2. A consumer can subscribe under another consumer's session

- Severity: should-fix. Slice: `transport`. Status: closed at 9a34796f (verified 2026-09-20). Subscriptions are pinned to the attached identity. Reviewer probe: with the caller-supplied session honored again, the forged-session acceptance fails.
- Location: `packages/cli/src/bridge/server/peer.ts` (`worker-sub` honors `msg.clientSessionId`). `worker-op` is already pinned to the attached identity.
- Failure: consumer A sends a subscription naming consumer B's session and receives B-scoped snapshots.
- Acceptance: bridge consumer test asserting a subscription naming another consumer's session is refused or rewritten to the attached identity, and cannot read the other consumer's rules-protected document.
- Declined 2026-09-20: remote-set-lens targeting another consumer is the Studio remote-control feature, present on main; consumers share one trust level. A consumer privilege model for the bridge is a separate design question outside this release.

### C3. Live capture grows without bound and re-posts everything

- Severity: should-fix. Slice: `live`. Status: closed by removal at 14039436 (verified 2026-09-19): owner ruling D3; preserved on `live/parked` with gates 7 through 9 open.
- Location: `packages/cli/src/serve/live/capture.ts:84`.
- Defect: `events` is never trimmed and every read serializes the cumulative array to the capture endpoint. Flushes run concurrently, so an older post can overwrite a newer fixture.
- Acceptance: bounded buffer, incremental posts, serialized flushes, and a test with many reads asserting bounded payload size and fixture order.

### C4. Subscription error close ignores the logical session

- Severity: should-fix. Slice: `transport`. Status: closed at 26d446d6 (verified 2026-09-20). An errored relayed subscription is closed under its logical session; the acceptance inspects host output, so a leaked host listener cannot hide behind a dropped client callback. Reviewer probe: without the session argument the acceptance fails.
- Location: `packages/cli/src/serve/worker/client/core.ts:353`; host side `host/subscriptions.ts:273`.
- Defect: on a `snap` error the client closes the subscription without its `clientSessionId`. For bridge-relayed subscriptions the `unsub` reaches the worker on the physical port, finds nothing, and the remote port's listener and retained intent stay alive until the remote disconnects. A later auth transition re-registers it.
- Acceptance: test that a relayed subscription which errors is fully removed from the host.

### C5. Restore double-delivers to live listeners

- Severity: nit. Slice: `host`. Status: closed at db87701b (verified 2026-09-19; the agent's 6c558b8a rebased onto the shared tip). Diagnosis narrowed: only RTDB double-delivered, because its snapshot load already re-evaluates listeners in place; Firestore disposes its environment on reset and must rebind. The fix rebinds Firestore only. Acceptance covers named checkpoint load, portable import, and reset for Firestore and RTDB, page and explicit-admin Studio listeners, asserting exactly one state delivery and one subsequent write delivery each. Reviewer probe: rebinding every listener again fails the six RTDB cases. Session-only reauthorization on auth transitions is unchanged.
- Location: `packages/cli/src/serve/worker/host/connection.ts:118`, `host/studio.ts:59`.
- Defect: `restoreSubscriptions` re-registers every retained intent after `importState`, `restore`, and `resetAll`, but `loadSnapshot` and `restoreCheckpoint` already re-evaluate live listeners. Each page listener gets two deliveries per restore. Explicit-lens Studio subscriptions are re-registered too, unlike the session-only rule on `main`.
- Acceptance: test counting deliveries per listener across a restore.

### C6. Production flag is dropped on the hosted CLI path

- Severity: should-fix, low. Slice: `host`. Status: closed at 77f070ca (verified 2026-09-19). The CLI runner forwards the production opt-in per call; the hosted request schema defaults it to false. Reviewer probe: with the forwarded field removed from the built runner the acceptance fails, so it discriminates.
- Location: `packages/cli/src/cli/surface-method-runner.ts:96`; host default at `serve/hosted/runtime.ts:341`.
- Defect: `--allow-production` is parsed but not sent with the hosted method call. The host runs with the flag off and refuses without saying why.
- Acceptance: the flag travels with the call; CLI test asserting the hosted path honors it.

### C7. Unwrapped throw in the worker-message path

- Severity: should-fix, low. Slice: `transport`. Status: closed at 6afbdda2 (verified 2026-09-20). A synchronous forwarding failure becomes a failed result or an error snapshot addressed to the request, under the attached consumer's session. Nine cases: three request types against peer disappearance, replacement without worker-port support, and a throwing transport. Reviewer probe: with the catch rethrowing, all nine fail.
- Location: `packages/cli/src/bridge/server/bridge.ts:776`, `peer.ts:344`.
- Defect: `forwardWorkerMessage` throws when the peer is null or lacks a worker port, and the socket message listener does not catch it. Under `pyric serve` the process guard logs it; under other mounts it is uncaught. The client's request is stranded until its own timeout.
- Acceptance: the client receives a refusal response; test with a consumer attaching during a host restart.

### C8. One malformed peer reply fails every pending call

- Severity: nit. Slice: `transport`. Status: closed at 9c5bf75e (verified 2026-09-20). Decision: a reply or snapshot without a usable id is discarded alone, with one payload-free diagnostic through the bridge logger; every other pending call and subscription is untouched and the affected call meets its existing deadline. Reviewer probes: restoring the global failure breaks five of seven cases; silencing the diagnostic breaks the case that asserts it.
- Location: `packages/cli/src/bridge/server/bridge.ts:612`.
- Defect: a `tool-result` or `worker-res` frame with a non-string id calls `failAllPending` across all consumers.
- Decision 2026-09-20: discard only uncorrelatable operation, tool and subscription replies. Emit one payload-free bridge diagnostic for each discarded frame. Keep valid-id malformed results scoped to their owner, existing call deadlines, and peer disconnect/replacement behavior.
- Acceptance: simultaneous callers and two live subscriptions remain unaffected by a reply with an unusable id; each discarded frame emits one diagnostic. An unanswered call retains its existing deadline, with no automatic write replay. Pin this rule in the hosted persistence contract.

### C9. Hosted runtime disposes before draining in-flight work

- Severity: nit. Slice: `host`. Status: closed as already fixed at 1ac597ff (2026-09-20). close() drains pending method and tool calls, port closures, and persistence work, then flushes, and disposes in finally. Acceptance kept as a regression guard: queued method, tool, and page writes across close() all complete and are readable after a restart of the real Node/SQLite runtime; repeated close shares its promise. Reviewer probes on c6c899ed (2026-09-20): the guard fails when the sandbox is disposed before the drain and when close does not await pending calls; disposing only the capture subscription early does not fail it, because queued work does not depend on it.
- Location: `packages/cli/src/serve/hosted/runtime.ts:392`.
- Defect: Correction: `close()` disposes the initialized host before accepted method and tool work settles, so late failures surface to callers as spurious errors.
- Acceptance: drain, then dispose; test with an in-flight call across `close()`.

### C10. Service Worker install fails permanently on a transient bridge outage

- Severity: nit. Slice: `host`. Status: closed at 52465eee (verified 2026-09-20). Decision: install does not wait for the host. Reviewer probe: with the Service Worker retry opt-in forced off, the acceptance fails. Installation waits for the initial attempt but does not reject on attachment failure; hosted Messaging retries initial transport outages and restores observers, without changing page startup refusal.
- Location: `packages/cli/src/serve/entries/messaging-sw.ts:335`, `messaging-sw-client.ts:248`.
- Defect: `waitUntil(ready)` on install and activate means a failed hosted attach fails the install, retried only on the next registration.
- Acceptance: decide whether install must wait for the host. If not, install succeeds and the attach retries.

### C11. Behavior changes that need an explicit decision

Each is `declined` or `open` once you decide. Record the decision here.

- `auth.setTenantId` no longer retargets a live session (`packages/cli/src/serve/worker/host-auth.ts:305`). The real SDK only affects future sign-ins, so this may be a fix, but no test pins either behavior and listeners opened under the old tenant keep the old claim.
- The in-page tab-sync fallback no longer propagates sign-in and sign-out across tabs (`packages/cli/src/serve/entries/tab-sync-wiring.ts`). The rewritten tests pin the new behavior. This is a visible change for users of the fallback.
- Pending observations with no terminal status are exempt from every history limit (`packages/pyric/src/sandbox/internal/event-history.ts:232`). No code under `packages/cli/src/serve` emits `interrupted` or `cancelled` for a dropped client.

### C15. On `main`, Studio cannot attach to a hosted sandbox and reconnects in a loop

- Severity: should-fix; blocks using Studio while testing hosted mode. Slice: `studio`. Status: closed; merged as `main` `4b5fe6ae` (pull request 665, 2026-09-23), re-cut as `9e95f23b` after `main` moved. Found by the reviewer on 2026-09-23 when the owner asked whether all of hosted mode was on `main`. The reviewer had filed every Studio change under phase 5 and deferred the phase; that was too coarse, because the hosted client is product function and not polish.
- Observation, headless Chromium against `pyric sandbox --hosted` from a full build of `main`: Studio opened about 70 WebSocket connections to `/__pyric/sandbox` in 34 s, the page never reached network idle, the live activity feed read "No activity yet", and the seeded collection was not listed. The Node host was not disturbed: an MCP read afterward returned the document, and diagnostics still reported hosted and healthy.
- Cause: `studio/src/clients/worker-live.ts` on `main` never reads the hosted target, so Studio starts its own SharedWorker sandbox and `env.ts` registers it as the bridge's browser peer. The Node host already holds that role, the registration is refused, and Studio retries.
- Fix: nine files from the integration branch, none from the traffic inspector redesign: `clients/hosted-runtime.ts` (new), `clients/worker-live.ts` and its test, `clients/worker-runtime.ts`, `env.ts`, `shell/serve-init.ts`, `shell/StatusCluster.tsx`, and the playground's `lib/sandbox/runtime.ts` and `layouts/BaseLayout.astro`.
- Verified on the slice after a full build: against a hosted server Studio opens 2 sockets and holds them, lists the collection, and shows the write in the activity feed, matching the integration branch. Against a default SharedWorker server the probe's output is identical to `main`'s (2 sockets, the same network-idle timeout, the same 404s), so that mode is unchanged. Studio 549 tests and the UI suites pass; Studio, UI, and cli typecheck. The 401 responses in the hosted probe's console appear on the integration branch too and are not the cause.
- Left on the integration branch, still phase 5: the traffic request inspector, `TrafficSurface`, `traffic.css`, `verdict.ts`, `studio-events.ts`, the two `packages/ui` traffic components, and the playground checkpoint script.

### C16. The runtime chip's Overview and Flow highlights show nothing in `davideast/book-app`

- Severity: symptom of I20. Slice: not hosted. Status: closed with I20 on the shared branch at f4110c2f, not yet on `main`; cause found 2026-09-23. Reported by the owner after running hosted mode on three Vite and React applications: the chip's Overview and Flow highlights showed nothing.
- Cause, found by running the owner's application: the application does not load. `src/pyric.ts` imports `linkWithPopup` from `firebase/auth`; the served auth entry does not export it; the browser rejects the module graph with `SyntaxError: The requested module '.../@pyric/cli/dist/serve/entries/auth.js' does not provide an export named 'linkWithPopup'`; React never mounts and `#root` has no children. The chip is injected separately, so it appears over an empty page and has nothing to fold. It is identical in SharedWorker mode and in Node host mode, so it is not a hosted defect.
- What was ruled out on the way: the repository's highlights spec passes in all four configurations; a real application installed from `pack-local.sh` tarballs (Vite 7, React 19, JSX, `StrictMode`) paints Overview and Flow in both modes for an `onSnapshot` listener and for one-shot `getDocs` reads made from a plain module, which is how `book-app` reads; `book-app`'s lockfile holds one copy of `pyric`, so there are not two activity journals.
- Open question for the owner: the application cannot have rendered with a Pyric built from `main` or from the integration branch, and no branch on the remote exports `linkWithPopup` from the served entry. Either the page was blank in the owner's browser too, or the tarballs came from a build the reviewer cannot see.

### C17. Overview paints nothing until a render has been observed while the painting is on, and forgets it on reload

- Severity: should-fix. Slice: runtime chip, not hosted. Status: closed at a6037b8c (verified 2026-09-21). Ruled. Owner ruling, 2026-09-23 ("Begin the overview fix with your recommendation"): option (a), done narrowly. Observation starts when the mode is created and records regions without painting; painting starts and stops with the overlay as it does now; regions stay bounded as now; nothing is persisted across reloads. Assigned to the implementing agent in channel message 0089, acceptance first. Reported by the owner on 2026-09-23: Overview shows no highlights; switching to Flow and triggering an update makes Overview work; after a page refresh the Flow update is needed again.
- Reproduced by the reviewer in a real application installed from tarballs, in SharedWorker mode and Node host mode alike, for an `onSnapshot` listener and for one-shot `getDocs` reads: Overview turned on with no update afterward paints 0 boxes. The earlier reviewer probes and the repository's `vite-highlights` spec both click the application's button immediately after turning the mode on, which is why they pass.
- Mechanism, `packages/cli/src/serve/runtime/listener-mode.ts`: on a served page a listener's owner is a call frame, not a DOM element, so Overview's box is drawn around `observedElements(outline)`, the elements of the latest entry in `regions` for that listener. `regions` is written only by the Flow observer's `onObserved`, which fires when a delivery is followed by a React commit. That observer is started by `showPainting()` and stopped by `hidePainting()`, so it runs only while the overlay is on. Renders that happened before the developer opened the chip, which on an idle page is all of them, are never captured. `regions` and `observed` live in memory, so a reload empties them; the paint mode is remembered in storage but the fact that painting was on is not restored with its regions.
- Consequence: Overview is documented as "one box per attached listener, left there", and on a served page it is in practice "one box per listener that has re-rendered since you turned this on".
- Options. (a) Observe commits from the moment the mode exists, as the fold already does, so turning Overview on paints what already rendered; cost is a React commit hook on every served page whether or not the chip is opened, which the file's header says the design avoids. (b) Keep the lazy observer and say so: when Overview is on and a listener has no observed region, the panel states that the box appears after the next update, the way Flow already shows a waiting hint. (c) On enabling, replay: ask React for the current fiber tree once and attribute components to listeners by their recorded call frames, without a standing hook. (a) is the smallest change and matches what the mode's own description promises; (b) is the honest minimum; (c) is the most work.
- Correction and recommendation, 2026-09-23: the cost stated for (a) was wrong. `installReactCommitSource` is already called when the mode is created (`listener-mode.ts:233`, and again in `chip-install.ts:62`), so the React commit hook is present on every served page with a chip today. What is lazy is only the Flow observer that subscribes to it: the delivery and commit correlation and the DOM change collector behind `changes.drain()`. The reviewer recommends (a), done narrowly: start that correlation when the mode is created, recording regions without painting, and keep painting tied to the overlay as now. It fixes both halves of the report, because after a reload the application renders on load and an observer that is already running captures it, so nothing needs persisting. (b) fixes neither half, it only explains them; (c) rebuilds by hand what (a) gets from the running observer. The work in (a) is separating observation from painting, since `startFlowMode` currently needs the overlay's container. Regions stay bounded as they are now: pruned, at most 100 nodes each, held by `WeakRef`.
- Acceptance, whichever is chosen: a browser test that loads a page, waits for it to go idle, turns Overview on without touching the application, and asserts the outcome the chosen option promises; and the same after a reload.
- Reviewer verification of the first part, 2026-09-21, carried as `928dd405` and `682f286d`: acceptance 9 pass; cli package 3925 pass, 0 fail; flow-treatments 3 passed; with `onObserved` made a no-op the unit acceptance fails 2 of 7. Cost measured by the implementing agent, painting off: 200 delivery-and-commit pairs of 50 nodes 3.0 ms before and 138.8 ms after; 200 commits with no delivery 0.020 ms before and 0.119 ms after, with throwing fiber accessors proving no fiber walk on idle commits. In a real application packed from `682f286d` (Vite 7, React 19, fresh Chromium, page idle 3 s, Overview turned on, application untouched): Node host mode draws the box on a listener page and a one-shot page, before and after a reload; SharedWorker mode draws none, 4 of 4. A second experiment shows why: an update made with the chip still closed IS captured in SharedWorker mode, so the persistent observer runs before the panel opens, and what is lost is only the first delivery and its commit, which land before the listener mode is created because the local worker answers faster than the chip mounts. The browser acceptance passes in SharedWorker mode only because its fixture's first data arrives later than a real install's. Remaining work, assigned in channel message 0101: a test that orders the first delivery and commit before `createListenerMode`, and attribution recording that exists from when the runtime installs the React commit source rather than from when the chip builds its mode.
- Second part, 2026-09-21, carried as `c39555c9` and `a6037b8c`: observation now starts when the SDK's `init-payload` module evaluates, keeps at most 100 startup renders of at most 100 weakly held components, and the listener mode adopts them when the chip builds it; gated on the chip being enabled. Verified in the repository: acceptance 12 pass including held-mount cases in both transports; cli package 3928 pass, 0 fail; browser boundary budgets 13 pass; three browser suites with CI's flags pass; with the startup push disabled the unit acceptance fails 3 of 10. In the reviewer's real install packed from `a6037b8c` the result did not change: SharedWorker mode 0 boxes before and after reload on both pages, Node host mode 1 and 1. So the reviewer's startup-race diagnosis was wrong or incomplete, the third wrong cause the reviewer has offered for this item. Ruled out by observation: the chip and SDK are one module graph in that install, and the SDK bundle cache key hashes the built files. The reproduction is preserved outside `/tmp` at `pyric-hosted-channel/fixtures/real-react-app/` with its probes and results. Remaining: the implementing agent reproduces it there and reports the cause from page-side logging of deliveries, commits, and window matches in both modes before writing a fix (channel message 0107). The item stays open.
- Closure, 2026-09-21. The reviewer's remaining real-install report was a flaw in the reviewer's fixture, found by the implementing agent from page-side traces: the fixture's component starts at `useState(0)`, an empty SharedWorker sandbox delivers 0, React sees no change, no commit follows the delivery, and there is nothing to attribute; Node host mode differed only because its store held a value from earlier runs. Confirmed by the reviewer in the real install packed from `a6037b8c`, SharedWorker mode, fresh Chromium, seeded so the data differs from the initial state: 1 box on an idle page and 1 after a reload, on the listener page and the one-shot page. Both parts stand; the held-mount cases justify the startup buffer independently. Known limitation, recorded and not fixed: a delivery that causes no React commit, because the data equals the component's state or the result is empty, leaves Overview with no element to draw around. That is inherent to attributing by render; `overviewUnavailableReason()` covers an enabled Overview with no regions. Drawing a box for a listener that has never caused a render would be a new attribution decision.

## D. Spec gaps and contract violations

Contract: `docs/hosted-release-plan.md` and `docs/hosted-support.json`; the combined live-mode contract is preserved on `live/parked`.

### D1. The live Firestore surface is a stub

- Slice: `live`. Status: closed by removal at 14039436 (verified 2026-09-19; the reviewer removed one leftover workflow step that checked the deleted live Firestore entry's browser boundary). Ruled (owner ruling D3, 2026-09-18): remove `entries/live`, `serve/live`, and every doc reference from the release sequence; delete the emulator-backed tests under `test/e2e/live`; the live work parks on its own branch with gates 7 through 9 open. This also closes C3 (live capture growth) by removal.
- Contract: "Reads, queries, document listeners, query listeners, writes, batches, transactions, converters, metadata options, and the network/cache controls exposed by the normal Firestore entry need explicit forwarding or a documented refusal backed by a scenario."
- State: `packages/cli/src/serve/entries/live/firestore.ts` forwards `getDoc`, `doc`, `getFirestore`, `connectFirestoreEmulator`, and `DocumentSnapshot`. Everything else is a missing export. `live/unsupported.ts` throws at module evaluation, which breaks the importing module rather than refusing per operation. Gates 7 through 9 have no implementation.
- Acceptance: either the full surface with scenarios, or per-operation refusals each backed by a scenario. Until then the live entry is removed from the playground and the site docs.

- Removal scope clarification (review channel 0011): retain only sandbox/hosted declarations in `docs/hosted-support.json`, with `policyDocument` pointing to the release plan; keep its required CI check and wiring test in the evidence slice.

### D2. Close during startup returns success

- Slice: `host`. Status: closed at be6693b3 (verified 2026-09-20). The mount rejects the start caller with "The hosted sandbox closed during startup."; the hosted lifecycle scenario asserts the rejection. Reviewer probe: with the throw put back to a silent return in the built mount, the acceptance fails.
- Contract: "The start caller receives a closed-startup error."
- State: `packages/cli/src/serve/bridge-mount.ts:258` returns on `closed` and `startHostedSandbox` resolves. `section-one-lifecycle-startup.pw.ts:22` uses `Promise.allSettled` and never asserts the error.
- Acceptance: the start promise rejects with the contracted error; the scenario asserts it.

### D3. Observation backpressure closes the socket instead of reporting drops

- Slice: `transport`. Status: closed by contract amendment (2026-09-20); shared socket cutoff retained under the release ruling. The independently mapped memory budget remains open as I16. Verified 2026-09-20 by the reviewer at 9228d3cf: the policy test passes; every assertion of the original scenario survives the split with its threshold unchanged.
- Decision 2026-09-20: retain the existing shared 24 MiB socket backlog for this release; defer independent observation queues and drop reporting to D7.
- Contract: `docs/hosted-persistence-contract.md`, Transport backlog and recovery. All frames share one socket backlog; close with 1013 when the next frame would exceed 24 MiB. A stalled observation consumer interrupts its own operations; sent mutations may have completed. Reconnect restores observations without replaying writes.
- State: `packages/cli/src/bridge/server/socket-message.ts` implements this cutoff. No product change is required for the amendment.
- Acceptance: `bun scripts/verify-ledger.ts D3` selects the stalled-observation policy test: 1013 and reason, p95 below 1,000 ms, maximum below 2,000 ms, and a successful write afterward across both cycles. C1 separately proves restored observations. The original memory failures are preserved under I16, with the unchanged threshold and a separate acceptance map entry.

### D4. Capture flush deadline does not exist

- Slice: `host`. Status: closed at c6c899ed (verified 2026-09-20). The defect was in the worker's capture scheduler, not the server sink: the debounce timer never resets under traffic, but a POST that never settled blocked every later flush. Capture POSTs now abort after 2 s and the next flush is scheduled within the remaining pending-age budget. Scope of the bound: it limits scheduling delay and stalls; it does not promise storage when the endpoint stays unavailable. Reviewer probe: with the abort signal removed, the acceptance fails.
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

### D7. Per-consumer observation queue with drop reporting

- Severity: nit. Slice: `post-release`. Status: open.
- Location: bridge output scheduling and consumer lifecycle.
- Scope: bound pending observations per consumer at 1,000 events or 16 MiB of serialized data. Drop observation batches under pressure and report omitted count and range, preserving ordering around the gap. Keep operation and control scheduling independent; do not replay writes or classify data-subscription results as disposable history. Keep an overall transport safety bound.
- Wire decision 2026-09-20: reuse the existing `observation_gap` envelope with first and last event ids for the dropped range; do not add a numeric sequence protocol.
- Acceptance: count and byte boundaries; a stalled observation consumer receives a gap while its operation completes; another consumer remains healthy; drain and disconnect release all queued memory and timers. No cross-consumer queue sharing or write replay. Include a real slow-consumer browser case and lifecycle tests.

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

### F5. The two cli test shards do not partition the suite

- Severity: nit, cost only. Slice: `peel`. Status: open. Found by the implementing agent during the host extraction proofs, 2026-09-20; confirmed by the reviewer from CI logs.
- Location: `.github/workflows/build.yml` (`bun run test:ci:cli --shard=${{ matrix.shard }}/2`) and the `test:ci:cli` script in the root `package.json`.
- Defect: the pinned Bun release does not act on `--shard`. Both jobs on pull request 655 report the identical run, 3804 tests across 398 files, so every pull request runs the whole cli suite twice. Coverage is complete; about three minutes of runner time per pull request is wasted, and a failure that appears in only one job is an order or timing effect, not a property of that job's file set.
- Acceptance: either the two jobs run disjoint file sets whose union is the whole suite, proven by their reported file counts, or the matrix collapses to one job.

### F6. The popup sign-in acceptance hung once on `main` after two slices merged together

- Severity: should-fix, watch. Slice: `evidence`. Status: open as a watch item; artifact capture verified at 33aee755 on 2026-09-22 and cut for `main` as `slice/launcher-and-traces` with I18. Observed 2026-09-21 on `main` `a3940fb9`, the first commit to carry the bounded event log (pull request 657) and the follow-up fixes (pull request 658) together; the runs for the two preceding merge commits were cancelled by the next push, so the combination was first tested there.
- Observation: in the `Served app + SharedWorker conformance` job, `test/e2e/auth-popup.pw.ts` timed out at 30 s waiting for either a `signed-in:` status or `window.__authError`. Neither appeared, so `signInWithPopup` never settled: a hang, not a rejection.
- Evidence gathered by the reviewer: a rerun of the same job on the same commit passed. Locally on `a3940fb9`, `test:identity-conformance` passed 3 of 3 and the popup spec passed 15 of 15 repeats with eight busy loops competing for CPU. The spec did not fail in any of the 16 most recent failed `Build & Test` runs on any branch, so it has no flake history. The unrelated pull request merged alongside (659) touches only `experiments/`.
- Assessment: unexplained. One occurrence cannot separate a rare pre-existing race in the popup-to-opener handoff from an effect of the merged changes. Two of those changes alter what happens to a reply that cannot be delivered: C8 now discards a peer reply without a usable id where it used to fail every pending call, and C7 converts a forwarding throw into a failed result. A lost reply that used to surface as an error would now surface as exactly this, a call that waits out its deadline. The popup spec runs the SharedWorker path, which does not obviously cross the bridge, so this is a hypothesis to test, not a finding.
- Acceptance: either a second occurrence is captured with the bridge logger's diagnostics and the page console attached (the job uploads neither today), which decides the hypothesis, or 200 consecutive CI passes of the job accumulate without one. Add the Playwright trace and the serve process's stderr to the job's uploaded artifacts so the next occurrence is diagnosable.
- Artifact change: each of the job's five Playwright commands has its own results directory and retains traces on failure; an `if: always()` step uploads the shared parent. The common config also retains failure traces. Existing configs do not capture serve-process stderr to a file, so it remains in the CI log rather than the artifact; no harness restructuring, test, timeout, threshold, or retry changes. This improves capture of a recurrence; it does not explain the original hang or close the watch item.

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

- Severity: should-fix. Slice: `host`. Status: closed at 9fce2d1c (verified 2026-09-20). The acceptance drives the built CLI under Node against a database with an unreadable record: stdout and `recovery-report.json` agree on the excluded namespace and id, the source directory is byte-identical afterward, and the repaired copy opens. The blocking sub-items are resolved: I3 by the D1 revert, I7 as not a defect. Reviewer probe: with excluded records no longer reported by the built salvage module, the acceptance fails. Implemented at 26a6ae0d in `packages/cli/src/cli/salvage.ts` and `serve/hosted/persistence/salvage.ts`: source preserved by hash, output revalidated, empty output refused. Open sub-items I3 and I7 block closure. Companion to A3.
- Context: the persistence slice fails closed on a malformed application record and preserves the database directory for repair. Until a repair path exists, one malformed record blocks the host and `fresh` is the only remedy in practice.
- Acceptance: a CLI command reads a preserved database, reports unreadable records by namespace and id, and writes a repaired copy without modifying the original. The startup refusal message names this command. A3 closes when the command exists and the refusal names it.

### H2. Experimental warning on every hosted start

- Severity: nit, first-run. Slice: `host`. Status: open.
- Context: `node:sqlite` prints `ExperimentalWarning` at first use. The ownership lock already triggers it on the branch. Node can only disable the whole category, not one module.
- Acceptance: decide whether to disable the category on the hosted CLI path or accept the warning until Node marks the module stable. Either way, the getting-started path must not show an unexplained warning on first run.

## I. Delta review, 2026-09-17 (`470ba3d4..26a6ae0d`)

Unless noted, earlier items A1, A2, A4, A5, A6, A7, C1, C2, C3, D1, D2, D3, F1, and F2 remain present at 26a6ae0d. Typecheck passes for pyric and cli.

### I1. Live state can consume the whole history budget and evict every event

- Severity: blocker. Slice: `core`. Status: closed at `2ba2c664` (branch `hosted-main-integration`), together with I13 (omitted count). Verified 2026-09-18 by the reviewer: `verify-ledger I1 I13-omitted A4` all pass (3, 1, and 2); acceptance unchanged; retention, replay-gap, traffic-observation, active-listener, and rate suites 30 pass, 0 fail; pyric typecheck exit 0. Live reservations are charged at most half of each limit, so retained history always keeps at least half the budget; live state stays visible, so a snapshot can exceed the limits under live overload. Bounding live state itself depends on C11 (terminal status for a dropped client's pending observations). An attach is counted as omitted only when it actually leaves the snapshot.
- Location: `packages/pyric/src/sandbox/internal/event-history.ts:203`.
- Defect: `liveCount` and `liveBytes` reserve capacity but are themselves uncapped and never evictable. Once live state alone reaches `maxEvents` or `maxBytes`, every appended event is evicted into a `history-limit` gap.
- Failure: dangling `pending` observations accumulate because nothing under `packages/cli/src/serve` emits `interrupted` or `cancelled` for a dropped client (see C11). At 10,000 of them, retained history is zero and stays zero; replay and verify are refused permanently. Confirmed by probe at `maxEvents: 10`.
- Acceptance: cap live state independently of retained history, or count only the reserve against the limits. Test that pending observations beyond the reserve do not evict retained events.

### I2. Retention fixture fails deterministically on the tip

- Severity: should-fix. Slice: `host`. Status: closed at `08828705` by the D1 revert (branch `work/integration`, now the shared tip). Verified 2026-09-19 by the reviewer: the revert is the exact inverse of `6b450256`. Correction, same day: that inverse also dropped the explicit `null` auth argument from the batch call in `packages/pyric/test/rules/oracle-conformance.test.ts`, which the batch executor requires, so rules row 190 failed on the shared branch from `08828705` until the argument was put back; the reviewer had run only the cli suites at closure and missed it. The engine half of the revert lands on `main` as `slice/undo-revert` for every package file except one line retained from the later incremental-flush commit; no history or undo source remains; schema version 1; `hosted-sqlite.test.ts` 14 pass, 0 fail; cli typecheck exit 0.
- Location: `packages/cli/test/serve/fixtures/hosted-sqlite-retention.ts:59`.
- Defect: `assert.deepEqual` on two `DocumentSnapshot.data()` results, which are Proxy objects. Node's strict deep equality never treats two distinct proxies as equal. Verified at the assertion point: same prototype, equal fields, equal `Timestamp`, spread copies compare equal. The codec is not at fault.
- Failure: the hosted SQLite suite reports 22 pass, 1 fail on every run. Introduced in `6b450256`.
- Acceptance: compare plain copies or named fields; suite green.

### I3. Salvage overwrites readable history when it meets an unknown codec version

- Severity: should-fix. Slice: `host`. Status: closed at `08828705` by the D1 revert. Verified 2026-09-19 by the reviewer: history codec and history salvage removed; bucket salvage keeps the shared encoding validator.
- Location: `packages/cli/src/serve/hosted/persistence/history-codec.ts:4`, `history.ts:198`, `history-salvage.ts:33`.
- Defect: the history codec pins `encoding` to one literal, contradicting the shared `validatePersistenceEncoding` policy in `packages/pyric/src/sandbox/persistence/import-bundle.ts` that unknown codecs are not corruption. A record written by a newer encoding fails to parse, startup refuses, and salvage then replaces the record with an exclusion boundary. Bucket salvage already uses the shared validator at `salvage.ts:105`.
- Acceptance: history uses the shared seam; a fixture with a newer-encoding record salvages with the record retained.

### I4. Migration mutates a store before refusing it

- Severity: should-fix. Slice: `host`. Status: moot, confirmed at `08828705`: schema version 1, no migration code remains. The validate-before-migrate order is still required for any future migration; keep the ordering test when one is added.
- Location: `packages/cli/src/serve/hosted/persistence/database.ts:57`; validation order at `persistence.ts:19`.
- Defect: the v1 to v2 history migration writes tables and bumps `user_version` before `validateHostedDatabase` runs. A v1 store with malformed application records is modified, then refused. The contract requires refusal to leave the database unchanged.
- Acceptance: validate before migrate; test that a refused v1 store is byte-identical after refusal.

### I5. Transient `SQLITE_BUSY` latches the host unhealthy

- Severity: should-fix. Slice: `host`. Status: closed at dbd49609 (verified 2026-09-19). Persistence connections retry contention through SQLite with a 250 ms busy timeout per statement; the project-ownership lock retains 0. A real WAL reader and a competing writer released within the window leave persistence healthy. Exhausted retries remain fail-closed, with no acknowledged write. Reviewer probe: with the built artifact patched back to a zero timeout the recovery case fails with "database is locked" and the exhausted-retry case still passes, so the acceptance discriminates. Contract page records the policy.
- Location: `packages/cli/src/serve/hosted/persistence/database.ts:34`, `commits.ts:40`.
- Defect: the persistence connection sets `busy_timeout=0` and any busy result calls `markUnhealthy()`, a permanent latch until restart. A checkpoint, a snapshot reader, a backup agent, or antivirus produces the same outcome as corruption.
- Acceptance: a bounded busy policy on persistence connections (the ownership lock keeps 0), retry on busy, and a test that a concurrent reader during commit does not latch unhealthy.

### I6. Baseline was not frozen before implementation

- Severity: should-fix. Slice: `evidence`. Status: open.
- Location: `docs/hosted-persistence-baseline.md:4,18`; commit `1ac597ff`.
- Defect: the baseline doc, its JSON, the plan, the contract, and the entire SQLite backend land in one commit. The 25 ms acknowledgment budget was chosen after two of three runs. The post-implementation results JSON records the same commit hash as the baseline because the implementation was uncommitted when the script ran. Neither ceiling appears in any script or test; the harness fails only on errors.
- Acceptance: re-run the baseline at a commit that predates the backend and record its hash; encode both ceilings in the harness so it fails above them; store pre- and post-implementation runs under distinct commit hashes.

### I7. Salvage and archive open the copy read-only

- Severity: should-fix. Slice: `host`. Status: closed as not a defect (2026-09-19). The scratch copy is the whole directory in a writable temp directory, so SQLite recreates the -shm on a read-only open. Acceptance kept as a regression guard for a crash after a WAL commit with no -shm.
- Location: `packages/cli/src/serve/hosted/persistence/salvage.ts:54`, `archive.ts:49`.
- Defect: Correction: a crashed host leaves `state.sqlite-wal`. Without the `-shm` file SQLite cannot open a WAL database read-only, so salvage fails on the input it exists for.
- Acceptance: open the disposable copy read-write, or recover the WAL first; fixture with a `-wal` and no `-shm`.

### I8. Storage reads do not wait behind queued mutations

- Severity: should-fix. Slice: `host`. Status: closed at ee2bcc35 (verified 2026-09-19). `getBlob` and `listByPrefix` await the shared mutation queue, matching `getMetadata`. Reviewer probe: with the awaits removed from the built artifact the acceptance fails on the upload read, so it discriminates. Real Node SQLite acceptance covers upload, deletion, reset, and reads across bucket views.
- Location: `packages/cli/src/serve/hosted/persistence/storage.ts:57,93`.
- Defect: `getBlob` and `listByPrefix` skip the mutation queue that `getMetadata` awaits. A reader can see metadata for an object whose bytes are still queued, or a listing that omits it.
- Acceptance: all reads await the queue; test upload-then-list ordering.

### I9. Undo history grows the database without bound

- Severity: should-fix. Slice: `host`. Status: closed at `08828705` by the D1 revert, verified 2026-09-19. The `quick_check`-on-a-full-copy behavior in `archive.ts:44` is independent of undo and stays open as I9b: run `quick_check` in place, not on a copy of the whole directory.
- Location: `packages/cli/src/serve/hosted/persistence/undo.ts:14`, `history.ts:45`, `archive.ts:44`.
- Defect: every allowed write stores prior and next documents in `history_records` forever; nothing prunes. The history contract admits unbounded disk; the persistence contract does not mention it. `fresh` also copies the whole directory to the temp filesystem to run `quick_check`.
- Acceptance: a retention bound on `history_records` with a test, the bound stated in the persistence contract, and `quick_check` run in place.

### I10. Hosted mode is announced in the site docs while acceptance is failing

- Severity: should-fix. Slice: `evidence`. Status: open, ruled (owner ruling D2, 2026-09-18): remove the three public pages now; they return only when the phase 4 harness passes in CI with a committed artifact. Acceptance is the removal commit plus a site build with no hosted reference.
- Location: `packages/site-docs/src/content/build/hosted-persistence.md`, `reference/cli.md`, `get-started/vite.md`; `docs/hosted-multiclient-results.json`.
- Defect: the plan forbids release claims until every gate passes. Step 6 is open. The committed acceptance artifact is a failing run: 62,599 of 90,000 operations completed, p95 4,250 ms, maximum capture delay 1,025 s against a 2 s bound. The passing run the verification docs cite lives in gitignored `ignored/`.
- Acceptance: remove the public pages until step 6 passes, or commit the passing artifact and make the harness re-runnable.

### I11. Synchronous history decode on the request path

- Severity: should-fix. Slice: `host`. Status: closed at `08828705` by the D1 revert, verified 2026-09-19.
- Location: `packages/cli/src/serve/hosted/persistence/history.ts:151`; callers `undo.ts:139,167`.
- Defect: `recentEngineEvents` decodes up to 1,000 records with hash, parse, and schema validation synchronously, and backs `size()` as well as the event getters. A count request blocks the event loop for the full page.
- Acceptance: a separate count query; decode only on demand.

### I12. Bun refusal branch untested

- Severity: nit. Slice: `host`. Status: closed at 38141e92 (verified 2026-09-20). A Node fixture spoofs `process.versions.bun` and asserts the standalone-specific refusal with the database bytes and directory entries unchanged even when a fresh start is requested; the existing real-Bun case is mapped alongside it. Reviewer probe: with the Bun check disabled in the built SQLite and ownership modules, the acceptance fails.
- Location: `packages/cli/src/serve/hosted/persistence/sqlite.ts:18`.
- Defect: only the Node-version refusal is tested. Nothing spoofs `process.versions.bun`, so the branch that decides whether the standalone binary refuses cleanly is unverified.
- Acceptance: the same spoofing fixture for the Bun case.

### I13. Smaller items

- Status: closed at 617213e1 (verified 2026-09-20). Every sub-item below is fixed, removed by D1, or closed under another item. Reviewer probes: with the rollback guard removed the `I13-rollback` acceptance fails both cases; with the seed no longer entering the Storage mutation queue the `I13-seed` acceptance fails. Every `writeSection` and `seed` caller awaits the returned promise, and the queued seed joins one reentrant transaction.
- `history-export.ts:275` left `.segment-*.tmp` and `.checkpoint-*.tmp` behind on a failed export. Removed with the export implementation by D1 at `08828705`.
- `sqlite.ts:43` a throwing `ROLLBACK` after a failed `COMMIT` replaced the original error. Fixed at `015c99ba`; acceptance: `I13-rollback`.
- `state-view.ts:96` the storage seed bypassed the mutation queue. Fixed at `fa9e5501`; acceptance: `I13-seed`.
- `history-route.ts:9` wrote the 200 status before evaluating the body, so a throw sent headers twice. Removed with the history route by D1 at `08828705`.
- `serve-init.ts:365` capture delivery re-armed after the POST settled. Closed with D4 at `c6c899ed`, verified by the reviewer; its mapped acceptance pins the 2 s deadline.
- `event-history.ts:209` counted evicted listener-attach entries as omitted although `snapshot()` still returned them. Closed as `I13-omitted` with I1 at `2ba2c664`.
- Terminology: `persistence.ts` now describes existing browser/MCP files; `undo.ts` was removed by D1 at `08828705`.

### A11. A set followed by a delete of the same path in one batch evaluates the set as a delete

- Severity: nit. Slice: `core`. Status: open. Follow-up from the A1 verification.
- Location: `packages/pyric/src/firestore/sandbox/atomic-write-pipeline.ts:148`.
- Defect: after the A1 fix, only `set` operations still derive their rule method from the batch projection. When a later operation in the same batch deletes the path, the projection is null and the `set` is evaluated under the delete rule. On `main`, `set` classified by existence only. Production evaluates each write under its own method with `getAfter` reflecting the final state.
- Acceptance: a batch of `set` then `delete` on one path under `allow create, update: if true; allow delete: if false` is denied for the delete and the set's evidence names `create` or `update`, never `delete`.

### C12. Served worker does not re-deploy RTDB rules after a reset

- Severity: should-fix. Slice: `transport`. Status: closed at 7cedc51b (verified 2026-09-20). Reset re-deploys the active or last-known-good RTDB rules before acknowledging, matching Firestore; the acceptance pins allowed and denied access on both sides of the reset. Reviewer probe: without the re-deploy the acceptance fails. Pre-existing on `main`; surfaced by the A2 verification.
- Location: `packages/cli/src/serve/worker/host/studio.ts:52`; the RTDB rules source is retained at `ctx.activeRules.database` by `serve-init.ts:103`.
- Defect: after `resetAll`, the worker re-deploys only the Firestore rules. Its comment assumes RTDB rules survive the reset. On `main` the backend reset already cleared them, and after A2 the session boundary clears them too, so a Studio reset in served mode leaves RTDB under the default deny policy until the rules file next changes.
- Failure: served app with `database.rules.json` granting reads; Studio reset; every RTDB read is refused until the developer edits the rules file.
- Acceptance: the worker re-deploys `ctx.activeRules.database` after `resetAll` the same way it re-deploys Firestore rules, and `packages/cli/test/serve/worker/reset-all-op.test.ts` gains a case mirroring its Firestore case at line 107: an RTDB read governed by active rules still succeeds after `resetAll`.

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

### C13. Bridge sends a Buffer instead of a string and breaks the peer handshake

- Severity: blocker for the transport slice. Slice: `transport`. Status: closed at `2a39d6b7` (branch `work/integration`). Verified 2026-09-19 by the reviewer: `verify-ledger C13` 6 pass, 0 fail; `bun test packages/cli/test/bridge` 1320 pass, 0 fail; worker suite green after regenerating the cli registries; cli typecheck exit 0. The Buffer conversion is removed and the string send restored; frame and backlog checks unchanged. Pre-existing on `origin/hosted-live-mode`; found by the phase 1 exit gate.
- Location: `packages/cli/src/bridge/server/socket-message.ts:30`, commit `5e8f40a3` ("queue UTF-8 buffers for slow readers").
- Defect: `socket.send(Buffer.from(payload), { binary: false })` replaced `socket.send(payload)`. Bisected by the reviewer on 2026-09-18: `packages/cli/test/bridge/peer-standby.test.ts` is 6 pass at the parent `6433d9bd` and 6 fail at `5e8f40a3`, including "sandbox not connected" after a peer hello. Every later tip inherits it.
- Failure: a bridge peer connects, sends hello, and the server's reply arrives in a form the client does not accept as a bridge frame, so the sandbox is never marked connected.
- Acceptance: `bun test packages/cli/test/bridge` green with no test changed. If the intent was to avoid retaining large strings, prove the benefit with the sustained-write harness before reintroducing it, and keep the frame a text frame the clients parse.

### I14. The unhealthy-persistence gate admits RTDB, admin, and state mutations

- Severity: should-fix. Slice: `host`. Status: closed at 57ca27d4 (verified 2026-09-19). Pre-existing; made visible by A7's enumeration. One policy table in `worker/operation-persistence.ts` drives admission, and the flush helper's method parameter accepts only methods the table marks true, so a new flush under a false method fails typechecking. `rtdb.goOffline` and `auth.setProviderConfig` were added to the gated set. Reviewer probe: flipping one method to false in source fails the acceptance for that method. Note for extraction: the fix edits worker host files that belong to transport paths; it rides with the host slice.
- Location: `packages/cli/src/serve/hosted/persistence-admission.ts`, the `return false` group.
- Defect: `rtdb.update`, `rtdb.push`, `rtdb.setPriority`, `rtdb.setWithPriority`, `rtdb.transactionCommit`, `admin.setDocument`, `admin.deleteDocument`, `importState`, `checkpoint`, `deleteCheckpoint`, and `auth.setProviderConfig` are classified as not requiring healthy persistence. Each mutates persisted state. While persistence is `committed-but-not-durable`, these are still admitted, so the contract's "block further mutations" holds only for the listed subset.
- Acceptance: every method that reaches a persistence flush is classified `true`, derived from the same source the flush path uses rather than hand-listed; a test that walks `OpMessage['method']` and asserts each mutation is gated.

### A14. A collection reference is not a query in pyric's Firestore types

- Severity: should-fix, blocks the foundation slice. Slice: `core`. Status: closed at `1138983b` (branch `work/integration`, fast-forwarded to `origin/hosted-main-integration`). Verified 2026-09-19 by the reviewer: `verify-ledger A14` 1 pass, 0 fail; the reviewer's independent probe compiles with zero diagnostics; Firestore SDK and sandbox suites 1775 pass, 0 fail; pyric typecheck exit 0. One-declaration fix, `CollectionReference<_T> extends Query<_T>`. Found by the extraction proof on 2026-09-19.
- Location: `packages/pyric/src/firestore/types.ts`, `CollectionReference` and `Query`.
- Defect: `Query<T>` is `{ _isQuery?: true }`, a weak type, and `CollectionReference<T>` is `{ id; path }`, so a collection reference is not assignable to `Query`. In the Firebase SDK `CollectionReference<T> extends Query<T>`. On `main` this was masked for `onSnapshot` only, because `CollectionReference` and `DocumentReference` were structurally identical and `onSnapshot` accepts either. The slice adds `withConverter` to `DocumentReference`, so `onSnapshot(collection(db, 'users'), cb)` now fails to typecheck. `getDocs(collection(db, 'users'))` and `const q: Query = collection(db, 'users')` already failed on `main`.
- Reviewer probe against the slice's pyric: three errors (TS2559 on assignment to `Query`, TS2345 on `onSnapshot`, TS2559 on `getDocs`). Against `main`: the two TS2559 errors only.
- Failure: any consumer typed against `pyric/firestore` directly (Studio, `@pyric/ui`, in-page sandbox apps) cannot subscribe to a collection without wrapping it in `query()`. The branch worked around this in `packages/studio/src/clients/worker-live.test.ts` with exactly that wrap, which hides the type defect.
- Acceptance: `CollectionReference<T>` extends `Query<T>` in `types.ts`; a type-level test in `packages/pyric/test/firestore/ledger/` compiles a probe with the TypeScript API (the A7 technique) asserting zero diagnostics for the three probe lines above; main's Studio compiles against the slice without the `query()` wrap. Land the fix on `hosted-main-integration` first, then re-run the extraction so the slice's first commit stays byte-equal to the remote diff.

### I15. The snapshot fixture resolves the built CLI from the working directory

- Severity: blocker for the host pull request. Slice: `host`. Status: closed at 6fe34321 (verified 2026-09-20). Found by running CI's package-directory invocation locally before the pull request, as the host extraction spec's step 5 requires. The reviewer reproduced the whole cli package under `bun test --cwd packages/cli` on the slice: 3880 pass, 21 skip, 0 fail.
- Location: `packages/cli/test/serve/fixtures/hosted-sqlite-snapshot.ts:7`.
- Defect: the fixture joins `process.cwd()` with `packages/cli/dist/cli/snapshot.js`. It passes from the repository root but duplicates `packages/cli` when CI runs `bun test --cwd packages/cli`, causing `ERR_MODULE_NOT_FOUND` before snapshot assertions execute.
- Acceptance: statically import `../../../src/cli/snapshot.js`, like the persistence import, so `runNodeFixture` resolves the built module through its source-to-dist rewrite. The case passes both from the repository root and under `bun test --cwd packages/cli test/serve/hosted-sqlite.test.ts`. The I15 map selects `offline snapshots`; package-directory invocation is also required.

### I16. The Firestore engine's event log retains every written document without bound

- Severity: blocker for announcing hosted mode (phase 4 exit), not for the flag-gated host pull request. Slice: `core`. Status: closed at acc7401e (verified 2026-09-21; host acceptance promoted at cf8f8909). Reviewer verification: the engine-only probe under `node --expose-gc` holds 14.4 to 14.5 MiB across four cycles where it climbed to 203.2 MiB; the six-cycle collected-heap acceptance passes on a second machine; with pruning removed from the built engine that acceptance fails with 202,380,112 bytes of retained growth, and the seven engine cases fail with pruning removed in source. Eviction is oldest-first in append order, so the omitted events are always a prefix of the log and undo cannot restore across an omitted write. The resident-memory ceiling is tracked separately as I17. Reproduced by the reviewer at 9228d3cf on a second machine, two runs: growth of 282,820,608 then 342,654,976 bytes, and 281,542,656 then 319,455,232 bytes. The second cycle added 38 to 60 MiB there against 108 MiB on the implementing agent's machine, which is consistent with growth that is slowing but does not establish it; the six-cycle diagnostic with forced collection decides.
- Location: `packages/pyric/src/firestore/sandbox/event-log.ts`. Host acceptance: `packages/cli/test/e2e/hosted/i16-collected-heap.pw.ts`.
- Defect: the existing scenario exceeds its 201,326,592-byte ceiling. Earlier runs measured 202,080,256 and 215,810,048 bytes after the first cycle. The split test preserves that ceiling and uses soft assertions so both cycles are measured.
- Evidence: one split memory run on 9c5bf75e with the test split measured 223,821,824 bytes after cycle 0 and 332,480,512 bytes after cycle 1: another 108,658,688 bytes in the second cycle. Growth continues across cycles rather than plateauing after the first. This is a possible leak signal, not evidence sufficient to attribute a leak to a particular allocation. A bounded six-cycle diagnostic with two forced collections after each cycle is authorized to distinguish retained objects, uncollected garbage/allocator effects, and bounded buffers filling toward their caps; no retainer hunt is authorized.
- Acceptance: `bun scripts/verify-ledger.ts I16-core I16`. After two forced collections per cycle, host heapUsed at cycle 5 minus cycle 1 must be under 16 MiB. The pre-fix diagnostic difference was 202,351,896 bytes. The original resident-memory test and 192 MiB ceiling are preserved unchanged under I17. The engine fix at acc7401e is independently verified; the reviewer must verify the promoted host acceptance before I16 closes.


Bounded diagnostic (Node 22.15.0, 2026-09-20, six cycles, 192 replacements of
256 KiB per cycle): both `gc()` calls and `process.memoryUsage()` execute inside
the host through its loopback Node inspector. Each stalled consumer closes with
1013 and the contracted reason; the page writes successfully afterward. Values
below are bytes after collection, not growth from the baseline.

| Cycle | rss | heapUsed | external | arrayBuffers | Retained history count / bytes |
| --- | ---: | ---: | ---: | ---: | --- |
| 0 | 245,956,608 | 119,882,688 | 3,669,674 | 94,690 | Not reachable through inspector import |
| 1 | 301,580,288 | 170,563,704 | 3,669,674 | 94,690 | Not reachable through inspector import |
| 2 | 354,074,624 | 221,189,344 | 3,669,674 | 94,690 | Not reachable through inspector import |
| 3 | 351,764,480 | 271,781,272 | 3,669,674 | 94,690 | Not reachable through inspector import |
| 4 | 407,797,760 | 322,412,040 | 3,669,674 | 94,690 | Not reachable through inspector import |
| 5 | 436,207,616 | 372,915,600 | 3,669,675 | 94,691 | Not reachable through inspector import |

Before the fix, heap after collection does **not** plateau by cycle 5 (the sixth cycle): it rises
from 119,882,688 to 372,915,600 bytes, with about 50.6 MB added per later cycle.
The pre-burst collected baseline was 71,075,504 bytes of heap and 211,959,808 bytes
RSS. External memory and array buffers remain effectively flat. Thus delayed
collection/allocator fragmentation alone does not explain the measured heap
growth; the retaining owner is not identified by this diagnostic.

After the fix at acc7401e, one run of the promoted acceptance (same Node
22.15.0 fixture and six cycles) produced these collected measurements, in bytes:

| Cycle | rss | heapUsed | external | arrayBuffers |
| --- | ---: | ---: | ---: | ---: |
| 0 | 224,280,576 | 73,673,944 | 3,669,674 | 94,690 |
| 1 | 196,870,144 | 73,823,304 | 3,669,674 | 94,690 |
| 2 | 195,166,208 | 73,964,616 | 3,669,674 | 94,690 |
| 3 | 195,706,880 | 74,048,832 | 3,669,674 | 94,690 |
| 4 | 193,282,048 | 74,159,832 | 3,669,674 | 94,690 |
| 5 | 199,311,360 | 74,209,240 | 3,669,675 | 94,691 |

Collected heap plateaus by cycle 1 for this acceptance: cycle 5 minus cycle 1
is 385,936 bytes, below the 16,777,216-byte limit, versus 202,351,896 bytes
before the fix. All six stalled consumers closed with 1013 and the expected
reason; every healthy follow-up write succeeded. History introspection remains
unavailable for the previously recorded inspector-import reason. This host run
passed once (43.7 s); the original uncollected RSS test was not rerun or changed.

Configured history limits remain 10,000 events / 8,388,608 bytes, including a
live-state reservation of at most half that budget. Measured history count and
bytes are unavailable: the diagnostic attempted the existing `SandboxImpl.history()`
API via inspector object discovery, but inspector evaluation refused the module
import with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. No product instrumentation
was added and no alternate retainer investigation was attempted. The diagnostic
releases its inspector object group after every sample and closes its browser,
sockets, and host in `finally`.

Reproduce only when another run is authorized:
`node node_modules/@playwright/test/cli.js test --config=scripts/diagnostics/i16-memory.config.ts`.
This originally isolated diagnostic is now promoted to the normal hosted acceptance
as i16-collected-heap.pw.ts. It does not change the uncollected 192 MiB test,
which remains independently mapped as I17.

Reviewer isolation probe: a bare built `LocalEnvironment` with materialized
256 KiB strings and 192 writes per cycle retained 9.4 MiB baseline, then 58.5,
106.8, 155.0 and 203.2 MiB of collected heap (768 events). Clearing its engine
`eventLog` reduced heap to 11.0 MiB. The engine event log holds every event's
data and prior documents without eviction; this predates hosted mode. Bound
both retained and undone events under one count/byte budget while preserving
undo/redo within the retained window and exposing omitted count to the events
tool. Proposed defaults: 10,000 events and 8 MiB, matching observation history
and bounding repeated large replacements. Reuse the history limit shape and
byte estimator through a dependency-free sandbox leaf module.

Implementation evidence: the engine log now uses a single 10,000-event / 8 MiB
serialized-byte budget across visible and undone events, sharing the dependency-free
limit shape and byte estimator with observation history. Oldest-first eviction
follows append order even after undo/redo reorders stacks. Undo stops at the retained
boundary, redo works within it, and the simulator events tool reports omitted count.
The core acceptance has seven cases, including a separately reproduced undo/redo
ordering edge case. The original hosted memory acceptance passed in one run without
changing its 192 MiB ceiling: cycle 0 growth 69,189,632 bytes, cycle 1 growth
90,046,464 bytes (previously 223,821,824 and 332,480,512). The browser run preceded
the subsequent undo-stack ordering correction; its workload does not use undo/redo.
The subsequent six-cycle acceptance promotion is recorded above. Independent
reviewer verification of that acceptance remains required before closing I16.

Reviewer verification of acc7401e: the isolated engine probe plateaued at 14.4,
14.4, 14.5 and 14.5 MiB after collection across four cycles, retaining 15 events.
Removing prune() fails all seven core cases. The unchanged resident-memory test
is not reproducible across machines; its measurements and baseline requirement
are now tracked by I17. The collected-heap limit was set by the reviewer before
running the promoted acceptance, with no product changes.

### I17. The slow-consumer resident-memory ceiling predates persistence and is not reproducible across machines

- Severity: should-fix. Slice: `evidence`. Status: open.
- Location: `packages/cli/test/e2e/hosted/section-five-slow-client.pw.ts`, resident-growth test; the file and its 192 MiB (201,326,592-byte) ceiling remain unchanged.
- Defect: uncollected RSS immediately after a 48 MiB write burst varies with garbage collection and allocator behavior across machines. The engine leak is independently verified fixed, but this metric continues to cross the old ceiling without a consistent growth trend.
- Acceptance: `bun scripts/verify-ledger.ts I17`. Under I6, re-derive the ceiling from a frozen baseline on the CI runner, with collection forced before sampling or a stated tolerance, and pass the test in the phase 4 CI job. The existing test remains independently mapped and may fail until then; I16's collected-heap acceptance does not replace or weaken it.

All recorded resident-growth measurements are bytes:

| Machine | Engine state / run | Cycle 0 | Cycle 1 |
| --- | --- | ---: | ---: |
| Codex | Before fix, combined test 1 | 202,080,256 | Not reached |
| Codex | Before fix, combined test 2 | 215,810,048 | Not reached |
| Codex | Before fix, split test | 223,821,824 | 332,480,512 |
| Reviewer | Before fix, run 1 | 282,820,608 | 342,654,976 |
| Reviewer | Before fix, run 2 | 281,542,656 | 319,455,232 |
| Codex | After fix | 69,189,632 | 90,046,464 |
| Reviewer | After fix, run 1 | 242,810,880 | 178,864,128 |
| Reviewer | After fix, run 2 | 190,119,936 | 223,133,696 |
| Reviewer | After fix, run 3 | 228,884,480 | 160,940,032 |

### I18. Three hosted launcher messages describe browser-owned state

- Severity: nit, first-run. Slice: `host`. Status: closed at 2345047e (verified 2026-09-22; the implementing agent's 5294dc3d carried onto the shared tip). Verified by the reviewer from the built CLI in an empty project: a first hosted start with a seed prints `--seed applied` with its counts; `--fresh` tells the user to stop the host and rename the archive directory to `.pyric/state/hosted`; with a child command under `--hosted` the browser-resident notice is absent and the Node-process line is present. The SharedWorker wording is unchanged. Found by the reviewer on 2026-09-21 while running hosted mode from packed tarballs on `main` `40d1cd35`.
- Location: the launcher's persistence summary line, recovery-backup note, and child-command browser-connection notice in `packages/cli/src/cli/serve.ts` and the session code it calls.
- Defect, first message: on a first start with `--seed` in a project that has no store, the fixture is loaded into the empty SQLite store and then read back, so the summary prints `1 doc(s), 0 user(s) restored; --seed skipped`. The seed was applied; the line says it was not.
- Defect, second message: after `--hosted --fresh` the note reads `a recovery backup exists at .../.pyric/state/hosted.archive-<time>-<id> ... Restore: mv it back over state.json`. The archive is a directory and the restore is to stop the host and rename it to `.pyric/state/hosted`; following the printed instruction does nothing useful.
- Defect, third message: with `--hosted --no-open` and a child command, the launcher says the sandbox is browser-resident and asks the user to open a page to connect. The Node sandbox is already running, so that instruction is unnecessary and false.
- Acceptance: `bun scripts/verify-ledger.ts I18`. A hosted first start with a seed reports the seed as applied, with its counts; the hosted `--fresh` note names the directory rename. Both pinned by a CLI test on the hosted path, including a restart that reports existing state rather than re-applying the seed. The child-command browser-connection notice is absent in hosted mode, which already reports that the sandbox executes in this Node process; the same notice stays unchanged in browser mode. The SharedWorker wording stays as it is for that mode.

### I19. `@pyric/cli`'s Vite peer range excludes the current Vite major

- Severity: should-fix. Slice: `core` packaging, unrelated to hosted mode. Status: closed on the shared branch at 91915434, not yet on `main`; ruled. Owner ruling, 2026-09-24 ("Go with this recommendation"): do not widen the range first. A fixture with a dependency that itself imports `firebase/firestore` proves, under Vite 7 and Vite 8, that the dependency's import resolves to the served entry; the plugin supplies `rolldownOptions` when the running Vite supports it and `esbuildOptions` otherwise, with no deprecation warning on either; only then does the peer range admit `^8.0.0`. Assigned to the implementing agent in channel message 0096, to start after C17. Found by the reviewer on 2026-09-23 while scaffolding a fresh React application for C16.
- Location: `packages/cli/package.json`, `peerDependencies.vite` is `^5.0.0 || ^6.0.0 || ^7.0.0`.
- Defect: `npm install` of a project on Vite 8 with `@pyric/cli` fails with `ERESOLVE`, because `@vitejs/plugin-react` 6 requires Vite 8 and the peer range stops at 7. A new project scaffolded today gets Vite 8 by default.
- Tried on Vite 8.3.0 with `--legacy-peer-deps`, 2026-09-24, in the reviewer's real application: the page loads, writes work, and the chip's Overview and Flow paint, in SharedWorker mode and Node host mode. Vite prints: "`optimizeDeps.esbuildOptions` option was specified by "pyric:sandbox" plugin. This option is deprecated, please use `optimizeDeps.rolldownOptions` instead." That option is how `vite-module-swap.ts` installs `optimizerMirror`, the plugin that redirects `firebase/*` imports found inside pre-bundled third-party dependencies to the served entries. The test application has no such dependency, so whether Vite 8's Rolldown optimizer still honors it is unproven; if it does not, a library that imports Firebase would bundle the real SDK.
- Acceptance: a fixture with a dependency that itself imports `firebase/firestore`, run under Vite 7 and Vite 8, asserts the dependency's import resolves to the served entry in both; the plugin supplies `rolldownOptions` when the running Vite has it and `esbuildOptions` otherwise, with no deprecation warning on either; then the peer range admits `^8.0.0`. Until that passes the range stays as it is and the install failure is the accurate signal.
- Reviewer verification, 2026-09-21, at `91915434` (acceptance `88f670d4`, `e2c10e7d`; product `3b59b8fa`, `91915434`), a fast-forward: I19 acceptance 5 pass; I20, A5, A7 pass; cli package 3968 pass, 0 fail, no other sweep running; cli and Studio typechecks clean; frozen lockfile install exit 0; three browser suites and the boundary budgets pass. The peer range widened in its own commit after the four runtime cases passed. Reviewer probe: with the esbuild optimizer mirror bundling the served entry again, exactly the two Vite 7 cases fail and the Vite 8 and packed-install cases pass, so each major's optimizer path is pinned separately. The module that reads Vite's version is loaded only by the Vite plugin, which already imports Vite at run time, so the optional peer stays optional for every other command.

- Baseline finding (2026-09-21): the third-party dependency fixture fails on Vite 7.3.6 and 8.3.0 in both SharedWorker and Node modes with `app/no-app`. The existing optimizer mirror bundles the served entry and its module-local app registry into the dependency, separate from the application's direct `initializeApp` import. This is also a defect on `main`, not specific to Vite 8. The optimizer redirects now leave served entries external at their Vite module URLs, preserving one module instance across direct and dependency imports. Acceptance compares every served entry's module namespace and the default app identity across those importers, reads a sandbox-only seed, and refuses production Firestore requests. Vite 8 selects the Rolldown hook by the running Vite version; earlier majors retain the esbuild hook. The peer range changes only after all four runtime cases pass, in a separate commit.

### I20. The served auth entry exports 34 of the engine's 75 auth names, and importing a missing one prevents the application from loading

- Severity: blocker for any application that imports one of them; present on `main` before the hosted work, in SharedWorker mode and Node host mode alike. Slice: `core` served entries. Status: closed on the shared branch at f4110c2f, not yet on `main`; parts 1 and 2 verified at 735a074f; part 3 complete and verified: linking 78ccebc0, reauthentication 48cc1e52, action codes and email links 0d61aaee, custom token and token accessors 6accbaff (2026-09-21); part 4 (tool reporting) verified at f4110c2f (2026-09-21); ruled. Owner ruling, 2026-09-24 ("Just go with your recommendation"), in this order: first, every public runtime name the real Firebase module exports exists on the served entry, and a name served mode cannot perform throws a named `FirebaseError` when it is called rather than when it is imported; second, a test derived from the real package's export list guards all seven entries; third, the functions the engine already implements are forwarded through the worker protocol, `linkWithPopup` first; fourth, `pyric_can_i_use` reports served availability and accepts the Firebase module paths. Ranked above I19. Assigned to the implementing agent in channel message 0098, to start after C17. Found by the reviewer on 2026-09-23 through the owner's `davideast/book-app`.
- Location: `packages/cli/src/serve/entries/auth.ts` against `packages/pyric/src/auth` (`pyric/auth`).
- Defect: a served application's `firebase/auth` import resolves to the served entry. A named import the entry lacks is a link-time `SyntaxError`, so the whole module graph is rejected, the framework never mounts, and the only signal is one console line. The engine already implements the missing functions for the in-page sandbox.
- Missing at `main` `4c13df35`, 41 names. Functions an application is likely to import: `linkWithPopup`, `linkWithCredential`, `linkWithRedirect`, `unlink`, `reauthenticateWithCredential`, `reauthenticateWithPopup`, `reauthenticateWithRedirect`, `sendPasswordResetEmail`, `confirmPasswordReset`, `verifyPasswordResetCode`, `sendEmailVerification`, `verifyBeforeUpdateEmail`, `applyActionCode`, `checkActionCode`, `sendSignInLinkToEmail`, `isSignInWithEmailLink`, `signInWithEmailLink`, `signInWithCustomToken`, `getIdToken`, `getAdditionalUserInfo`, `revokeAccessToken`, `validatePassword`, `parseActionCodeURL`. Classes and constants: `TwitterAuthProvider`, `SAMLAuthProvider`, `AuthCredential`, `OAuthCredential`, `EmailAuthCredential`, `ActionCodeURL`, `ActionCodeOperation`, `AuthErrorCodes`, `OperationType`, `ProviderId`, `SignInMethod`, `FEDERATED_PROVIDER_IDS`, `browserCookiePersistence`, `browserPopupRedirectResolver`, `indexedDBLocalPersistence`, `debugErrorMap`, `prodErrorMap`. (`TARGET_SYMBOL` is internal and should stay out.)
- Measured across every served entry, 2026-09-24, by bundling `firebase/<module>` and the served entry with esbuild and comparing the metafile's export lists (a text scan is wrong here: it cannot follow `export *`). Public runtime names the real package exports and the served entry lacks, ignoring Firebase's underscore-prefixed internals: `app` 1 (`initializeServerApp`); `auth` 54; `firestore` 50; `database` 0; `storage` 4 (`StorageErrorCode`, `StringFormat`, `getStream`, `list`); `messaging` 4 (`onRegistered`, `onUnregistered`, `register`, `unregister`); `ai` 10 (the live and template model surface). The Firestore gaps most likely to be imported by an ordinary application: `connectFirestoreEmulator`, `documentId`, `FieldPath`, the aggregate builders `count`, `sum`, `average` with `getAggregateFromServer`, `queryEqual`, `refEqual`, `snapshotEqual`, `loadBundle`, `namedQuery`, and the classes `Transaction`, `WriteBatch`, `QueryConstraint`, `FirestoreError` when they are used as values. The auth list additionally includes what the engine does not implement either: the phone, multi-factor, reCAPTCHA, and `fetchSignInMethodsForEmail` surface.
- How the application came to import it, reported by the owner: the agent that wrote `book-app` asked `pyric_can_i_use` about `linkWithPopup`, and the tool answered `available`, `conforms`, `eligible`. The reviewer reproduced that answer on 2026-09-23. It is true of the import path the tool names, `pyric/auth`, which is the in-page engine. It says nothing about the served entry a Vite or `pyric sandbox` application resolves `firebase/auth` to. Asked with `importPath: 'firebase/auth'` the tool returns "No conformance feature matched that query", not "unavailable in served mode". So the tool's answer is correct for a question the agent was not asking, and it has no way to express the question the agent was asking.
- Reviewer verification of parts 1 and 2, 2026-09-21, carried as `40056068`, `d8860830`, and `735a074f`: I20 acceptance 23 pass; `packages/pyric` 7663 pass, cli package 3940 pass, conformance 391 pass, all 0 fail; pyric, cli, Studio, and conformance typechecks clean; `compat:generate` leaves the committed projections unchanged; parity check, coupling gate, and conformance gates exit 0. With `linkWithPopup` removed from the served entry the guard fails with "Missing served firebase/auth exports: linkWithPopup". The owner's `davideast/book-app`, installed from tarballs packed at `735a074f`, now mounts in SharedWorker mode and in Node host mode: `#root` has content and 34 buttons and the page logs no errors, where before it had no children. Calling `linkWithPopup` there still throws the named served-mode error until part 3. The class-c factory throws only when called or constructed; `connectFirestoreEmulator` and `connectStorageEmulator` are logging no-ops. Served entry sizes grew by at most 3,021 bytes on 1.18 MB (auth), so no budget is added. `queryEqual` and `snapshotEqual` are class c because served query handles keep no converter identity and served query snapshots keep only size, empty, and docs; widening those handles is outside this item. Published numbers move: nine runtime exports newly mapped (AI 6, Auth 1, Storage 2), each a real engine value compared entry for entry with the pinned Firebase package; upstream totals and frozen observations unchanged. The pull request that lands this states that delta and its cause.
- Reviewer verification of part 3's linking group, 2026-09-21, carried as `27d89a75` (acceptance) and `78ccebc0`: I20 acceptance 29 pass including the new browser cases in both transports; A5, A7, and I14 still pass, I14 now walking 43 methods; cli package 3946 pass, 0 fail; browser boundary budgets 13 pass; three browser suites with CI's flags pass; cli and Studio typechecks, parity check, and coupling gate clean. `linkWithPopup` and `linkWithRedirect` resolve the credential on the page with `authType: 'link'` and send `auth.linkWithCredential` for the connection's own uid and tenant, never signing in as the picked identity; `auth.unlink` is the second new operation. Both are classed as persisted mutations in `operation-persistence.ts`, so the unhealthy-persistence gate covers them through the typed flush policy. The host refuses a request whose uid or tenant is not the connection's session with `auth/user-mismatch`, waits for the flush before acknowledging, and installs the refreshed session only if the original is still active. Reviewer probes: with the mismatch check removed the host acceptance fails 1 of 4; with the still-active guard removed it fails 1 of 4. The client's internal `currentUser` mirror now subscribes to `idToken` instead of `authState`, so a same-uid provider change is visible without announcing a sign-in to application observers; `worker-runtime.test.ts` pins the pair of subscriptions exactly.
- Reviewer verification of part 3's reauthentication group, 2026-09-21, at `48cc1e52` (acceptance `48a3f733`), a fast-forward of the shared tip: I20 acceptance 32 pass; A7 and I14 pass; cli package 3947 pass, 0 fail; three browser suites and the boundary budgets pass; cli and Studio typechecks clean. All three reauthentication functions forward to the host and run the engine's own verification: the credential path keeps password checking and wrong-account errors, the provider path resolves on the page with `authType: 'reauth'` and the engine refuses an identity whose uid differs. The two new operations are session-only (`false` in `operation-persistence.ts`): tokens change, stored account records do not, and the host acceptance asserts record equality and no extra flush. Reviewer probe: with the connection-session match removed from `requireMatchingPortSession`, the host acceptance fails. A second probe, classing the operations as persisted, does not fail anything, because the persistence gate's test asserts that every flushing method is gated and not the converse; over-gating a session-only operation is safe, so this is recorded and not pursued.
- Reviewer verification of part 3's action-code and email group, 2026-09-21, at `0d61aaee` (acceptance `68a38865`, `6db9ccf0`), a fast-forward: I20 acceptance 42 pass; A5, A7 pass; I14 pass, now walking 46 methods; `packages/pyric` 7664 pass, conformance 391 pass, cli package 3957 pass, all 0 fail; pyric, cli, and Studio typechecks clean; `compat:generate` leaves the projections unchanged; coupling gate exit 0 against the prior shared tip; three browser suites and the boundary budgets pass. Ten names now forward: `sendPasswordResetEmail`, `sendEmailVerification`, `verifyBeforeUpdateEmail`, `applyActionCode`, `checkActionCode`, `verifyPasswordResetCode`, `confirmPasswordReset`, `sendSignInLinkToEmail`, `isSignInWithEmailLink`, `signInWithEmailLink`. By owner-delegated ruling the engine's in-memory Auth outbox is forwarded as one host-control operation, `auth.takeMail`, sandbox-wide as in-page and classed session-only, so a served page can complete a real send, read, redeem cycle, which the browser acceptance does in both transports. Operations that change an account (`auth.signInWithEmailLink`, `auth.applyActionCode`, `auth.confirmPasswordReset`) are classed as persisted; the sends and `takeMail` are not. Engine change: `resolveEmailLinkIdentity` is extracted so the served host can mint a detached per-port session without calling the public global sign-in; the in-page `signInWithEmailLink` still performs the global transition, pinned by `test/auth/ledger/i20-email-link-session.test.ts`. Reviewer probe: with that transition removed from the public function, the pinned test fails.
- Reviewer verification of part 3's last group, 2026-09-21, at `6accbaff` (acceptance `5376a0c5`), a fast-forward: I20 acceptance 46 pass; A5, A7, I14 pass; `packages/pyric` 7665 pass, conformance 391 pass, cli package 3958 pass, all 0 fail; pyric, cli, Studio typechecks clean; `compat:generate` unchanged; coupling gate exit 0; three browser suites and the boundary budgets pass. `signInWithCustomToken`, `getIdToken`, and `getAdditionalUserInfo` forward. `resolveCustomTokenIdentity` is extracted like the email-link resolver so the host mints a detached per-port session, flushing before it binds; `auth.signInWithCustomToken` is classed persisted because it can create an account. The implementing agent's characterization showed that reusing the provider session kind would have added a provider-enabled check the public function does not have, so a narrow custom kind keeps only disabled-user enforcement, pinned on both paths. Reviewer probe: with the global transition removed from the in-page function, `i20-custom-token-session.test.ts` fails. Follow-up requested: in the extraction the new-user record changed from `...(payload.claims ? { customClaims: payload.claims } : {})` to `customClaims: payload.claims`, which sets the key to `undefined` for a token without claims; the in-page path was to stay identical, so the conditional form is restored or a test shows the difference is unobservable in the stored and exported record.
- Reviewer verification of part 4, 2026-09-21, at `f4110c2f` (acceptance `21281306`, `f1d994b9`; product `8dcaff2b`, `f4110c2f`), a fast-forward: I20 acceptance 59 pass; A5, A7, I14 pass; `packages/pyric` 7665 pass, conformance 391 pass, cli package 3968 pass, all 0 fail, no other sweep running; pyric, cli, Studio typechecks clean; `compat:generate` unchanged; tool parity and coupling gate exit 0; three browser suites and the boundary budgets pass. The feature query reports a `served` status beside engine availability, never rewriting the engine claims, and accepts `firebase/*` import paths. The served inventory is generated at CLI prebuild from the seven served entries' real exports; imports-only names come from the unsupported modules, and a committed snapshot shows when a name changes class. From the built CLI: `linkWithPopup` is available and served `supported`; `linkWithPhoneNumber` is served `imports-only`; `beforeAuthStateChanged` and Storage `updateMetadata`, which export and then always refuse, report `imports-only`, and the served refusal is their first caveat. The custom-token record keeps the conditional `customClaims` form. First submission failed review: on a clean checkout the CLI prebuild loaded the feature query before the step that generates the gitignored served inventory, so the package build exited 1; the implementer's tree held a stale copy. The generator now runs first, and `i20-clean-prebuild.test.ts` runs the real prebuild in a source copy with the inventory removed. Reviewer probes: with the old prebuild order restored that test fails with the missing-module error; with `linkWithPhoneNumber` removed from the unsupported module the export guard and the classification snapshot both fail; a package build with the inventory deleted succeeds.
- Acceptance, in two parts. First, no import can blank an application: every runtime name `firebase/auth` exports exists on the served entry, and one the served path cannot perform yet throws a `FirebaseError` that names the function when it is called, not when it is imported. A test derives the expected names from the `firebase/auth` package the repository already depends on and fails when the served entry lacks one; the same check for the other served entries (`firestore`, `database`, `storage`, `messaging`, `ai`, `app`) is in scope, since the failure mode is the same. Second, the linking, reauthentication, and action-code functions the engine implements are forwarded through the worker protocol, with `linkWithPopup` first because an application is blocked on it today. Third, `pyric_can_i_use` reports served availability: a feature the engine supports and the served entry does not export is reported with a caveat that names served mode, and `importPath: 'firebase/auth'` (and the other Firebase module paths) resolves to the served entry's export list instead of matching nothing.

- Part 2 equality ruling (channel 0113): `refEqual` uses the served reference's port, path, and converter. `queryEqual` and `snapshotEqual` remain imports-only and throw a named FirebaseError when called. Query handles retain ordered constraints but no converter identity or `withConverter`; query snapshots retain only size, empty, and docs, with no source query, owning port, or metadata. Handle/protocol expansion is outside this item.
- Part 3 linking group: `linkWithPopup`, `linkWithRedirect`, `linkWithCredential`, and `unlink` forward to the authoritative host and reuse the engine's account-linking policy. The new operations require healthy persistence and acknowledge after flushing. Browser acceptance covers both served modes, UID/tenant preservation, current-user provider state, credential sign-in, errors, and stale-user refusal. Host acceptance also covers port isolation and a sign-out during persistence. Remaining forwarding groups and served-availability reporting stay open.
- Part 3 reauthentication group: credential, popup, and redirect reauthentication reuse engine verification and refresh the existing connection's token and authorization claims while preserving UID/tenant. The two wire operations change session state only; acceptance asserts persisted account records stay identical and no persistence flush occurs. Browser cases in both modes cover token freshness, wrong-password/wrong-user refusal, another app's session isolation, owned-data access, and resolver identity checks. The engine's documented absence of recent-login enforcement remains unchanged.

- Part 3 email group: the served action-code and email-link functions use the engine's single-use codes and mailbox. `takeAuthMail` consumes the sandbox-wide in-memory mailbox; any attached page can take mail, matching the in-page driver. Sending or consuming mail changes no persisted record and performs no flush. Redeeming account changes flushes before acknowledgment. Email-link identity resolution reuses the engine validation without changing global Auth; the host mints a detached connection session. No external email is sent.

- Part 3 token group: `signInWithCustomToken` resolves the engine's existing token formats and mints a detached tenant session after persisting account changes. Custom-token sign-in remains independent of provider enablement and still rejects disabled users. The engine's documented lack of signature verification is unchanged. `getIdToken` delegates to the user's transport-bound accessor; `getAdditionalUserInfo` reads the canonical credential metadata populated from the host's new-user result. Browser acceptance covers both transports, custom claims through Security Rules, tenant and other-app isolation, invalid tokens, and new versus existing accounts.

- Part 4 tool reporting: `pyric_can_i_use` and the Node/browser query facades report `served: supported | imports-only | missing` for runtime exports, separately from canonical engine availability, fidelity, and assurance. The generated projection uses the same bundled export comparison as the completeness guard and the actual refusal modules; stale projections fail acceptance. All seven `firebase/*` module paths resolve using the canonical import-to-surface map. Erased TypeScript interfaces keep their existing evidence without a runtime classification. Imports-only results warn that the function throws when called in served mode.

### I21. inspect_auth_flow advertises take_mail and nothing implements it

- Severity: should-fix. Slice: `core tools`. Status: open, assigned to Codex; ruled. Owner ruling, 2026-09-21 ("Go with your recommendations"): connect the advertised action to the forwarded Auth outbox operation and keep it advertised; a failing acceptance through the real tool dispatcher comes first; the tool parity check applies; it lands on `main` as its own pull request after I20, whose operation it depends on.
- Location: `packages/cli/src/bridge/surface/render/discriminator-schemas.ts` advertises `take_mail`; `packages/cli/src/bridge/surface/render/discriminator-routes.ts` has no corresponding `AUTH_ROUTES` entry or handler.
- Defect: the rendered tool advertises a mailbox action that cannot dispatch. The engine has a consuming, in-memory Auth outbox and the served worker now forwards `auth.takeMail`; the rendered tool still does not reach it.
- Scope: connecting the existing operation may be a small route/handler change, but the tool dispatch and schema must be tested together. It is separate from served SDK forwarding and awaits the owner's call.
- Acceptance: invoking the advertised action through the real tool dispatcher returns and consumes an issued Auth mail, preserves sandbox-wide reach, and returns an empty result after consumption without changing persisted records.

## E. Evidence owed

### E1. Conformance evidence for the foundation slice's engine changes

- Severity: should-fix. Slice: `evidence`. Status: open. Filed 2026-09-19 when the coupling gate refused the foundation pull request.
- Context: the slice changes engine files under `packages/pyric` without moving any observation, registry row, or generated projection. `compat:generate` and `compat:validate` produce no diff, the conformance suite passes, and the registry count is unchanged, so the pull request carries a `Conformance-Exempt` trailer stating exactly that. The exemption is a claim that nothing observable changed; it is not evidence that the new behaviors match production.
- Owed: registry rows with oracle observations for (a) the query validation refusals introduced on the branch (unsupported target descriptors, order directions, filter operators, non-array membership operands, invalid limits), asserting that pyric refuses what the Firebase SDK refuses and accepts what it accepts; and (b) the atomic write rule method, asserting that batch and transaction `update` on a missing document and `create` on an existing document produce the production error codes.
- Acceptance: the rows exist with `oracle-backed` automation and captured observations; `compat:conformance` verifies them; the registry count test is updated; the trailer's reason is no longer needed for any later slice touching the same files.

### A15. A7 changed the unknown-method wire text the remote client parses

- Severity: should-fix, blocks the transport slice. Slice: `core`. Status: closed at `984e75e6` (branch `work/integration`, now the shared tip). Verified 2026-09-19 by the reviewer: `verify-ledger A15` 10 pass, 0 fail; A7 and C13 acceptance still pass on the same commit; remote and entries suites 30 pass, 0 fail. Both defaults now throw `Unknown method: <method>`. Found by the reviewer's transport dry run on 2026-09-19.
- Location: `packages/cli/src/serve/hosted/persistence-admission.ts` and `packages/cli/src/serve/worker/inbound-validation/operation-arguments.ts`, the `never` defaults added by A7.
- Defect: both throw `Unknown sandbox method: <method>.` Every host dispatch site refuses with `Unknown method: <method>` (`worker/host/dispatch.ts:122` and seven service handlers), and the remote client keys its version-skew guidance on `/^Unknown method:/` at `packages/cli/src/remote/index.ts:438`. A refusal from the new validation path therefore reaches the client without the restart-or-reload guidance. `packages/cli/test/remote/loop-hold.test.ts:324` fails.
- Acceptance: both defaults throw `Unknown method: <method>` with no trailing period; `bun test packages/cli/test/remote` green with no test changed; the A7 acceptance still passes.

### C14. Served-entry tests depend on which file evaluated the browser entry first

- Severity: blocker for the transport pull request. Slice: `transport`. Status: closed (verified 2026-09-19). Two fixes landed. The transport pull request carries the direct cause, the composite served-entry test's `SharedWorker` double lacking `addEventListener` (65536ea7 on `slice/transport`, d44ecc81 here); its second CI shard is green. The shared branch also carries the structural fix at 47161358: the served RTDB cases run unchanged in a fresh process (`rtdb-served-entry.cases.ts`), and the acceptance preloads a no-`SharedWorker` evaluation of the entry before the suite to reproduce the prior order. The structural fix is test-only and rides with the host slice extraction rather than reopening the transport pull request. Found by CI on the transport pull request, 2026-09-19.
- Location: `packages/cli/src/serve/entries/worker-runtime.ts` (`useWorker` and `hasSharedWorker` captured at module evaluation; `openWorkerDb` refuses when `useWorker` is false) and `packages/cli/test/serve/worker/rtdb-integration.test.ts:40,168` (installs a `SharedWorker` double inside each case, then dynamically imports `entries/app-client.js`).
- Defect: in one `bun test` process the entry evaluates once. CI's Linux runner orders files differently from macOS, and in its second shard some earlier file evaluated the entry with no `SharedWorker` global, so `useWorker` was captured false and both cases that reach `openWorkerDb` fail with "No Pyric worker transport is initialized in this browser context." The whole shard passes locally in either pairing the reviewer tried, so the poisoning file is not yet identified. `main`'s `openWorkerDb` had the same capture but gated only on the captured `SharedWorker` presence; A5 added the `useWorker` refusal.
- Acceptance: the served-entry cases pass regardless of file order. Either the test evaluates the entry in its own realm or process, as the A5 page and Service Worker fixtures already do through `test/serve/entries/worker-runtime-realm.ts`, or `openWorkerDb` consults the live globals at call time in page realms instead of the captured value, with a test that evaluates the entry first without a `SharedWorker` and then installs one. Prove with `bun test --cwd packages/cli --shard=2/2` green on the transport slice in CI, since local order does not reproduce it.
