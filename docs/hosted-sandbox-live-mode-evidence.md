# Hosted sandbox and live mode: execution evidence

This ledger records observed results, not release approval. The full sequence and its gates remain required. S1–S6 and their documented scope were explicitly approved in the active user goal.

## Current candidate: checkpoint persistence and restore subscriptions, 2026-09-13

Current source digest: `6b778d2ed96f7aea0a8ebed29f18e98411aa2a433886a625a96b67d4a2e3fb39` (224 source files). Seven source/fixture files changed after the independently revalidated Auth candidate.

Three S1/S2/S3 cycles retain their respective fixture digests between red and green:

- `/tmp/pyric-checkpoint-restart-{red,green}`: an acknowledged checkpoint disappeared after immediate host termination. Hosted execution now uses the existing project directory checkpoint backend; restart finds the checkpoint and restore updates the normal SDK listener. The intermediate storage-only failure and direct-read diagnosis remain in `/tmp/pyric-checkpoint-restart-storage-only.log` and `/tmp/pyric-checkpoint-listener-diagnostic.log`.
- `/tmp/pyric-checkpoint-admin-listener-{red,green}`: explicit admin listeners remained stale after restore. The existing subscription-intent registry now retains all data lenses, rebinds them after restore and preserves unsubscribe and port cleanup. Auth transitions still rebind only app-session subscriptions. The initial raw-relay fixture shape error is retained separately and is not behavior red evidence.
- `/tmp/pyric-checkpoint-restore-durability-{red,green}`: restore acknowledged success against an unwritable state directory. It now awaits the host's persistence policy, reports committed-but-not-durable and refuses a subsequent restore while unhealthy.

Review preserves original page provenance and guard truthiness and names changed teardown decisions. Final verification passes 37 focused browser scenarios in 1.0 minute, including default SharedWorker checkpoint restore and affected Auth/remote/reconnect/RTDB behavior; 164 existing tests in ten isolated processes; strict CLI/fixture types; and 217-file code form. Reports use `/tmp/pyric-checkpoint-final-`. The 454-case, 57-file collection is inventory only. CLI artifacts were rebuilt. Unchanged Pyric/site artifacts and five browser-leaf reports are explicitly reused; no changed module contributes to those leaves. Minimum-Node, standalone and full-suite results remain historical.

The existing directory backend still skips corrupt checkpoint files and validates their envelopes shallowly. Full checkpoint metadata fidelity, interrupted/concurrent saves, import/reset listener restoration, atomic all-service persistence, complete lifecycle/resource accounting and browser/hosted live work remain open. This candidate is a checkpoint for manual QA and PR planning, not feature completion or release approval.

## Previous candidate: Auth durability and mutation admission, 2026-09-13

Current source digest: `eb899feeefca9c96dd8f4aaf2a3aba4d60ca8d900368b1e3b337c42e8743e4fe` (221 source files). The previous ownership candidate was independently revalidated. Only the hosted persistence admission classifier and one new fixture changed.

The initial SDK characterization passed: create an account, immediately SIGKILL the host after acknowledgment, restart, sign in with the same credentials, compare its UID and authorize Firestore work under the selected tenant. Its report is `/tmp/pyric-auth-restart-characterization.log`. This checks session-to-rules propagation; the existing shared user pool does not establish persisted tenant ownership or tenant account-pool isolation.

Three S1/S2/S3 red/green cycles preserve their respective fixture digests:

- `/tmp/pyric-auth-create-admission-{red,green}`: after an account creation commits in memory but cannot persist, a second creation must be refused and its credentials must not sign in.
- `/tmp/pyric-auth-change-admission-{red,green}`: profile, email, password and deletion calls must be refused before altering the existing account; its original credentials and profile still work.
- `/tmp/pyric-auth-pool-admission-{red,green}`: anonymous/provider sign-in, identity acceptance and the four admin user operations must leave the public user list unchanged after refusal.

Every red received `committed-but-not-durable` where admission should have returned `persistence-unhealthy`. The minimal fix adds twelve explicit cases to the existing Node classifier. Review retains the shared handlers, imports, resource ownership and default runtime selection.

Final verification passes 26 focused browser scenarios in 43.8 seconds (including SharedWorker/in-page identity), 13 Auth cases on Node 22.15 in 19.8 seconds, 47 worker regressions in three isolated processes, strict CLI/fixture types and 214-file code form. Reports use `/tmp/pyric-auth-admission-final-`; the production build is `/tmp/pyric-auth-pool-admission-build.log`. The 450-case, 56-file collection is inventory only. CLI artifacts were rebuilt; unchanged Pyric/site artifacts and browser bundle reports are explicitly reused. The prior standalone binary and broad-suite results are historical and are not current completion evidence.

Provider settings, session bookkeeping, complete Auth metadata/checkpoint restoration, remaining SDK/control admission, coherent all-service persistence, full lifecycle, browser/hosted live execution and release gates remain required. No full subsection or feature gate is closed.

## Previous candidate: in-process MCP and service-command ownership, 2026-09-13

Current source digest: `11d05dbd00c70633c447b4d5a404b5113a8d38c360b629493a7ffe76a0bd1f43` (220 source files). The previous CLI/Vite candidate was independently revalidated before implementation. Two S1/S3 cycles preserve their respective fixture digests between red and minimal green:

- `/tmp/pyric-in-process-owner-{red,green}`: after a valid hosted SDK write, removing the discovery pointer made ordinary MCP fallback connect to another in-process sandbox in the same project. The session now reserves the selected canonical state directory before loading data and holds it through shutdown. The connection refuses with the ownership error while the original SDK state remains available.
- `/tmp/pyric-in-process-cli-owner-{red,green}`: an explicit in-process service command acknowledged a competing write while MCP owned the project. The command now reserves state across load, dispatch and save. It refuses with exit 2 while MCP owns it, then successfully writes and reads after MCP shuts down.

Separate review names decisions in the extracted session body, preserves timing and existing persistence/error behavior, and updates selection guidance. Green characterizations verify reverse startup order, graceful persistence/reopening, failure before readiness, a relative project selector through a symlink, and independent project selection. The copied standalone executable now has a direct in-process MCP ownership/transport-close test. These use actual commands and published MCP/SDK interfaces; no internal collaborator is mocked in the new tests.

Reports use `/tmp/pyric-in-process-owner-final-`: 18 focused browser cases pass in 42.1s; six existing MCP attachment and project/instance-admission cases in 14.7s; five minimum-Node cases in 10.9s; four copied-standalone cases in 16.1s; 55 existing in-process/CLI/selector regressions in five processes. Strict CLI/public-fixture types, 213-file code form and diff whitespace checks pass. CLI and standalone artifacts are rebuilt. Pyric/site artifacts and browser budget reports are reused only after input/contributor identity checks. Collection confirms 437 hosted scenarios in 55 files; this is not a full hosted-suite pass for the current candidate.

In-process execution still uses its existing runtime, `in-process.json` and Storage sidecar. It does not yet adopt the hosted runtime or migrate either format. This slice prevents competing owners while preserving explicit execution selection; a running in-process owner must finish before another persistent owner opens the same project. Complete writer inventory, shutdown under failures, unified persistence/restoration/admission, live credentials/behavior, bounded observations and the complete runtime/OS/package release matrix remain required. No full subsection, production access, publishing or remote CI pass is claimed.

## Previous candidate: CLI/Vite ownership and restart cleanup, 2026-09-13

Current source digest: `a32dea16853ec45ce7c7e1466b444a232217cb63dd2f555584a27be922eaa34f` (218 source files). Three vertical S1/S3 cycles retain their unchanged fixture digests between red and minimal green:

- `/tmp/pyric-hosted-browser-owner-{red,green}`: a second `--persist --fresh` CLI advertised readiness while a hosted process owned acknowledged data. CLI browser persistence now claims the existing canonical lock before startup. The refusal and SDK-visible value after forced restart pass; reverse startup order and graceful release are characterized separately.
- `/tmp/pyric-hosted-vite-owner-{red,green}`: Vite with persistence and fresh reset also started against an occupied directory. Its generation now claims and releases the shared lock. The refusal and SDK-visible saved value after host restart pass.
- `/tmp/pyric-hosted-vite-restart-owner-{red,green}`: a real Vite restart released the replacement's lock, allowing a competing CLI to become ready. Vite 5 constructs the replacement before closing the old server. The plugin's global closeBundle hook closed the currently active replacement. Cleanup now captures each server's own generation and wraps that server's close method; the replacement retains ownership and the normal SDK reads the persisted value.

Separate review names decisions in the edited generation factory, preserves optional HTTP-server handling, updates older lifecycle fixtures to close their server, and removes touched unsafe assertions/suppression. The Vite fixture uses a canonical temporary project; early diagnostics exposed untransformed imports through the platform's temporary-directory alias. The final fixture preserves the real application, restart and data assertions, and contains no debug instrumentation. Initial review failures and diagnostic transcripts remain under `/tmp/pyric-hosted-vite-restart-*`; they are not counted as passes.

Verification uses `/tmp/pyric-hosted-project-owner-final-`: 16 ownership/SDK browser cases pass in 40.1s; five minimum-Node cases in 17.5s; three rebuilt copied-standalone cases in 11.3s; 120 existing Vite/serve/persistence regressions pass in 18 processes. A final assertion-only cleanup in the legacy generation fixture is additionally verified by all 27 cases in that file. Strict CLI/public-fixture types, 211-file code form and whitespace checks pass. The existing real-Firebase SDK/App/Auth Vite proof passes in 9.2s against isolated emulators using the existing Java 21 runtime. The first attempt lacked Java on PATH and failed during setup; that failure is retained separately. Pyric/site artifacts and browser contributor budgets are reused only after identity checks; CLI and standalone artifacts are rebuilt.

Collection confirms 432 hosted scenarios in 54 files. Collection does not execute them. The preceding 427-case full run remains historical and is not claimed for this candidate. This slice uses focused checks; subsection completion and integration joins still require their complete applicable gates.

Other state-writing entry points, full teardown under failures, generation fencing, coherent/atomic multi-service state, import/restore, remaining SDK admission, live credentials/behavior, observation bounds and the complete runtime/OS/package release matrix remain open. No full subsection, production access, publishing or remote CI pass is claimed.

## Previous candidate: legacy HTTP state writer ownership, 2026-09-13

The preceding reset candidate was independently verified against 211 source files, all artifact/contract identities, 204 code-form inputs, 23 reports and two matched TDD pairs. This candidate changes the namespace's state-write admission, its session assembly and one new public caller fixture.

A S1/S2/S3 cycle reads an older valid mirror through the existing HTTP state channel, acknowledges a newer value through normal SDK imports, then replays the mirror with the current session capability. Running memory still shows the newer value. Red exposes the overwrite only after SIGKILL/restart: the SDK then reads `Older mirror value` instead of `Acknowledged hosted value`. This reaches writer admission rather than merely exercising an expired capability. Reports/source snapshots: `/tmp/pyric-hosted-state-writer-{red,green}`; the fixture digest is identical across that pair.

The session now supplies a static browser/host state owner. Hosted state remains inspectable after existing Host/Origin/session checks; browser mutations receive 423 before body collection. Hosted startup already mounted this channel without explicit `--persist`, so the protection applies to the default hosted path. The Node runtime writes through its direct persistence backend. Separate review names routing decisions, keeps guards and route selection ordered, pairs the activity sink with its capability, and removes touched non-null assertions and a conditional spread. It also verifies the exact refusal code and characterizes default SharedWorker persistence handing acknowledged SDK data to a restarted host.

Current source digest: `16cf5d7c7754ceed54080bf9a854ed1c298895e32e316d792cdae02112e6850e` (213 source files). All 427 current hosted browser tests pass in 16.6 minutes, with collection independently confirming 53 files. Additional verification passes 14 minimum-Node cases, five Studio cases, three rebuilt copied-standalone cases, 629 worker/bridge regressions in 83 isolated processes, 117 namespace/session regressions in seven processes, strict CLI/public-fixture types, 206-file code form and diff whitespace checks. Reports use `/tmp/pyric-hosted-state-writer-final-`. CLI and standalone artifacts were rebuilt; unchanged Pyric/site artifacts, five browser budget reports and 412 Storage/state regressions are explicitly reused.

Some full-suite cases were slower than their focused runs; later cases returned to their usual duration. One read-only snapshot found seven processes and no zombies in the current suite's process tree. That observation does not prove resource lifetime or performance gates. No failing test was retried or assertion relaxed to obtain the full-suite result.

The hosted server's HTTP writer path is protected. Separate non-hosted CLI/Vite processes and other entry points still need canonical ownership verification. Complete generation fencing, coherent and atomic multi-service state, import/restore and all-service admission/recovery, lifecycle, bounded observations, complete live execution and the full runtime/OS/package release matrix remain required. No full subsection or release gate is closed by this candidate.

## Previous candidate: reset persistence and admission, 2026-09-13

The preceding overlap candidate was independently verified against 209 source files, all artifact/contract identities, 202 code-form inputs, 19 reports and its TDD pair. A separate extraction moved the normal Storage SDK fixture and platform Blob-read delay into one test helper; the unchanged overlap test passed before new behavior tests were added (`/tmp/pyric-hosted-reset-fixture-review.log`).

Two S1/S2/S3 red/green cycles retain their respective fixture digests. First, a public remote reset ran while a browser save was paused in platform binary I/O. SDK listing showed empty memory, both operations acknowledged, then SIGKILL/restart restored the discarded object. Reset now awaits the existing runtime persistence policy before acknowledgment; the unchanged restart assertion stays empty. Second, reset executed while persistence was already unhealthy and returned `committed-but-not-durable`. Hosted admission now refuses with `persistence-unhealthy` before clearing state, and the SDK still reads the saved in-memory bytes. Reports and source snapshots use `/tmp/pyric-hosted-reset-{persistence,admission}-{red,green}`.

Separate review removes an unnecessary cast from the shared reset handler and documents its persistence ordering. A default SharedWorker characterization began green: reset clears Storage, the clear survives page reload, and a subsequent normal SDK upload/read works. The four-case review also retains the overlapping-save proof.

Current source digest: `2562ea89d323f085938636abc004b7339f315c3257a58c8de38b481f5053fab1` (211 source files). Final verification passes 67 affected integration/state-replacement scenarios, 12 minimum-Node cases, five Studio cases, three freshly rebuilt copied-standalone cases, 629 regressions in 83 isolated processes, strict CLI/public-fixture types and 204-file code form. The complete inventory collects 425 tests in 52 files. Reports use `/tmp/pyric-hosted-reset-final-`. Unchanged Pyric/site artifacts, five browser budget reports and 412 Storage/state regressions are explicitly reused. CLI and standalone artifacts were rebuilt.

The reset barrier handles a pending save whose mutation already occurred. It does not establish generation fencing for every asynchronous mutation, coherent snapshots, atomic multi-service commits, import/restore durability or complete admission/recovery. The legacy HTTP state writer mounted with `--persist` is still a competing-writer path. Remaining lifecycle, bounded observations, live execution and release requirements remain open. No full subsection or release gate is closed.

## Previous candidate: overlapping persistence ordering, 2026-09-13

The preceding candidate was independently verified against 208 source files, all artifact/contract identities, 201 code-form inputs, 36 reports and seven matched TDD pairs. This change adds one S1/S3 race test and one host-owned queue.

A CLI preload pauses a platform Blob read while one browser saves. A second browser overwrites the same object, and a third reads that newer value through ordinary SDK imports. The test releases the read, waits for both upload acknowledgments, kills the host and reconnects. Red returned `Older value` after restart; green returns the independent expected literal `Newer value`. Reports/source snapshots: `/tmp/pyric-hosted-persistence-ordering-{red,green}`. The fixture digest is identical across that pair. The test does not query private maps or use the persistence file as its outcome oracle.

The runtime queues the complete explicit controller/Storage flush, preventing older asynchronous snapshots from finishing last. The requesting caller receives failures; the queue still drains already-accepted later work. Separate review makes the external release signal idempotent for cleanup, retaining all behavioral assertions.

Current source digest: `2c5d9706c609d917ef23899d55a94a2588ff37001979fae1f22704474499cab1` (209 source files). Final verification passes 49 affected integration scenarios, nine minimum-Node cases, three freshly rebuilt copied-standalone cases, 629 regressions in 83 isolated processes, strict CLI/public-fixture types and 202-file code form. The complete inventory collects 422 scenarios in 51 files. Reports use `/tmp/pyric-hosted-ordering-final-`. Pyric/site artifacts, browser contributors and five budget reports are unchanged and explicitly reused, together with the prior 412 Storage/state regressions and five Studio cases. Current hosted diagnostics execute in the affected browser suite.

This queue fixes one demonstrated data-loss race. Coherent snapshots during concurrent mutations, reset/flush generations, automatic controller flushes, atomic multi-service commits, all buckets, other writer entry points, complete admission/recovery and the remaining lifecycle/live/release requirements stay open. No full subsection or release gate is closed.

## Previous candidate: SDK persistence admission and Storage restoration, 2026-09-13

Seven S1/S3 red/green cycles cover RTDB set/remove refusal after persistence failure; Storage upload/delete committed-state errors and subsequent refusal; and acknowledged Storage upload/deletion surviving immediate host termination. Reports and source snapshots use `/tmp/pyric-hosted-persistence-` with `rtdb-set`, `rtdb-remove`, `storage-upload`, `storage-admission`, `storage-delete`, `storage-delete-admission`, and `storage-restore`, followed by `-red` or `-green`. Each pair retains its fixture digest.

The restart review initially failed: Node Storage uses a memory backend and its sandbox registry intentionally omits object snapshots. This became a separate failing-test cycle. The new internal Storage snapshot/restore functions retain bytes, Blob type and actual backend metadata, including generations and timestamps, using the existing base64 foundation. Hosted persistence writes an optional Storage section through the existing atomic state-file owner; restoration precedes admission and releases initialized resources on failure. Existing files may omit the section. Schema validation does not yet establish full payload integrity.

Separate review consolidates SDK mutation admission, names four touched Storage size decisions, removes an unnecessary cast, and strengthens restart verification to compare complete metadata. A default SharedWorker upload/read/delete case began green. An expanded RTDB snapshot probe exposed missing getPriority propagation; its report remains an open finding, not passing evidence.

Current source digest: `c838c7c748a5c0b70f789fa449d6b833ee9e15fe9580960c2fd8609ff8ee0268` (208 source files). Verification passes 48 selected integration scenarios, eight minimum-Node cases, five Studio cases, three rebuilt copied-standalone cases, 629 regressions in 83 isolated processes, 412 Storage/state regressions in 38 processes, strict Pyric/CLI/fixture types, 201-file code form and five fresh browser budgets. The Storage group includes the existing seven base64 tests with explicit browser fallback coverage. The complete hosted inventory collects 421 tests in 50 files. Reports use `/tmp/pyric-hosted-sdk-persistence-final-`; all Pyric, CLI, site and standalone artifacts were rebuilt. Earlier whole-browser evidence remains historical.

The first broad regression command failed binding local fixtures; the unchanged command passed with loopback access. Missing minimum-Node/Studio handles were confirmed before fresh verification, and the affected browser terminal was recovered with exit zero. No assertion was weakened.

Concurrent asynchronous Storage snapshots are not serialized. Separate controller/Storage atomic replacements do not provide an atomic multi-service commit. Reset/flush generation ownership, all bucket identities, complete state/base64 validation, checkpoint/identity restoration, recovery and other writers remain open. SDK admission currently covers Firestore writes, RTDB set/remove and Storage upload/delete; other mutations and controls still require proofs. No complete subsection or release gate is closed.

## Previous candidate: CLI partial-result persistence, 2026-09-13

The MCP candidate was independently verified before this change: 202 source files, all artifact/contract identities, 32 report hashes and four matched TDD pairs. Only the hosted runtime and existing public CLI persistence fixture change here. The CLI now flushes returned durable-mutation outcomes even when `ok` is false, reusing the MCP policy. Separate review renames that helper to `persistMutationResult` because both caller paths use it.

One S3/S1 red/green cycle exercises a sequential CLI Firestore batch whose first set succeeds and later update targets a missing document. With an unwritable state directory, red retained the missing-document error but omitted the persistence failure. Green keeps that error, reports possible memory-only changes, and exposes the first write through normal browser SDK imports. Reports/input snapshots: `/tmp/pyric-hosted-persistence-cli-partial-{red,green}`. The fixture digest is unchanged between recorded red and green. The initial red was strengthened to assert the original operation error as well, then rerun before implementation. An initial green attempt used the stale CLI build and failed; the unchanged assertion passed after rebuilding.

Two additional characterization cases began green: the partial write survives immediate SIGKILL and host restart when persistence succeeds, and a failed flush after a partial result prevents the next mutation. The three-case review passes in `/tmp/pyric-hosted-cli-partial-review.log`. It tests actual CLI processes, a temporary filesystem fault and normal browser SDK reads, without internal mocks or state-map access.

Final verification passes 40 affected SDK/CLI/MCP/persistence cases, all nine CLI persistence cases on Node 22.15, five Studio/SharedWorker cases, three rebuilt copied-standalone cases, 175 regressions in fifteen isolated processes, strict CLI/fixture types and 195-file code form. The inventory collects 413 scenarios; previous whole-suite runs remain historical. Reports use `/tmp/pyric-hosted-cli-partial-final-`. Browser bundle contributors and Pyric/site artifacts retain their verified identities; their five budget reports are explicitly reused.

The standalone build initially failed because the sandbox could not write the normal npm cache. It was rebuilt with a writable temporary cache. A standalone check against the prior executable is retained separately; only the post-build verification supports the current artifact. No dependency or lockfile changed.

This establishes one sequential CLI batch's partial-failure handling. Complete effect classification, other partial-failure paths, all-service mutation admission/durability/recovery, remaining writer ownership, lifecycle, bounded observations, live execution and the full release matrix remain required. No complete subsection or release gate is closed.

## Previous candidate: MCP persistence policy, 2026-09-13

Four S1/S2/S3 red/green cycles prove available MCP reads, refusal before later mutations, preserved Auth refusals and explicit unhealthy-memory read summaries. Existing tool-family records now declare each name's read/write effect, retaining public names, factory order, descriptions and parameters. Each cycle retains its fixture digest between red and green. Reports/input snapshots use `/tmp/pyric-hosted-persistence-mcp-` with `read`, `admission`, `refusal` and `health`, followed by `-red` or `-green`.

Returned MCP failures still flush because they may contain partial changes. If persistence also fails, the original result and data survive with a separate uncertainty notice. A partial Auth import characterization began green: it retains the created user and duplicate-user error, then reads the original user back through MCP. Review shares successful-read health reporting with the CLI, removes a touched non-null assertion, and includes the changed tool-family contract test in the strict fixture project. The production change adds no dependency.

Current verification passes 37 affected SDK/CLI/MCP/persistence cases, five MCP cases on Node 22.15, five Studio/SharedWorker cases, three copied-standalone cases and 175 regressions in fifteen isolated processes. Strict CLI/fixture types, 195-file code form and all five fresh browser budgets pass. All 410 scenarios are collected; the prior whole-browser runs remain historical. CLI and standalone artifacts were rebuilt; unchanged Pyric/site artifacts retain verified identities. Reports use `/tmp/pyric-hosted-mcp-policy-final-`.

The first verification terminal output was lost; its handles were confirmed missing before rerunning the five affected checks. Chromium launch was initially denied by the macOS sandbox. Those harness-failure reports are preserved separately; the same browser commands then passed with the required permissions and no retries. No assertion was relaxed.

Complete tool-effect classification, CLI partial-result durability, other thrown/partial failures, all SDK service admission, health/recovery, all-service restoration and every writer's ownership remain required. Shared lifecycle, bounded observations, live execution and full release gates stay open. The declarations and these selected proofs do not establish every tool's mutation behavior.

## Previous candidate: service CLI persistence policy, 2026-09-13

The preceding file-persistence candidate was revalidated against its source, contracts, ledger, toolchain, artifacts and report identities. This change touches only the hosted runtime's service-method path and a new public CLI fixture. It reuses each method's declared effect and the canonical held-identity operation. SharedWorker, browser SDK dispatch, MCP dispatch and browser bundle contributors are unchanged.

Six S3/S1 red/green cycles now prove: a committed CLI write reports its disk failure explicitly; later CLI mutations are refused before execution; reads remain available; successful reads disclose unhealthy in-memory state; a rules-refused write retains its rules error; and changing the CLI's held identity remains possible and still governs subsequent reads. A real temporary directory becomes unwritable, commands run through the actual CLI, and the browser observes shared data through normal SDK imports. Reports/input snapshots use `/tmp/pyric-hosted-persistence-cli-` with `failure`, `admission`, `read`, `health`, `refusal`, and `identity`, followed by `-red` or `-green`. Every recorded cycle retains the same fixture digest between red and green.

The runtime checks persistence health before a declared durable mutation and flushes after a successful mutation result. It leaves reads and held-identity changes available. Only successful reads receive the in-memory-state notice. Separate review clarified `changesDurableState` and assembled the reported summary before returning the result; it introduced no additional production abstraction or dependency.

Final affected verification passes all 32 selected SDK/CLI/MCP/persistence cases in 1.7 minutes, six new cases on Node 22.15, three rebuilt copied-standalone integration cases, and 80 argument/method/identity/MCP regressions in eight processes. Strict CLI/fixture types and 182-file code form pass. The full inventory collects 405 scenarios. Reports use `/tmp/pyric-hosted-cli-policy-final-`. The CLI and standalone were rebuilt; Pyric/site artifacts and browser bundle contributors retain their verified identities. The previous 399-case browser, Studio and broader regression runs remain historical rather than being represented as rerun.

Full MCP read/mutation admission, explicit health across other consumers, recovery, all-service durability and control classification, partial-failure mutation outcomes, other writer entry points, legacy/backup handling, lifecycle and live execution remain required. Existing method effects distinguish broad safety classes; these Firestore/identity proofs do not establish every service/control's durability behavior. The complete release matrix remains open.

## Previous candidate: hosted file persistence, 2026-09-13

The Node host now uses the existing atomic state-file store and sandbox record codec. File preflight runs before sandbox allocation; malformed envelopes and unsupported record versions refuse startup without replacing the file. Hosted startup identifies its state path and enables persistence by default. SharedWorker keeps its existing persistence policy. The session/checkpoint backend remains separate and memory-backed; it must not use the controller blob adapter, which ignores record namespace keys.

Nine red/green cycles cover three acknowledged writes surviving immediate process termination (browser SDK, MCP, and service CLI), two startup refusals, startup diagnostics, an SDK disk-failure outcome, refusal of the next SDK mutation with reads still available, and an MCP disk-failure outcome. Each red run failed a behavioral assertion; green retained that assertion. Reports and input snapshots use `/tmp/pyric-hosted-persistence-` with suffixes `sdk`, `mcp`, `cli`, `corrupt`, `version`, `diagnostics`, `failure`, `admission`, and `mcp-failure`, followed by `-red` or `-green`.

The filesystem-failure tests make a temporary project's state directory unwritable. The first SDK write initially returned success; the next write initially changed state despite the failure. The host now returns `committed-but-not-durable` for the first SDK persistence failure and `persistence-unhealthy` before executing subsequent Firestore SDK mutations. MCP uses the same explicit committed-state error message. These are public caller/real filesystem proofs, not tests of private persistence maps.

Separate review moved validation before allocation, clarified the default SharedWorker acknowledgment policy, and removed a suppression from the touched helper. No dependencies or lockfile changed. Final verification passes all 399 collected browser scenarios in 9.9 minutes, five SharedWorker/Studio scenarios, nine persistence/diagnostic scenarios on Node 22.15, three copied-standalone integration scenarios, 629 worker/bridge/codec regressions in 83 processes, and 66 state/session regressions in eight processes. Strict CLI/fixture types, 181-file code form, and all five browser budgets pass. The CLI and standalone artifact were rebuilt; unchanged Pyric/site artifacts retain their verified identities. Reports use `/tmp/pyric-hosted-persistence-final-`; the JSON evidence record binds these results to the current source, contracts, toolchain and artifacts.

Required follow-up remains: complete mutation admission and truthful outcomes across MCP/service CLI/all services; explicit persistence health and recovery; every writer entry point; legacy import and recovery backups; accurate restored counts; atomic interrupted commits and reset/flush generations; complete Auth/RTDB/Storage/checkpoint/identity restoration; shared boot/disposal; bounded observations and full live execution. The current SDK guard uses the existing Firestore mutation classification and does not prove all-service admission. The service CLI still returns a generic flush failure, and unconditional MCP/CLI flushes need read-versus-mutation classification. The HTTP persistence endpoint and other state writers require ownership verification. No complete subsection, feature or release gate is closed.

## Previous candidate: stdio MCP uncertainty, 2026-09-13

The preceding discovery candidate was revalidated against its source, contracts, lockfile, toolchain, artifacts and report hashes before this change. Only `cli/mcp-proxy.ts` and `mcp-stdio.pw.ts` changed in the implementation/test scope.

Two real CLI/HTTP fault tests use a non-idempotent `firestore_add_document` call. The fault proxy forwards the request, consumes the host response, then closes the client connection or leaves the response pending through the actual 35-second proxy deadline. A fresh browser reads exactly one resulting document using normal Firebase-shaped imports. Both red runs reached that assertion successfully, then failed because the caller received retry advice instead of uncertainty. Prefixes `/tmp/pyric-hosted-stdio-lost-ack-` and `/tmp/pyric-hosted-stdio-deadline-` retain the exact command, red/green source/artifact identity, unchanged fixture digest and assertion-failure transcripts.

Both unchanged green assertions pass. The errors now say the request outcome is unknown, a write may have committed, and host state should be checked before another write. Separate review shares the message constant and corrects fixture indentation without changing replay or timeout behavior. All eight current stdio cases pass in 52.8 seconds, including both failure paths and the previous discovery cases. Twenty-seven selector/address regressions and strict CLI/fixture types pass. The code-form report checks 178 TypeScript files with zero issues.

The CLI and standalone binary were rebuilt. All three existing copied-standalone scenarios pass against that artifact in 13.0 seconds. These check packaged ownership, browser integration and stdio discovery; they do not independently repeat the two fault scenarios inside the compiled executable. Unchanged Pyric/site artifacts and browser-bundle inputs retain verified prior identities. No dependency or lockfile changed.

Reports use `/tmp/pyric-hosted-stdio-uncertainty-final-`. The full fixture inventory collects 391 scenarios; only the eight affected MCP cases were executed in this continuation. The preceding 389-case browser run, Studio/broad-regression runs and minimum-Node matrix remain historical. No fresh whole-suite or release pass is claimed.

The HTTP-failure message conservatively reports uncertainty; complete distinctions between unsent work, definitive host refusal and uncertain execution remain required. Late-response behavior, bounded pending/settled records, complete shutdown, full admission, authoritative persistence, bounded observations and complete browser/hosted live execution remain open. This slice does not close a full subsection or release gate.

## Previous candidate: stdio MCP discovery, 2026-09-13

Two matched red/green records cover copied-pointer refusal and host replacement after discovery but before MCP initialization. Six stdio scenarios pass through the actual CLI/MCP interface, including browser sharing and legitimate directory aliases. The detailed cycle record appears below.

Final checks pass all 389 collected hosted-fixture browser scenarios, five SharedWorker/Studio scenarios, 629 worker/bridge/persistence/operator regressions in 83 processes and 27 selector/address regressions in three processes. Six stdio cases pass on Node 22.15.0. Three copied-standalone cases pass, including stdio writes visible through the browser SDK and wrong-project refusal. Strict production/public-fixture types, 178-file code form and all five browser budgets pass. Reports use `/tmp/pyric-hosted-stdio-final-`.

The CLI and standalone binary were rebuilt. Unchanged Pyric and Studio/site artifacts match their prior digests; embedded Studio matches the site artifact. The JSON ledger binds source, test, contract, lockfile, toolchain, artifact and report identities. Fresh origin/main `548e50a7` is contained by HEAD `a99a06a5`. The full implementation and release gates remain open; discovery context headers do not authenticate clients or establish older-host compatibility.

## Previous candidate: hosted CLI ownership, 2026-09-13

Three matched red/green records cover second-process refusal, Bun compatibility and simultaneous-start admission. The initial process test expected exit 1; review corrected that fixture to the existing startup-failure contract, exit 2, restored the exact pre-ownership serve source and recorded a fresh valid red. The implementation did not change CLI exit codes. The Bun red is an actual product-process abort from the native addon's unsupported libuv call, observed by a healthy CLI test harness.

The final owner uses the SQLite implementation built into Node or Bun, preserving the package manifest and lockfile with no added dependency. One non-blocking write reservation guards the canonical state's `host.lock` before configuration/state loading. Closing it or terminating the process releases ownership without deleting the file. Review exposed an exclusive-lock upgrade race in which both starters refused; `BEGIN IMMEDIATE` fixes the unchanged assertion. Twenty deliberate repetitions pass with no retries.

Nine real CLI scenarios cover contention, Node/Bun ownership in both directions, normal and forced termination, project/state-directory aliases, simultaneous starts and corrected startup failure. They pass on Node 22.18.0 and the advertised minimum Node 22.15.0, with Bun 1.3.9. The Node 22.15.0 archive was verified against the official checksum manifest. Two further scenarios copy the compiled macOS arm64 executable outside the workspace: it refuses a Node-owned project, owns a project that refuses Node, and serves a normal SDK read of MCP-written data.

Final checks: 383 collected/executed/passed hosted-fixture browser cases; five SharedWorker/Studio browser cases; 629 regressions in 83 isolated processes; 44 additional CLI lifecycle regressions in six processes; strict Pyric/CLI/public fixture types; 174-file code form; and all five browser bundle budgets. The CLI and standalone artifact were rebuilt. Pyric and Studio/site are reused only after verifying identical artifact digests. Reports use `/tmp/pyric-hosted-owner-final-`; TDD reports use `/tmp/pyric-hosted-owner-{process,bun,race}-{red,green}.log`. The JSON ledger binds source, tests, contracts, lockfile, runtime versions, artifacts and reports. Fresh origin/main `548e50a7` remains contained by HEAD `a99a06a5`.

This is partial 4A/4D evidence on macOS arm64. Other writer entry points, in-process ownership, interrupted initialization and complete resource teardown remain required. Hosted application state is still memory-only. Authoritative all-service persistence and acknowledgments, bounded observations, complete browser/hosted live execution, other operating systems and the full packaging/release matrix remain open. No full subsection or release gate is closed.

## Previous candidate: hosted MCP and service CLI, 2026-09-13

Three recorded red/green pairs establish hosted MCP reads, service CLI attachment, and wrong-project CLI refusal. The copied-pointer red actually returned a successful write into the other project; the unchanged green assertion now requires refusal and verifies the target document is absent. Eight reviewed CLI/MCP browser cases cover reads, seeding before browsers connect, shared data, retained CLI lens/rules refusal, project subdirectories and the existing default SharedWorker refusal. Four existing remote-consumer cases also remain green.

Final evidence: 374 collected/executed/passed browser scenarios, five SharedWorker/Studio scenarios, and 629 regressions across 83 isolated processes. Strict production and public-fixture types, 169-file code form and all five browser bundle budgets pass. The CLI was rebuilt. Pyric and the embedded 134-page Studio/site artifacts are reused only after matching their previous digests. Reports use `/tmp/pyric-cli-mcp-final-`; the JSON ledger binds current source, contracts, lockfile, toolchain, artifacts and the three historical red/green pairs. A fresh fetch confirms origin/main `548e50a7` is contained by HEAD `a99a06a5`.

The Node runtime reuses the existing sandbox dispatcher for MCP and validated method records for CLI commands. The CLI control request is pinned to the bridge instance and carries its canonical project directory. It never opens local persistence after selecting a running host. The CLI method context and flat MCP bridge caller identity remain distinct; complete identity/control parity and auditing still need review.

This remains partial evidence. Hosted state is memory-only. Authoritative persistence, writer exclusivity, complete service/tenant/admission/lifetime parity, bounded queues and observations, atomic all-service replacement, complete live execution and packaging/release gates remain required. No full implementation or release gate is closed.

## Baseline, 2026-09-12

- Source: `c3555ac53605ea0b8a7cb6b8dd0f1cd5f181580b`, before production edits.
- Toolchain: Bun 1.3.9; locked installation completed, 3,063 packages installed.
- Lockfile SHA-256: `8383b36dd4657036b271c2f14b63158ecfba5f96a9c23ab747179d7d88dc75c5`.
- `bash scripts/build.sh --packages-only`: exit 0.
- Combined worker/bridge/codec baseline: 533 passed, one beforeAll failure. The served composite-query fixture attempted a different Firebase configuration after the preceding RTDB fixture deleted its last app. The process-wide registry retained that earlier configuration. This is a baseline test-realm collision, not a missing dependency or a hosted regression.
- The same 72 files each executed in a separate `bun test <file>` process: all 72 processes exited 0. This includes every worker test file, worker-relay, remote-session-isolation, remote-session-stress, and the value-codec file. File isolation respects the served entry's once-per-realm transport selection; no assertions or scenarios were removed.
- Full local transcripts: `/tmp/pyric-hosted-baseline-build.log`, `/tmp/pyric-hosted-baseline-tests.log`, `/tmp/pyric-hosted-baseline-isolated.log`.

## H0 → H1: another browser observes a normal SDK write

Seam: S1. One CLI process, two isolated Chromium contexts, normal `firebase/app`, `firebase/auth`, and `firebase/firestore` imports. Both apps sign in, establish a document listener, and observe an empty document. The first app writes a literal greeting. Its own result succeeds; the second app must observe that exact greeting.

Command, from the workspace root:

```sh
bun x playwright test --config packages/cli/test/e2e/hosted/playwright.config.ts
```

Test SHA-256: `6b27a8122a13f2d5a3518dcf8bb020d3d95d86e4342310bfbabbdd714864cef0`.
App fixture SHA-256: `3e646c39cd1b97fb13e3844270deb85e93dd0a49c3145b12cb9e09f83ee1e0fc`.
HTML fixture SHA-256: `6c71a0b782d49ddec1e04166eab1cc6430c22047cd9f297cf7e42c82bb12d4bc`.

Red: pre-implementation source `c3555ac5`, one test executed, exit 1. At test line 26 the observer expected `Hello from the other browser` but remained `Empty`; the preceding initial-state and writer-success assertions passed. `/tmp/pyric-hosted-h0-red.log` retains the trace. The earlier sandbox-denied Chromium launch is setup evidence only and is excluded from this red result.

Green: the unchanged test and app fixtures passed, one test, zero retries, exit 0, 2.7 seconds overall. `bun x tsc -p packages/cli/tsconfig.json --pretty false` passed before the run. The test launches the built CLI and builds fresh browser bundles with `--no-cache`. `/tmp/pyric-hosted-h1-green.log` retains the result. This result needs revalidation after review-stage edits.

The minimal implementation selects a Node-owned sandbox from init, adapts browser ports over the existing bridge attach protocol, and gives admitted ports independent ordered queues. Full-port envelopes also carry app configuration, clock traffic, events, and teardown; existing remote operation frames remain unchanged. The Node mount refuses browser peer replacement.

The proof uses ephemeral Node storage and disables capture. It does not establish durability, remote/MCP parity, fault recovery, complete validation, bounded event retention, or live execution. Those remain required implementation work, not unsupported-product exemptions.

## Review-stage verification

The reviewed browser test passed unchanged: one scenario, zero retries, 3.1 seconds overall. All 503 worker regression tests passed across 68 independently executed test files. CLI production compilation, the dedicated hosted browser fixture typecheck, and the code-form checker/fixture typecheck passed. The earlier bridge run passed 1,301 tests in 97 files; it precedes the final condition-only review edits and must not be represented as fresh evidence for that later source.

`hosted-sandbox-live-mode-evidence.json` records the changed-source hashes, base revision, lockfile/toolchain identity, and compiled CLI/Pyric JavaScript tree digests for that historical verification. Its source digest is `cfc6d8c471afb91140fe2f789f4fb4615ba17784b258eaae9a27f23cdd354a8b`; subsequent startup and live-entry edits invalidate it as current-source evidence. Required gates remain unchecked: these observations do not replace full gate evaluation.

## Code-form checker: S6

`scripts/check-code-form.ts` exposes `checkCodeForm(source)` as the checker interface. Four sequential red/green cycles established named if decisions; the same requirement for loops, ternaries and JSX; refusal of nested choices, conditional spreads and logical side effects; and refusal of explicit any, double assertions, non-null assertions and suppression comments. All four tests currently pass. The local red/green transcripts use `/tmp/pyric-code-form-{named,branches,hidden,types}-{red,green}.log`.

That initial checker passed the three new production modules and its own source. It did not yet refuse parse errors or account for modified-function scope. Later cycles below address those gaps. It still does not prove that an identifier has a boolean type or that its name explains intent, and is not yet a required CI gate.

## Hosted startup failure: S1, partial 0C

The served HTML now declares Node ownership before asynchronous init. Returning HTTP 503 for `/__pyric/init.json` must produce `Hosted sandbox initialization failed: /__pyric/init.json → 503`, leave the fixture's write button disabled, and request no local worker script. Before implementation the expected error was absent. The unchanged assertion passed after adding the ownership marker and explicit init failure.

Transcripts: `/tmp/pyric-hosted-startup-red.log`, `/tmp/pyric-hosted-startup-green.log`, `/tmp/pyric-hosted-startup-review.log`. The green run executed both hosted scenarios, two passed, zero retries. The HTML injection options refactor was separately checked against its six existing tests before adding this behaviour. Slow/hung init, conflicting payloads, and wrong-project discovery remain open.

## Live served entry: S4/S5, partial 0D

One disposable `demo-pyric-live-*` project runs the real Firebase Auth and Firestore emulators. A seeded document permits reads only to its owner. The app uses normal Firebase imports, signs in through the Auth emulator, and reads that document. Browser HTTP traffic is restricted to the fixture origin and the two emulator origins. The proof checks App/Auth/Firestore ownership and the real snapshot class, then checks one event through the existing capture endpoint, including the issuing UID, server source, pending-write metadata, and explicit absence of local rules evaluation.

The final pre-implementation run failed with `Failed: connectFirestoreEmulator is not a function`: `--live` still selected the sandbox entry. This is recorded in `/tmp/pyric-live-ownership-red.log`, with source, fixture, lockfile, and compiled-artifact hashes in `/tmp/pyric-live-ownership-red-inputs.json`. An earlier static-import failure and diagnostic runs are not substituted for this recorded red.

The same assertion passed after selecting dedicated live entries and resolving their Firebase imports from the consuming project: one test, zero retries, 8.2 seconds, `/tmp/pyric-live-ownership-green.log`. A review-stage extraction of shared test setup/assertions passed again in 8.8 seconds, `/tmp/pyric-live-ownership-reviewed.log`. Production Pyric/CLI compilation and the dedicated live fixture/type-contract project passed. The affected bundler, HTML, Vite swap, and source-form suites passed 39 tests; operation/provenance regressions passed 15. Transcripts: `/tmp/pyric-live-entry-regressions.log` and `/tmp/pyric-live-event-regressions.log`.

The adapter returns the SDK snapshot and does not call `data()` while recording. Captures omit database state and deployed rules because this read has not established either. `external-execution` is an additive rules-disposition reason, carried by the existing event/capture shape. This proof does not establish the full live operation surface, rejected reads, bounded or ordered capture delivery, recording loss diagnostics, app deletion, HMR, or hosted credentials. Those remain required work.

Local backend prerequisites: Firebase CLI 15.23.0, Temurin JRE 21.0.12.1, and Firestore emulator 1.21.0. The JRE archive SHA-256 was verified as `dec50fc6f9fcd4fe3ae8cabf5a5fa68f6afc48841f7698e468e9aa5d54beed84`; the Firestore archive as `c3d3680a89d946a90a027365ea14c26c6472a162bcf37f099bbb1ebd66d25e8e`. These are local `/tmp` prerequisites, not yet a reproducible CI installation gate. No production Firebase service was used.

## Live Vite entry: S4/S5, remaining early 0D path

The same application and assertion now run through a real Vite server with `pyric({ live: true })`. An initial harness failure came from macOS's `/var` versus `/private/var` temporary-directory aliases: Vite refused the resolved source path and served the raw JavaScript. Canonicalising the fixture directory fixed setup. That failure is excluded from TDD red evidence.

The corrected pre-implementation test reached the app and failed with `Failed: connectFirestoreEmulator is not a function`, proving that Vite still selected the sandbox entry. `/tmp/pyric-live-vite-red.log` and `/tmp/pyric-live-vite-red-inputs.json` retain that observation and input hashes. Live entry selection and a narrowly scoped real-SDK bypass in both Vite resolution and the dependency optimiser made the unchanged read/capture assertion pass. Only the exact owned live entry files bypass interception, and real SDK resolution starts from the consuming project.

Review removed the Vite configuration's existing broad double assertion by typing its optimiser plugin from Vite's actual configuration contract. Newly touched decisions use local names. Both live tests passed after review: two tests, zero retries, 17.0 seconds, `/tmp/pyric-live-entries-reviewed.log`. Both hosted browser tests passed against the same compiled CLI: two tests, zero retries, 4.6 seconds, `/tmp/pyric-hosted-entries-reviewed.log`. Strict production and live adapter/fixture compilation passed. The source-form checker reports no issues in the new live implementation and TypeScript fixture files; this does not establish the still-unfinished modified-function scope and architecture gates.

The broader existing Vite/bundler/HTML/checker run passed 125 tests and skipped eight reported entries (including gated suite hooks). Those skips were investigated, not accepted as completed verification. Building the Astro site produced 133 pages successfully. With assets available, the Vite generation file passed all 27 tests, including the previously skipped Studio scenarios. Enabling `PYRIC_BRIDGE_E2E=1` separately executed all three real bridge integration tests successfully. See `/tmp/pyric-live-reviewed-regressions.log`, `/tmp/pyric-live-site-prerequisite.log`, `/tmp/pyric-live-studio-regressions.log`, and `/tmp/pyric-live-bridge-e2e.log`.

The evidence JSON retains the earlier snapshot and records this verification separately. These are two early execution proofs, not completion of the 0D universal gates or the full supported live feature set. Warm optimisation, HMR, packed installs, lifecycle/resource accounting, complete observation delivery, and the supported-operation matrix still require their declared tests.

## Hosted startup deadline and project binding: S1, further 0C evidence

The previous implementation turn added three red/green cycles and one characterization:

- A stalled init request produces a specific error at 5,000 ms of controlled browser time, never opens a local worker, and leaves app actions unavailable. The test checks the 4,999 ms boundary before advancing the final millisecond. Red: `/tmp/pyric-hosted-timeout-red.log`; initial three-scenario green: `/tmp/pyric-hosted-timeout-green.log`.
- A delayed successful init lets a second browser observe a write made while it waited. Advancing past the cancelled deadline produces no late error. This was already-supported behavior and is recorded as characterization, not a fabricated red. Reviewed four-scenario result: `/tmp/pyric-hosted-timeout-reviewed.log`.
- A hosted page rejects an init payload selecting a local sandbox. Red: `/tmp/pyric-hosted-mode-red.log`; five-scenario green: `/tmp/pyric-hosted-mode-green.log`.
- An init payload retaining the expected project but pointing to a different project's socket is rejected before queued SDK operations are sent. Before the fix, the misdirected app read `Hello from the other browser` from that other host. Red: `/tmp/pyric-hosted-project-red.log`; six-scenario green: `/tmp/pyric-hosted-project-green.log`.

The latest cycle replaced the **entire** init response, including its project identity. The previous socket check accepted that internally consistent foreign payload and the app read the other project's greeting. `/tmp/pyric-hosted-foreign-init-red.log` records the missing error and actual misdirected read; `/tmp/pyric-hosted-foreign-init-red-inputs.json` records the pre-implementation inputs. Hosted HTML now carries the expected project key, escaped as an HTML attribute. Init must match that declaration before transport selection. The original assertion passed in the seven-scenario run `/tmp/pyric-hosted-foreign-init-green.log`.

These checks establish misrouting refusal, not client authentication or canonical filesystem/process ownership. The full admission, discovery, reconnection, and authority contracts remain required. The timeout currently covers the awaited response body too, but a stalled partial response body has not yet been tested separately.

One bridge regression run encountered a pre-existing process occupying its hard-coded port 5197. The fixture now requests an OS-assigned port through the existing server API; no assertion changed and the unrelated process was left alone. This setup failure is excluded from TDD red evidence. The subsequent full bridge run passed 1,301 tests.

## Code-form scope and parser corrections: S6

Five additional behavior cycles established syntax-error refusal, filename-sensitive TypeScript/TSX parsing, explicit unchanged-statement exclusions, declaration-file checking without JavaScript emission, and correct distinction between template contents and real suppression comments. Each has a relevant red and green transcript at `/tmp/pyric-code-form-{syntax,language,scope,declarations,template}-{red,green}.log` and corresponding pre-implementation input hashes. The declaration-file red explicitly asserts that checking a valid declaration must not throw; it exposed an error in the checker, not an unavailable test dependency.

Review characterization confirms that a modified function is checked in full, new files receive no legacy exclusion, additions on an unchanged statement's line remain checked, and a new suppression before an unchanged declaration is still refused. All twelve checker tests pass. Strict typechecking caught an optional-property narrowing mistake during development; binding the value to a local constant fixed it without an assertion or suppression.

`bun scripts/check-changed-code-form.ts c3555ac53605ea0b8a7cb6b8dd0f1cd5f181580b` now emits a JSON report with the resolved base, per-file current/base hashes, findings, and explicit unchanged top-level statement ranges. The wrapper wires the tested callable checker to Git and the filesystem; its collection/exit behavior still needs dedicated adversarial verification before required CI use. No blanket allowlist was introduced. Modified statements are checked in full, which includes the entire body of each modified top-level function.

The current report inspects 46 files and exits 1 with 182 findings across bridge/server/bridge, bridge/server/peer, cli/serve, bridge-mount, worker-runtime, and sandbox-session. All new TypeScript files pass the source-form check. Five smaller existing modules were reviewed to name remaining touched decisions and remove unnecessary assertions. That review preserved behavior; separate regression checks below verify it. U3 remains unmet.

## Project-binding verification

- Hosted browser suite: seven scenarios passed, zero retries, 14.6 seconds. `/tmp/pyric-project-reviewed-hosted.log`.
- Real SDK served/Vite proofs: two scenarios passed against isolated Auth/Firestore emulators, zero retries, 17.6 seconds. `/tmp/pyric-project-reviewed-live.log`.
- Vite/bundler/HTML/checker regressions with real bridge scenarios enabled: 139 passed across 19 files, zero skipped. `/tmp/pyric-project-reviewed-vite.log`.
- Full bridge regressions: 1,301 passed across 97 files. The final source-bound run is `/tmp/pyric-project-final-bridge.log`.
- Existing worker/bridge/value-codec baseline in 72 separate processes: 539 passed, zero skipped. The final source-bound run is `/tmp/pyric-project-final-baseline.log`. The combined-process baseline command remains unsuitable because of its documented global-state collision.
- CLI production compilation, hosted/live fixture typechecks, and strict checker/command typechecks passed. Site prerequisites rebuilt successfully, 133 pages. Browser scenario collection separately enumerated all seven hosted and both live scenarios.

The evidence JSON preserves earlier snapshots and red inputs, and binds these final observations to the current changed-source and artifact hashes. No universal, subsection, or release gate is marked complete. Individual served browser response hashes and deterministic resource accounting remain missing.

## Bridge and session review; hosted diagnostics

The preceding goal turn made concrete progress: it added project-bound initialization and a scoped source-form report. This continuation rechecked the worktree and used that report to review the current peer, bridge core, bridge mount, and sandbox session.

The review names local decisions, removes redundant message casts, constructs optional acknowledgement/error fields explicitly, and captures stable values where TypeScript narrowing requires them. Tool-result handling retains its short-circuit and missing-result behavior. MCP session construction now starts with the actual transport rather than a null placeholder double-cast to the transport type. Upgrade callbacks and the server's `listening` property no longer use broad assertions. These are review-stage changes, not new red/green behavior claims. The state-fixture double assertion remains visible: it still needs a justified decoding/validation boundary.

The scoped command now reports 80 findings in 47 TypeScript files: 70 in CLI startup, nine in worker selection, and one seed-fixture assertion. Peer routing, bridge core, and bridge mount have zero scoped findings. The full report with current-source hashes and explicit legacy exclusions is `/tmp/pyric-bridge-review-code-form.json`. U3 remains unmet; no exclusions or rules were weakened.

At S3, a new test starts the real CLI with `--hosted` and reads its stderr. The red run showed both the browser-resident warning and the browser IndexedDB storage claim, despite Node execution. The test now waits for the target message on stderr independently of stdout readiness, avoiding assumptions about delivery order between the two pipes. The final red and its inputs are `/tmp/pyric-hosted-diagnostics-red.log` and `/tmp/pyric-hosted-diagnostics-red-inputs.json`.

The minimal implementation labels deployed Firestore rules as belonging to the Node sandbox, identifies Node execution, and reports memory-only storage for this unpersisted hosted configuration. The unchanged final assertions passed with the seven existing hosted scenarios: eight passed, zero retries, 14.1 seconds, `/tmp/pyric-hosted-diagnostics-green.log`. This does not establish hosted `--persist` behavior, whose backend, acknowledgment, restart tests, and diagnostics still require the persistence section.

Verification after review:

- Strict CLI production and hosted/live fixture typechecks passed.
- The combined bridge, mount, session, persistence, Vite, bundler, HTML, and checker run passed 1,479 tests in 120 files, zero skips: `/tmp/pyric-bridge-review-final-regressions.log`.
- Both actual live entry paths passed against the isolated Auth/Firestore emulators, zero retries, 17.2 seconds: `/tmp/pyric-bridge-review-final-live.log`.
- All 72 baseline files passed in separate processes: 539 tests, zero skips, `/tmp/pyric-bridge-review-final-baseline.log`.

An earlier session/persistence run failed six tests while attempting to bind OS-assigned port 0 inside the restricted execution environment. The same 29 scenarios passed once local listener access was enabled, without changing assertions or server-port code. `/tmp/pyric-session-reviewed.log` preserves the setup failure; `/tmp/pyric-session-reviewed-authorized.log` preserves the explained rerun. These failures are not TDD red evidence or unexplained flaky passes. The final combined suite also executed those scenarios successfully.

Earlier snapshots and red inputs remain historical evidence. The latest JSON snapshot binds the final observations to the changed source and built artifacts; no section or release gate is marked complete.

## CLI review and executable baseline

The preceding turn supplied the requested goal prompt and made no implementation changes. This continuation inspected the current worktree and source-form report before resuming implementation.

CLI startup now uses named decisions for configuration overrides, bridge routing, watchers, diagnostics, flags, and process shutdown. Optional fields are assembled before calling the session/server boundaries. Stable local values preserve TypeScript narrowing without non-null assertions; active child handles are still selected at their original lifecycle points. Promise resolvers use the supported runtime's `Promise.withResolvers`. Five repeated error-message conversions share one private formatter. This was a separate review-stage refactor, not a new product-behavior red/green claim.

Before review, 92 existing CLI/startup tests passed with local cache and listener access. The first restricted run had 61 passes and 31 failures caused by cache-directory permissions and failed listener binding; `/tmp/pyric-cli-review-before.log` and `/tmp/pyric-cli-review-before-authorized.log` retain the explanation and unchanged passing rerun. These are setup failures, not TDD red evidence.

At S6, `scripts/test-isolated.ts` now runs explicitly supplied test files in separate Bun processes. It does not introduce another test framework or infer which scenarios a feature requires. Three sequential red/green cycles established:

- Fresh process globals: with the former combined invocation, the second fixture observed state left by the first and failed its assertion. Running one process per file made the same assertions pass. `/tmp/pyric-isolated-runner-red.log`, `/tmp/pyric-isolated-runner-green.log`.
- Empty input refuses with usage and exit 1. Before the guard, the empty loop returned success. `/tmp/pyric-isolated-empty-red.log`, `/tmp/pyric-isolated-empty-green.log`.
- A skipped required test refuses with exit 1 even when Bun reports a successful process. `/tmp/pyric-isolated-skip-red.log`, `/tmp/pyric-isolated-skip-green.log`.

Each red transcript has a matching `-red-inputs.json` snapshot. Two additional characterization tests verify stopping after a failed file and refusing todo scenarios. These began green and are not claimed as new red/green cycles. All five runner tests and the twelve source-form tests pass; strict tool typechecking also passes. Tests are invoked from the repository root, as declared by the gate commands.

The exact B0 replacement command in GATES.md built all package prerequisites, then passed 539 tests in 72 separate processes, with no failures, skips, or todos. Its test output is `/tmp/pyric-cli-review-baseline.log`; build success is retained in the execution output. The selected file inventory and required counts remain explicit in the gate. This repairs the runnable baseline command; scenario-manifest coverage and the full completion verifier remain open.

The source-form report now inspects 49 TypeScript files and reports 10 findings: nine in worker selection and one seed-fixture double assertion. CLI startup has zero scoped findings. The checker scope and exclusions were not weakened. U3 still needs the remaining fixes, command collection verification, and required CI integration. Zero scoped findings does not establish good architectural ownership or name quality.

The package-only build clears generated site assets. The Studio site was rebuilt successfully (133 pages) and copied into the CLI artifact before final verification. Final source/artifact-bound observations are in the accompanying evidence JSON; earlier reports remain historical. Hosted persistence, connection recovery, observation completeness, credentials, and the other full-plan outcomes remain unfinished.

## State-file validation, worker review, and SDK token access

The preceding goal turn was progress: it completed the runnable baseline and reduced scoped source-form findings to ten. This turn inspected those findings and followed the approved S1/S3/S5 seams.

Two real CLI scenarios demonstrated missing fixture validation. A version-1 fixture with `auth.users` set to an object reached readiness rather than refusing. A version-99 state fixture also reached readiness because it was classified as a plain document seed. Their red transcripts and source/artifact input snapshots are `/tmp/pyric-seed-users-array-red.log`, `/tmp/pyric-seed-users-array-red-inputs.json`, `/tmp/pyric-seed-version-red.log`, and `/tmp/pyric-seed-version-red-inputs.json`. Each unchanged assertion passed after its minimal implementation; the green transcripts use the corresponding `-green.log` names.

`state-file.ts` now owns the parsed envelope, version errors, and exported account-field schema. Seed fixtures and restored state call the same decoder. It uses the already-installed Zod dependency and preserves extra fields and the opaque Firestore controller payload. The field inventory is checked against the existing exported user type, and the decoded result is assignable without a broad assertion. This validates record shape; it does not claim new auth semantics or a complete Firestore-value codec. Existing section-write acceptance remains unchanged: validating incoming persistence writes before committing them is still part of the persistence/wire work.

A separate review removed the worker runtime's nullable assertions and nested warning conditions. Version inspection requires an actual local control port. Retirement reads and validates its target at request time. The replacement coordinator's unused target option is now optional and deprecated for compatibility; reload listener registration remains active even when the page has no served epoch. Existing app/Studio generation-sharing and replacement tests passed before and after review. The state store now distinguishes raw section values being serialized from validated records returned by its loader, without asserting unknown input into a validated type.

The intended positive account characterization exposed another missing product behavior: normal `firebase/auth` imports did not export `getIdTokenResult`, although the worker and in-page implementations both provided it. The browser reported the missing export and never loaded the application module. `/tmp/pyric-seed-sdk-token-red.log` records that actual module error alongside the failed identity assertion, and `/tmp/pyric-seed-sdk-token-red-inputs.json` records its inputs. This was an absent product export, not a missing test dependency. Exporting the existing user-method delegation made the same profile/tenant/claims/rules assertion pass: `/tmp/pyric-seed-sdk-token-green.log`.

Review extracted the shared browser assertion and added SharedWorker and in-page regressions. Each uses normal application SDK imports, checks the selected mode through the declared runtime status interface, signs in with the seeded tenant account, reads profile/token claims, and writes/reads a document guarded by UID, role, and tenant rules. These two additional runtime cases began green; they are regression coverage, not fabricated red cycles.

Final verification:

- Thirteen scenarios in the hosted fixture suite passed, including the original eight, two fixture refusals, and the three identity runtime paths: `/tmp/pyric-seed-final-hosted.log`.
- Five existing SharedWorker/Studio browser scenarios passed after review: `/tmp/pyric-worker-review-after.log`.
- Both real SDK live entry proofs passed against isolated emulators: `/tmp/pyric-seed-final-live.log`.
- Seventy-nine state, namespace, promotion, SDK-entry, CLI, and runtime regressions passed: `/tmp/pyric-seed-final-regressions.log`.
- The 72-process baseline passed 539 tests with no skips or todos: `/tmp/pyric-seed-final-baseline.log`.
- CLI, Studio, hosted/live fixture, and verification-tool typechecks passed. The twelve source-form and five isolated-runner tests passed.
- The scoped source-form command inspected 54 TypeScript files with zero findings: `/tmp/pyric-seed-worker-code-form.json`. Its scope and exclusions were not weakened.

The evidence JSON preserves prior snapshots and records the final source, tests, configuration, lockfile, and artifact identities. The U3 command result is now clean, but U3's command collection verification and mandatory CI enforcement remain open. No feature section or release gate set is complete. Boot-failure disposal, canonical authority, full seed/durable service restoration, incoming persistence-write validation, connection recovery, observation limits, and real hosted credentials still require their planned work.

## Required code-form CI and lost hosted acknowledgments

The preceding turn supplied the requested goal prompt but changed no implementation state. This continuation resumed at S6, then addressed a demonstrated S1/S2 connection failure.

Four command-level characterization cases exercise a temporary real Git repository: staged/unstaged/untracked TypeScript, spaces and newlines in filenames, `.ts`/`.tsx`/`.mts`/`.cts`/declaration files, ignored/deleted files, source/base digests, legacy exclusions, malformed source, violations, and missing or unresolved baselines. These behaviors began green. A hand-counted diagnostic column in the test was corrected from 23 to 24; that fixture mistake is not product red evidence.

The fifth S6 case initially failed because the required build job had no code-form command. Its red transcript and input identities are `/tmp/pyric-code-form-ci-red.log` and `/tmp/pyric-code-form-ci-red-inputs.json`. The required `build-packages` job now runs tool tests, a strict tool typecheck, and the changed-source checker, preserving its report as an artifact. PRs compare the actual merge candidate to its target commit, pushes compare the pushed range, and scheduled/manual runs compare the latest commit to its parent. The unchanged test executes the workflow's actual command against clean and violating source and verifies both exit status and report. `/tmp/pyric-code-form-ci-green.log` records green; the reviewed six-file tool/CI suite passes 45 tests in `/tmp/pyric-code-form-ci-reviewed.log`. The review corrected root-tool path resolution for the existing NodeNext typecheck. This is local verification of required workflow wiring, not a claim that GitHub Actions ran.

The conventions now state the named-decision rule for new and modified TypeScript; unchanged top-level statements remain explicit exclusions. The checker still validates identifier syntax rather than boolean types. That limitation keeps U3 open and is not waived by the passing report.

The real browser fault scenario increments a document, drops that request's reply after the host produces it, and closes its socket. Before the fix, the caller remained `Pending`; `/tmp/pyric-hosted-lost-ack-red.log` and `/tmp/pyric-hosted-lost-ack-red-inputs.json` preserve that failure. The connection now asks the existing request-correlation owner to reject all outstanding calls with `unavailable`, explaining that already-sent requests may have completed. The same SDK assertion passes, and a second isolated browser reads a count of exactly one. `/tmp/pyric-hosted-lost-ack-green.log` records the first green. A separate review reused that pending-request cleanup for app deletion while preserving deletion's existing error and listener behavior.

Final verification for this slice:

- All 14 collected hosted browser scenarios pass without retries: `/tmp/pyric-hosted-lost-ack-suite.log`.
- All five existing SharedWorker/Studio browser scenarios pass: `/tmp/pyric-hosted-lost-ack-worker-browser.log`.
- The same 72 baseline processes pass 539 tests with no failures, skips, or todos: `/tmp/pyric-hosted-lost-ack-baseline.log`.
- All 45 verification-tool and CI-policy scenarios pass; CLI, hosted-fixture, and tool typechecks pass.
- The scoped code-form command inspects 57 TypeScript files with zero findings: `/tmp/pyric-hosted-lost-ack-code-form.json`.

Earlier live-emulator and broader state/CLI results remain historical; they were not rerun for this request-cleanup change. The evidence JSON records the current source/workflow/contracts and built artifacts, preserving earlier snapshots. This slice does not complete connection recovery: calls issued after closure, retained subscriptions, reconnect/admission, and interrupted host boot still need their planned contracts and tests.

## Closed-connection cleanup and boolean decision types

The previous turn made progress on lost acknowledgments and required CI wiring. This continuation added two S1/S2 behaviors and completed the scoped U3 check.

A normal `getDoc` issued after the hosted socket closed rejected with an error lacking an SDK code. The browser assertion failed with `undefined: The hosted sandbox connection is closed.` instead of `unavailable`. `/tmp/pyric-hosted-after-close-red.log` and `/tmp/pyric-hosted-after-close-red-inputs.json` preserve the red observation. Returning the existing `FirebaseError` shape passed the unchanged assertion and confirmed that `getApp()` still returns the original app. Review also removes a pending correlation when `postMessage` throws, preserving the same rejection while releasing the request entry. `/tmp/pyric-hosted-after-close-green.log` and `/tmp/pyric-hosted-after-close-reviewed.log` record green and review verification.

The second browser test showed that an SDK unsubscribe callback threw after the host disappeared, preventing the app's cleanup handler from completing. `/tmp/pyric-hosted-unsubscribe-red.log` and its `-red-inputs.json` record this failure. The correlation owner now completes local cancellation even when it cannot send the remote unsubscribe frame. The unchanged assertion passes for repeated unsubscribe calls without page errors: `/tmp/pyric-hosted-unsubscribe-green.log`. This establishes local cleanup; it does not implement subscription restoration or remote cleanup acknowledgment.

At S6, the changed-code CLI accepted `if (count)` where `count` was numeric. The actual exit-status assertion failed in `/tmp/pyric-code-form-boolean-red.log`; its `-red-inputs.json` records the inputs. The CLI now supplies one strict TypeScript program to the source checker, which verifies named decision types using the compiler's actual type information. `/tmp/pyric-code-form-boolean-green.log` records the unchanged assertion passing. Further characterization verifies imported booleans, numeric changes in imported modules, unresolved imports, nullable/unknown/implicit-any decisions, constrained generics, and control-flow narrowing. These additional cases began green; they are not fabricated TDD cycles.

The typed check requires workspace declaration artifacts. A workflow-order assertion first failed because the check preceded the package build, then passed after it was moved after `Build packages (site omitted)`. `/tmp/pyric-code-form-build-order-red.log`, its `-red-inputs.json`, and `-green.log` record that cycle. The workflow command continues to be executed locally against clean and violating source; no remote GitHub Actions run is claimed. The callable checker remains usable for syntax-only fixtures when no program is supplied, while the required CLI always checks types.

Final verification:

- All 16 collected hosted fixture scenarios pass, without retries: `/tmp/pyric-connection-types-hosted.log`.
- All five existing SharedWorker/Studio browser scenarios pass: `/tmp/pyric-connection-types-worker-browser.log`.
- The 72-process worker/bridge/value-codec baseline passes 539 tests with no failures, skips, or todos: `/tmp/pyric-connection-types-baseline.log`.
- All 52 verification-tool and CI-policy scenarios pass: `/tmp/pyric-connection-types-tools.log`.
- CLI, hosted-fixture, and verification-tool typechecks pass. The current typed code-form report covers 58 TypeScript files with zero findings: `/tmp/pyric-connection-types-code-form.json`.

U3 now passes for this changed-source scope. Its exclusions remain explicit and unchanged functions are not silently added to the scope. This does not prove naming quality, evaluation timing, module ownership, or complete lifecycle behavior. The other universal gates and the full implementation/release objective remain open. Earlier live-emulator and broader state/CLI evidence stays historical.

## Browser boundaries and malformed host replies

The prompt-only turn made no implementation progress. On resumption, the unfinished browser-boundary suite had passed 65 tooling tests, but its strict typecheck had failed on two widened issue literals. Explicit callback return types fixed those diagnostics without assertions or changing the command's behaviour.

The browser-boundary command bundles each declared entry with esbuild, measures emitted bytes, and reports contributing modules. It refuses bundled sandbox/rules engines, host-owned code, unbundled imports, and exceeded budgets. Node imports fail the browser build. Required CI runs the command and its tests after workspace builds; local tests execute the workflow's actual four commands. No remote CI run is claimed. The ownership map documents the four budgets, permitted representation leaves, and the remaining source-graph scope. Seven historical S6 assertion failures and their green runs are recorded under `/tmp/pyric-browser-boundary-{measure,engine,budget,host,ci,tsx,external}-*`; allowance and argument/refusal characterisations began green.

At S1/S2, an actual browser transport fault replaces a pending read's host reply with invalid JSON. Before the fix, the SDK call stayed `Pending`; `/tmp/pyric-hosted-malformed-json-red.log` and its `-red-inputs.json` bind the assertion failure. The adapter now closes the affected connection and rejects pending requests with `unavailable`, preserving the warning that already-sent mutations may have completed. `/tmp/pyric-hosted-malformed-json-green.log` records the unchanged assertion passing, with no page errors and a second isolated browser still reading successfully. Review retained TypeScript narrowing through a constant parsed-message binding. This fixes JSON syntax failure only; full envelope/payload validation remains required.

Final verification against the rebuilt CLI:

- 17 collected hosted browser scenarios pass without retries: `/tmp/pyric-hosted-malformed-json-suite.log`.
- Five SharedWorker/Studio browser scenarios pass: `/tmp/pyric-hosted-malformed-json-worker-browser.log`.
- The 72-process baseline passes 539 tests, with no failures, skips, or todos: `/tmp/pyric-hosted-malformed-json-baseline.log`.
- All 65 tooling/CI scenarios pass: `/tmp/pyric-hosted-malformed-json-tools.log`. CLI, hosted-fixture, and tool typechecks pass.
- Code-form checking covers 61 changed TypeScript files with zero findings: `/tmp/pyric-hosted-malformed-json-code-form.json`.
- Worker client, hosted socket, value codec, and live Firestore bundles measure 48,248, 4,714, 12,260, and 387,843 bytes, respectively. All four are within their declared budgets and have no forbidden contributors or remaining imports. Reports are `/tmp/pyric-browser-{worker-client,hosted-socket,value-codec,live-firestore}.json`.

The evidence JSON preserves prior snapshots and records the current source, contract, ledger, lockfile, toolchain, artifact, and report identities. Earlier live-emulator and broader state/CLI observations remain historical. U4 still needs complete source ownership, cycle, and selection checks; U6 still needs interrupted host boot and complete resource accounting. No section or release gate is closed by these partial results.

## Support policies and scenario declarations

The previous turn made progress on malformed replies and bundle boundaries. This continuation records the policy inputs that were still absent: trusted sandbox admission versus credential-backed live admission, host/client transition tables, exclusive state ownership, process-crash durability acknowledgment, committed-but-not-durable failures, and concrete retention/workload bounds. The support document and JSON inventory describe the target contract, not released support or measured performance.

The manifest names six configurations and 44 required scenario declarations. At approved seam S6, the command now refuses undefined scenario references, duplicate scenario identities, configurations with no scenarios, duplicate configuration identities, and an empty inventory. It reports resolved/missing declarations with scope `scenario-declarations`, so a successful command cannot be confused with an execution report. The six assertion-red snapshots and green transcripts use `/tmp/pyric-support-{scenario,duplicate,uncovered,report,configuration,empty}-*`. Review replaced a literal assertion with a typed issue callback and corrected root-tool path resolution for the existing NodeNext typecheck; unchanged behaviour remains green.

Verification: all 71 tooling/CI tests pass in `/tmp/pyric-support-tools.log`; strict tool types pass in `/tmp/pyric-support-all-types.log`; code-form checking reports zero findings across 63 TypeScript files in `/tmp/pyric-support-code-form.json`. The actual manifest report is `/tmp/pyric-support-manifest-report.json`, with six resolved inventories and no declaration issues. Runtime source and built artifacts are unchanged from the previous snapshot; previous 17-hosted, five-worker-browser, and 539-baseline results were not rerun and remain explicitly historical.

Gate 0B is still open. The small checker currently validates declaration identities and references, not ownership/policy metadata, collected operation-level tests, refusal completeness, or execution evidence. CI wiring is also pending. Broad scenario declarations must be expanded and bound as each vertical slice is implemented. The proposed direct BridgeMount lifecycle tests await the requested S3 seam clarification; no tests at that additional interface have been authored. Existing S1–S6 approval continues to cover independent work.

## App deletion during attach and required support validation

The previous turn made progress on policy inputs and scenario declarations. This continuation worked at the existing S1/S2 boundary while the proposed direct mount-lifecycle test seam remained pending.

A real served SDK fixture delays the app's attach acknowledgment and freezes browser timers. It queues a write and calls `deleteApp`. The first fixture version was rejected by the existing rules linter; that setup failure is retained separately in `/tmp/pyric-hosted-delete-attach-setup-failure.log` and is not TDD red evidence. With a rule limited to the test document and payload, the actual behaviour assertion failed: deletion stayed `Deleting` while no SDK work had reached the host. `/tmp/pyric-hosted-delete-attach-red.log` and its `-red-inputs.json` preserve that failure.

The socket adapter now treats a disconnect during attachment as local cancellation: it discards unsent work and lets the existing app owner complete cleanup. The unchanged assertion passes in `/tmp/pyric-hosted-delete-attach-green.log`. The test observes the physical socket closing, the pending operation rejecting as app-deleted, and a replacement app reading the document as missing. Review makes the fixture await the replacement app's cleanup before reporting its result; `/tmp/pyric-hosted-delete-attach-reviewed.log` passes. This proves cancellation before SDK work is sent, not complete reconnect or interrupted Node-host boot.

At S6, the support checker previously accepted configurations without execution/identity/persistence/family ownership and scenarios without a seam, gate, or expected outcome. It now validates those fields' presence and basic shape and reports invalid metadata paths. Required CI runs support validation and its tests, includes strict tool types, and preserves the report. The CI case executes the actual workflow command against valid and invalid inventories and verifies failure propagation. The three cycles use `/tmp/pyric-support-{metadata,scenario-metadata,ci}-{red,green}.log` and their red input snapshots. No remote CI execution is claimed.

Final verification:

- 18 collected hosted browser scenarios pass without retries: `/tmp/pyric-delete-attach-hosted.log`.
- Five SharedWorker/Studio browser scenarios pass: `/tmp/pyric-delete-attach-worker-browser.log`.
- 539 baseline tests pass in 72 fresh processes, without failures/skips/todos: `/tmp/pyric-delete-attach-baseline.log`.
- 74 tooling/CI scenarios and the affected strict typechecks pass: `/tmp/pyric-delete-attach-tools.log`.
- Code-form checking covers 64 changed TypeScript files with zero findings: `/tmp/pyric-delete-attach-code-form.json`.
- Four leaf bundles pass; the hosted socket is 4,795 bytes against its unchanged 16,384-byte budget. Reports use `/tmp/pyric-delete-attach-{worker-client,socket,value-codec,live-firestore}.json`.

The current support declaration report is `/tmp/pyric-delete-attach-support.json`. Gate 0B still needs coherent ownership/family/gate relationships and concrete executable bindings. Earlier live-emulator and broader state/CLI results remain historical. Full lifecycle, architecture, authority, persistence, observation, live-surface, credential, packaging and release requirements remain open.

## Reference values through hosted and SharedWorker SDKs

The prompt-only turn made no implementation progress. This continuation added two S1 red/green cycles through normal Firebase-shaped browser imports and the real host. The new SharedWorker variants are characterization of the same behaviors, with no fabricated red evidence.

A nested reference written by one browser could not be followed by another: the SDK failed with `postMessage is not a function`. The first fix exposed a second loss at host read translation, which flattened the stored reference before serialization. The shared codec now encodes registered references in `setDoc`, host read translation preserves their type, and browser snapshots construct usable references with the receiving client's port. The original assertion passes. Evidence: `/tmp/pyric-hosted-reference-{red,green}.log` and `/tmp/pyric-hosted-reference-red-inputs.json`; the intermediate read-translation failure is `/tmp/pyric-hosted-reference-partial.log`.

The next test queried posts by author reference and incorrectly returned an empty result. Encoding `where` values exposed the additional requirement to reconstruct host query references through the selected database and to register stored references as canonical values when building query snapshots. Stored values acquire no client connection owner. The unchanged query assertion now selects Alice's post and excludes Bob's. Evidence: `/tmp/pyric-reference-query-{red,green}.log` and `/tmp/pyric-reference-query-red-inputs.json`. Intermediate failures remain in the `-partial.log` and `-partial-host-owner.log` files; they are not green evidence.

Review reused one client reference constructor and kept `rehydrateDocValue` unary for existing callers, including `Array.map`. Owner-aware decoding is a separate entry to the same recursive implementation. No new transport, engine, connection, or persistence owner was added. Existing named-condition rules apply to every modified function.

Final verification uses `/tmp/pyric-reference-final-*`: 22 hosted-fixture browser scenarios (including both reference behaviors over SharedWorker), five SharedWorker/Studio scenarios, 539 baseline tests in 72 processes, 21 additional value/read-translation regressions in five processes, and 74 tooling/CI scenarios all pass. Pyric, CLI, fixture and tool typechecks pass. The code-form command checks 75 TypeScript files with zero findings. Four browser leaf checks pass: worker client 48,859/98,304 bytes, socket 4,795/16,384, value codec 12,891/24,576, and live Firestore 387,843/524,288. There are no required skips or retry-only passes in these runs.

The evidence JSON records 82 current source/fixture/tool/workflow files with source digest `02d97f5c636bd95cbaa970faf5446b3048e699277654436d2dfba73dcf95e9cb`, current package artifact hashes, exact commands, and bounded reports. Earlier snapshots remain historical. No live backend was contacted or remote CI run claimed.

This is partial gate 2A evidence. The legacy marker still contains only a relative path; qualified project/database identity remains required. Other write APIs and factories, cursors, complete scalar encoding, marker collisions and invalid-value handling, in-page nested-reference execution, and event/capture propagation remain unfinished. Full support, lifecycle, architecture, persistence, observation, credential and release gates remain open.

## Reference values across modular write APIs

The previous turn made progress on stored-reference reads and equality queries. Seven further S1 cycles now cover references returned by `addDoc`, reference-valued `addDoc` input, `updateDoc`, batch set/update, and transaction set/update. Each new hosted test failed at its intended public assertion because rules requiring `author is reference` rejected the lost value type. Each then passed by storing the reference and following it through `getDoc` to read Alice's name. Transaction tests reuse both a reference from snapshot data and `snapshot.ref`.

The fixes reuse the existing encoder in each write buffer and the existing reference constructor for `addDoc` results. No second encoding dialect or resource owner was added. The green transaction slice received a separate review: named booleans now express retry availability, read-data presence, and conflict handling, while the five-attempt bound and error shape remain intact. Retry availability is recomputed only after the awaited conflict, preserving the original evaluation point. Its focused browser assertion and existing client/integration regressions passed after review.

Red/green transcripts and input identities use `/tmp/pyric-{add-reference,add-reference-data,update-reference,batch-set-reference,batch-update-reference,transaction-set-reference,transaction-update-reference}-{red,green}.log` and corresponding `-red-inputs.json` files. The first fixture was factored only after its green assertion. All seven SharedWorker variants began green and are recorded as characterization. These tests use normal SDK imports, actual host dispatch and rules, and SDK reads; they do not inspect private registries or mock internal collaborators.

Final verification uses `/tmp/pyric-reference-writes-reviewed-*`: 36 hosted-fixture scenarios, five SharedWorker/Studio scenarios, 539 baseline tests in 72 processes, 21 additional value/read-translation regressions in five processes, and 74 tooling/CI tests pass. Strict CLI, Pyric, fixture and tool checks pass. Code form reports zero findings in 76 TypeScript files. The worker client is 48,878 bytes against 98,304; the other three leaf measurements remain 4,795/16,384, 12,891/24,576 and 387,843/524,288. Required scenarios were collected and executed without skips or retries.

Current evidence covers 83 source/fixture/tool/workflow files with digest `b72b1c1047c6370373d316d33704138f05215a2ba69a6435ce524a1daae04b8c`. Only the client write module and new browser fixture changed since the preceding reference-read slice; the Pyric artifact hash is unchanged. No live backend was contacted or remote CI run claimed.

Gate 2A remains open. These cases cover the current modular write forms, not the complete SDK overload and converter contract, qualified project/database identity, cursor operands, in-page nested-reference execution, complete scalar encoding, invalid/marker-like values, or events/capture propagation. The remaining lifecycle, authority, persistence, observation, live-mode and release requirements are unchanged.

## SDK timestamps and reference cursor operands

This continuation resumed after the prompt-only turn. Six S1 red/green cycles now cover two timestamp failures and four reference cursor failures through normal Firebase-shaped imports and real hosted/SharedWorker execution.

The hosted timestamp read returned a rules wrapper without the SDK's `isEqual` method. The existing SDK Timestamp class was moved unchanged into a browser-safe leaf, preserving its old export; 39 existing timestamp/converter/persistence tests passed before the decoder change. SDK decoding now reconstructs that constructor, while unary persistence decoding retains the rules timestamp. The original browser assertion verifies class identity, nanoseconds, `toMillis`, and `isEqual`, and the write is enforced by an `is timestamp` rule. SharedWorker exposed a separate input loss: structured cloning removed class methods, so rules rejected the value as a map. Explicit timestamp encoding fixed that path. Red/green evidence uses `/tmp/pyric-sdk-timestamp-*` and `/tmp/pyric-sharedworker-timestamp-*`.

The SharedWorker timestamp cursor and hosted reference cursor began green and are characterization. A SharedWorker reference cursor instead failed because its operand tried to clone a MessagePort. Each of `startAt`, `startAfter`, `endAt`, and `endBefore` received its own failing assertion and minimal encoder change. The tests verify actual query rows, ordering, and inclusion/exclusion of the reference boundary. All four forms also pass through the hosted transport. Evidence uses `/tmp/pyric-sharedworker-reference-start-at-*` and `/tmp/pyric-reference-{start-after,end-at,end-before}-*`. Review shares the fixture setup and reuses the value encoder; it adds no new resource owner or transport selection logic.

Verification passes 47 hosted-fixture scenarios, five Studio/SharedWorker browser scenarios, 539 baseline tests in 72 processes, 56 value/timestamp regressions in eight processes, and 74 tooling/CI tests. Strict Pyric/CLI builds, fixture/tool typechecks, and code form pass; 81 TypeScript files have zero findings. Browser leaves remain within budget: worker client 50,102/98,304 bytes, socket 4,795/16,384, codec 14,082/24,576, and live Firestore 387,843/524,288.

The freshness audit identified that Studio's embedded assets predated the client changes. The site was rebuilt (133 pages), embedded into the CLI, and both browser suites rerun. The authoritative browser reports use `/tmp/pyric-timestamp-cursors-refreshed-*`; other current reports use `/tmp/pyric-timestamp-cursors-final-*`. The earlier browser passes in this slice are superseded. The evidence JSON binds 88 source/fixture/tool/workflow files, source digest `54d6813bd59920d7ef58957233943d86db6cc57a9128f349267d28bf22302cb5`, and the current compiled artifacts.

This remains partial 2A evidence. Snapshot cursor/converter overloads, qualified reference identity, remaining scalar types, marker collisions, invalid inputs, in-page reference execution, and event/capture propagation remain required. The full implementation and release gates stay open.

## SDK byte values

Two further S1 cycles now preserve byte values through the actual served SDK and both host transports. The served entry lacked the `Bytes` export. An initial static-import failure is retained only as a diagnostic; the recorded red reaches an operation handler and reports the missing `fromUint8Array` API. Adding the export exposed the next loss: reads returned a rules wrapper without `toUint8Array`. The existing SDK Bytes class moved into a browser-safe leaf, retaining its original export, and SDK decoding now constructs that class. Persistence continues to use rules bytes.

SharedWorker then failed the same public assertion because rules saw a map instead of bytes. The shared encoder now emits the existing bytes marker before structured cloning. The original binary assertion passes on both transports, including class identity, equality, exact byte content, and standard base64 output. Red/green logs and source/artifact snapshots use `/tmp/pyric-sdk-bytes-*` and `/tmp/pyric-sharedworker-bytes-*`; the initial import diagnostic and intermediate wrapper failure are not reported as green.

Review preserves JSON validation's short-circuit order and replaces an indexed byte-conversion loop with `Uint8Array.from`. The readonly unknown-property view lets TypeScript narrow the named JSON decision without changing property access order. Existing scalar/converter/persistence tests passed before the decoder change and after review: 101 tests in four processes. Eight additional characterization cases cover empty content and all base64 padding remainders, including array, base64, and JSON constructors. The ten byte scenarios pass through real browser and host code; the byte conversion functions use atob/btoa directly.

Final verification uses `/tmp/pyric-bytes-final-*`: 57 hosted-fixture scenarios, five Studio/SharedWorker browser scenarios, 539 baseline tests in 72 processes, 153 additional value/scalar regressions in 11 processes, and 74 tooling/CI tests all pass. Pyric, CLI and the embedded 133-page Studio/site were rebuilt before browser verification. Strict fixture/tool checks pass. Code form reports zero findings in 85 TypeScript files. Browser leaves pass at 51,090/98,304 bytes for the worker client, 4,795/16,384 for the socket, 15,067/24,576 for the codec, and 387,843/524,288 for live Firestore.

The evidence JSON binds 92 current source/fixture/tool/workflow files with digest `e422390c5b451daf132a059500875c84588d3e55982c1c5fe22692c694222ae3` and current compiled artifacts. No live backend was contacted or remote CI run claimed. Full 2A/2D remain open: binary limits, Storage blob/URL behavior, remaining scalar values, marker collisions, overloads, qualified identity, and event/capture propagation are still required. The full implementation goal remains open.

## SDK GeoPoint and vector values

Four S1 red/green cycles now preserve GeoPoint and vector values through normal browser SDK imports, real host dispatch, and both transports. The first GeoPoint assertion reached the operation handler and failed because the constructor was missing. SDK decoding now restores the existing GeoPoint class; persistence continues to restore LatLng. SharedWorker exposed a distinct failure: cloning stripped the class, so rules requiring `location is latlng` rejected the write. Explicit encoding with the existing marker fixed it. Evidence uses `/tmp/pyric-sdk-geopoint-*` and `/tmp/pyric-sharedworker-geopoint-*`, including red and green source/artifact snapshots.

The vector test first failed because the served module lacked `vector`. The entry now exports the existing factory and VectorValue class. SDK decoding reconstructs VectorValue for both the rules and SDK markers; the SDK marker reuses existing JSON validation. SharedWorker then returned a plain object without `toArray`. Encoding the existing SDK marker before cloning fixed that path. The tests assert actual SDK class identity, literal component values, and equality. They do not invent a Security Rules `is vector` type test. Evidence uses `/tmp/pyric-sdk-vector-*` and `/tmp/pyric-sharedworker-vector-*`.

Each existing class moved unchanged to a browser-safe leaf, with its old export retained. The same 101 existing scalar/codec tests passed after each mechanical move and after separate review. Review names validation decisions while preserving coordinate-check order, marker-first short-circuiting, numeric component validation, and property-access timing. No internal collaborator was mocked, and no resource owner, transport decision, or dependency was added. Eight additional GeoPoint cases cover zero, minimum, maximum, and JSON coordinates across both transports. Four additional vector cases cover default-empty and JSON construction. These twelve cases began green and are characterization.

Final verification uses `/tmp/pyric-scalars-final-*`: 73 hosted-fixture scenarios, five Studio/SharedWorker scenarios, 539 baseline tests in 72 processes, 153 additional scalar/value regressions in 11 processes, and 74 tooling/CI tests all pass. Pyric, CLI and the embedded 133-page Studio/site were rebuilt before browser verification. Fixture and tool typechecks pass. Code form reports zero findings in 89 TypeScript files. Browser leaves pass at 52,981/98,304 bytes for the worker client, 4,795/16,384 for the socket, 16,951/24,576 for the codec, and 387,843/524,288 for live Firestore. The browser suites have no skipped or retry-only passes.

The evidence JSON records current source, fixture, contract, lockfile, toolchain, artifact and report identities; prior snapshots remain historical. No live backend was contacted or remote CI run claimed. This remains partial 2A evidence: complete nested/non-finite and marker-like values, invalid-input policy, qualified reference identity, overloads, and event/capture propagation are still required. Full 2D, lifecycle, persistence, observations, live-mode and release gates remain open.

## Marker-shaped maps and declared value encoding

Three S1/S2 cycles advance the wire contract. A normal SDK write of a location-shaped user map beside a real GeoPoint initially failed rules because the host converted the map into a scalar. The existing codec now escapes maps containing marker keys and snapshot serialization uses that encoder as well. The public assertion verifies ordinary-map identity, all literal fields, and the neighboring real SDK value. Eleven further cases began green: both transports preserve exact and extended SDK markers, rules and vector marker maps, an escape-shaped map containing another marker-shaped map, and unknown markers with nested array maps. Evidence uses `/tmp/pyric-marker-map-{red,green}.log`, both input snapshots, and `/tmp/pyric-marker-map-reviewed.log`.

Review identified a compatibility regression in globally recognizing the new escape. A real unversioned SharedWorker consumer sent `{ type: 'pyric/map/1.0', fields: { label: 'legacy data' } }`, but the browser read only the inner label. The corrected wire declares `valueEncoding: 'pyric/firestore-values/1'` outside application data. Writes, batch/transaction descriptors, query operands, snapshots, and transaction read sets carry that declaration. Only declared decoding interprets the new escape. Current remote reads honor the reply envelope, while the existing unary persistence decoder retains its legacy interpretation. The original assertion and all map cases pass. Evidence uses `/tmp/pyric-legacy-marker-map-{red,green}.log` and both input snapshots.

The first consumer attempt used the hosted peer and failed before the map assertion because that peer does not yet support the older worker relay. `/tmp/pyric-legacy-marker-map-hosted-relay-diagnostic.log` is diagnostic evidence of the still-open hosted remote-parity requirement, not a TDD red for map preservation. The relevant compatibility cycle uses the established SharedWorker relay and the published remote channel.

An unsupported declaration initially executed its write successfully. The shared decoder now rejects unknown encoding with the shared FirebaseError primitive and `invalid-argument` before traversing or writing data. A second browser verifies that the document is absent, then reads/writes successfully. Evidence uses `/tmp/pyric-unsupported-value-encoding-{red,green}.log` and both input snapshots. This proves one rejection path, not complete envelope validation or cross-version admission.

Separate review named transaction comparison decisions, retained short-circuiting and repeated snapshot-data access, used discriminant switches for queued writes, and removed non-null assertions. The pre-existing composite-filter wire assertion now requires the literal encoding declaration on all three operands; legacy host-input fixtures remain unversioned. Removing the existing batch/transaction adapter assertions exposed a mismatch between public modular declarations and the runtime wrappers. The original assertions remain, and the API/type correction and options behavior require a dedicated SDK slice. The typecheck diagnostic is `/tmp/pyric-legacy-marker-map-review-cli-build.log`. Reviewed verification passed 27 targeted browser scenarios, 539 baseline tests, and 80 existing persistence/remote tests before the unsupported-encoding cycle.

Final verification uses `/tmp/pyric-maps-final-*`: 87 hosted-fixture scenarios, five Studio/SharedWorker scenarios, 539 baseline tests in 72 processes, 233 value/persistence/remote regressions in 14 processes, and 74 tooling/CI tests all pass. Packages and the embedded 133-page Studio/site were rebuilt before browser verification. Strict fixture/tool types pass; code form reports zero findings in 97 TypeScript files. Browser leaves pass at 53,773/98,304 bytes for the worker client, 4,795/16,384 for the socket, 17,854/24,576 for the codec, and 387,843/524,288 for live Firestore. No required scenario was skipped or accepted only after a retry.

The evidence JSON binds the current source, contract, lockfile, toolchain, artifact and report identities and retains prior snapshots as historical. No live backend was contacted or remote CI run claimed. New-client/old-receiver negotiation, full remote-writer adoption, durable map migration, operation/event/capture propagation, wrapper-clone canonicalization, non-finite values, qualified identity, and overloads remain required. Full 2A/2C/2D and the implementation/release gates remain open.

## Atomic replacement through storage and rules

Three S1 red/green cycles exposed separate losses of replacement intent through the normal hosted SDK. The original default batch write retained `obsolete: true`; after preserving `set` until commit, replacement rules still received that obsolete field. Passing the storage method into the shared rules-case builder fixed the request, but a sibling `getAfter()` then reconstructed the old field again. The projection now consumes resolved write operations before rule-method normalisation.

| Cycle | Relevant red | Unchanged green assertion | Evidence prefix |
| --- | --- | --- | --- |
| Batch replacement | Read returned the obsolete field after commit. | Read returns exactly the replacement profile, including its replacement nested map. | `/tmp/pyric-batch-replace-` |
| Replacement request rules | Update was denied by a rule permitting only the replacement's fields. | The same write succeeds and reads back the replacement. | `/tmp/pyric-batch-rules-` |
| Sibling getAfter | Receipt creation was denied because the projected profile retained an obsolete field. | Both writes commit and the profile reads back as the replacement. | `/tmp/pyric-batch-getafter-` |

Each prefix has red/green logs and input snapshots. The final fixture has twelve cases across batch/transaction and hosted/SharedWorker. Nine additional cases began green and are recorded as characterization. Tests use public SDK writes/reads, the real rules engine, and independently specified expected document data; no internal test or expected result was weakened.

Separate review replaced conditional record spreads with typed event/error construction, named branch decisions, and removed unused read-projection handling. The existing atomic engine, event, auth, Admin compatibility and rollback regression tests were run unchanged. No new resource owner, transport selection or protocol was introduced.

Final reports use `/tmp/pyric-batch-final-*`: 99 hosted-fixture scenarios, five Studio/SharedWorker scenarios, 539 baseline tests in 72 processes, 233 value/persistence/remote tests in 14 processes, 174 atomic-engine regressions in 21 processes, and 74 tooling/CI tests pass. The final atomic report is `engine-reviewed.log`; the earlier `engine-regressions.log` predates the last review-only edit. Strict Pyric/CLI, fixture and tool checks pass; code form reports zero issues in 103 TypeScript files. The packages and 133-page embedded Studio/site were rebuilt before final browser verification. All four browser leaf budgets pass at their previous sizes.

The evidence JSON binds 110 source/fixture/tool/workflow files with source digest `6705d68d698ca1c4e6ee86aae2b435f10cc48e8f31910ff6f775fca88daa4ea5`, the current artifacts, contracts, lockfile, toolchain and reports. No live backend was contacted or remote CI run claimed.

This is partial gate 2B evidence. Atomic merge/mergeFields, nested-update projection, transform intent through events/capture/replay, same-path scheduling, and modular batch/transaction type alignment remain required. Default replacement is proven only for the recorded scenarios; the full implementation and release gates stay open.

## Batch merge options and mask validation

Three further S1 red/green cycles now carry batch merge intent through the shared atomic pipeline. The adapter previously ignored both option forms: `merge: true` replaced the whole profile, and `mergeFields` wrote unselected input fields. The adapter now retains the requested merge mode, and the existing field-merge engine builds the resulting document before atomic rules, sibling projection and storage use it.

| Cycle | Relevant red | Green outcome | Evidence prefix |
| --- | --- | --- | --- |
| Nested batch merge | The profile lost its name and nested alerts setting. | Merge changes the theme and preserves the other fields. | `/tmp/pyric-batch-merge-` |
| Selected mergeFields | Unselected name and theme values overwrote existing data. | Only `settings.alerts` changes. | `/tmp/pyric-batch-mergefields-` |
| Missing mask field | The write committed its valid field and silently ignored the missing one. | `invalid-argument` is reported and the original profile is unchanged. | `/tmp/pyric-batch-missing-mask-` |

Each prefix has red/green logs and input snapshots. The final six-case fixture runs over hosted and SharedWorker. Positive cases also require rules to see the merged request.resource and a sibling getAfter; three additional SharedWorker cases are characterization. The refusal assertion allows validation during set or commit so it does not depend on where the implementation performs the check.

The installed Firebase 12.13.0 implementation validates mask membership in `parseSetData` (`common-7a7519be.esm.js`, line 20498). Its source identity is recorded in the evidence JSON; this was source inspection, not execution against Firebase. One pre-existing Admin regression expected silent skipping. Its diagnostic failure is `/tmp/pyric-batch-mask-old-expectation.log`; the corrected regression requires invalid-argument and unchanged data through the public document handle. No test was dropped, and the expected contract was strengthened rather than relaxed. The merge engine uses the shared FirebaseError type.

Separate review kept the original payload separate from the merged execution data and checked the existing atomic, event, error, auth and Admin paths. Final reports use `/tmp/pyric-merge-final-*`: 105 hosted-fixture and five Studio/SharedWorker browser scenarios, 539 baseline tests, 233 value/persistence/remote regressions, 174 atomic-engine regressions and 74 tooling/CI tests pass. Strict package/fixture/tool types, code form across 106 TypeScript files, and all four browser budgets pass. Packages and the 133-page embedded Studio/site were rebuilt before final browser verification.

The evidence JSON binds 113 source/fixture/tool/workflow files with source digest `7e4ce9eeb68db0283b2794e00c7c20bd51bd8019a83a1563dcff862e74547f37`, current artifacts/contracts/toolchain, and reports. No external Firebase backend or remote CI run is claimed. Transaction merge options, same-path composition, queued-input mutation, conflicting option combinations, complete mask/transform validation and client-side validation timing remain open alongside public type alignment and event/capture/replay intent. Full gate 2B and the implementation/release gates remain open.

## Transaction merge options and simple composition — 2026-09-13

Three S1 cycles now have recorded red, green, and separate review evidence:

| Behavior | Relevant red | Minimal change |
| --- | --- | --- |
| Transaction merge:true | Replaced the profile with the partial payload. | Carry merge intent through the Admin adapter, transaction queue, and atomic pipeline. |
| Two merge:true writes to one document | The second partial payload erased the first change and untouched fields. | Preserve prior write intent while merging the two plain payloads. |
| Transaction mergeFields | Changed unselected name/theme fields. | Forward the selected mask to the existing shared merge engine. |

Reports and input snapshots are `/tmp/pyric-transaction-merge-{red,green}*`, `/tmp/pyric-transaction-merge-composition-{red,green}*`, and `/tmp/pyric-transaction-mask-{red,green}*`. The previous turn's unfinished review was revalidated before the field-mask cycle. Review reports use `/tmp/pyric-transaction-resume-*` and `/tmp/pyric-transaction-mask-reviewed-*`; all recorded commands returned their expected terminal status.

Eight transaction scenarios run through normal SDK imports over hosted and SharedWorker. Field-mask cases require correct request.resource and sibling getAfter; missing-field cases reject with invalid-argument and preserve the document. Additional transport and refusal cases began green and are characterization. The 26-case atomic browser suite and 174 existing atomic-engine regressions pass. No new test inspects private transaction state.

Final integration reports use `/tmp/pyric-tx-final-*`: 113 hosted-fixture scenarios, five Studio/SharedWorker scenarios, 539 baseline, 233 value/persistence/remote and 74 tooling tests pass. Current strict builds and fixture checks are in the mask-reviewed reports; the tool typecheck is in the final reports. Code form checks 111 TypeScript files with zero issues. All four browser budgets pass; the 133-page site was rebuilt and embedded before final browser verification.

The evidence JSON binds 118 source/fixture/tool/workflow files with source digest `6c18f96e293fd9e7e68bcce08eb5dc7f4b5a5f9385d74e3c37a7bb1e6b793a42`, current artifacts, contracts, toolchain and reports. No external Firebase backend or remote CI execution is claimed.

General write composition is still incomplete. The transaction reducer combines raw payloads before resolving transforms; the two plain merges do not prove correct mask composition, repeated transforms, nested updates or deletion sequences. Preserve ordered write intent in the next composition work rather than adding isolated merge exceptions. Queued-input lifetime, complete mask validation, public modular types, event/capture/replay intent and all remaining implementation/release gates remain open.

## Ordered atomic writes and rule projections — 2026-09-13

Three S1 red/green cycles establish ordered masked writes, final-document request rules, and nested-update projection through request rules/getAfter. Their transcripts and input snapshots use `/tmp/pyric-ordered-masks-{red,green}*`, `/tmp/pyric-ordered-rules-{red,green}*`, and `/tmp/pyric-nested-update-projection-{red,green}*`. The same independently expected outcomes pass after separate review.

Transactions now pass their original queue to shared preparation. Each write resolves against the preceding projected document; rules and getAfter use the final projection. Projection reuses the existing update engine, preserving the distinction between nested-map replacement and dotted field updates. The exported legacy reducer remains available to internal callers but is outside transaction execution.

Review caught a changed transaction diagnostic shape: a same-path multi-update returned two results instead of one. `/tmp/pyric-ordered-masks-review-regressions.log` records the failure. Summarizing results after execution restores the existing contract; the regression assertion was retained. Final review reports use `/tmp/pyric-ordered-reviewed-*`: 46 atomic browser scenarios, 174 engine regressions, strict package/fixture types and zero code-form issues across 111 TypeScript files. The fixture contains 34 merge/update scenarios over both atomic APIs and transports; added repeated-increment, dotted-update and transport cases began green.

An independent actual Firebase 12.13.0 SDK run against disposable local emulators confirms that two masked writes are allowed by rules requiring the original resource and final request document, and that ordered increments produce 15 from 10 + 2 + 3. `/tmp/pyric-ordered-oracle-with-java.log` records both outcomes. The initial default-Java setup failure in `/tmp/pyric-ordered-oracle.log` is excluded from behavior red evidence; the existing local Java 21 runtime completed the check. The evidence JSON binds the oracle script, emulator harness and runtime metadata. This does not establish the broader live instrumentation or credential contract.

Final reports use `/tmp/pyric-ordered-final-*`: 133 hosted-fixture scenarios, five Studio/SharedWorker scenarios, 539 baseline, 233 value/persistence/remote and 74 tooling tests pass. All browser budgets pass. The 133-page site was rebuilt and embedded before final browser verification. The evidence JSON binds 118 source inputs with digest `155aaaa013a1ac74ac0d3b5d81bf3ec16737b5d3e4c2e00cc0f599048c86ef4d`, current artifacts, contracts, reports and toolchain. No production execution or remote CI run is claimed.

Full composition remains unproven. Storage preconditions still use initial existence, post-delete sequences retain an existing refusal, and queued-input lifetime, complete mask/transform validation, public adapter types and event/capture/replay intent remain required. These proofs do not close gate 2B or any full implementation/release gate.

## Next required work

1. Finish 0B semantic ownership/family/gate validation and concrete operation/refusal scenario bindings. Required metadata shape checks and CI enforcement now exist, but they do not establish implemented support. Canonical project/host identity and the early proofs' remaining universal gates are still required.
2. Complete interrupted initialization and socket shutdown at S1/S2. Deletion before attachment now cancels unsent work and closes its socket. Queued and already-sent calls reject on failure without replaying an uncertain write; later calls report unavailable, and local unsubscribe is safe. Subscription recovery, reconnect, interrupted Node boot, and complete resource accounting remain unfinished; the transition contract must be proven through those paths.
3. Preserve the passing U3 and browser-artifact checks while completing source ownership, import-cycle/selection checks, and current-input gate completion binding. Required CLI commands and CI wiring exist. Their scope does not establish complete architecture or lifecycle correctness.
4. Complete the early proofs' remaining universal gates before advancing dependent implementation. Served import maps and Vite have real SDK ownership read evidence; import/bundle boundaries, lifecycle accounting, complete scenario manifests, and reproducible emulator prerequisites remain open.
5. Continue the full numbered sequence. The current Node peer advertises browser ports only, has ephemeral memory storage, and has not established capture, legacy remote/MCP parity, restart durability, auth resume, bounded retention, or hosted-live credentials. These are still required outcomes.

6. Extend the reference and special-value contract beyond the proven modular writes, reads, where inputs, reference value cursors, timestamp identity/precision, byte identity/content, GeoPoint coordinates, and vector components: snapshot/converter overloads, qualified identity, in-page execution, nested/non-finite and marker-like values, events/capture, and explicit invalid-value handling. These paths must pass 2A before declaring the shared codec complete.

7. Default atomic replacement now has storage, request-rule and sibling-projection proofs. Align public modular batch/transaction declarations with their supported references and options, then remove the existing host adapter assertions under a dedicated SDK behavior/type proof. Batch merge:true and nested field masks now have execution/rules/refusal proofs. Ordered masks, repeated increments, final-document request rules, nested-map replacement and dotted-update projections now pass on both transports and atomic APIs. Complete sequential storage preconditions and deletion behavior, queued-input lifetime, full mask/transform validation and event/capture propagation. Complete wrapper-clone value comparison and map fidelity across transactions before claiming the scalar or write-intent contract complete.
8. Complete value-encoding adoption and compatibility: remote writes, durable formats, event/capture consumers, mixed-version negotiation/refusal, and complete inbound validation. Preserve legacy data interpretation while introducing explicit format versions; an encoding string by itself is not a compatibility handshake.


## Sequential atomic writes and main integration, 2026-09-13

The worktree was fast-forwarded from `c3555ac5` to origin/main `e207262f`. The incoming runtime-chip change had no overlapping local paths. `/tmp/pyric-before-main-sync-ol6baohp/manifest.json` verified that all 133 changed/untracked files survived byte-for-byte. All integrated results below follow that merge and fresh Pyric, CLI and embedded Studio builds.

Three S1 red/green cycles establish ordered existence for create-then-update, creation rules for that sequence, and `invalid-argument` with unchanged data for delete-then-update. Reports and input snapshots use `/tmp/pyric-sequential-preconditions-`, `/tmp/pyric-rule-selection-` and `/tmp/pyric-delete-update-`. The real Firebase SDK independently confirmed these contracts using disposable local emulators: `/tmp/pyric-deletion-oracle.ts` and `/tmp/pyric-deletion-oracle.log`. No production service was used.

Delete-then-set, recreation followed by update and repeated deletion began green and are recorded as characterisation. All six behaviours now run across both write APIs and both host transports. Separate review moved atomic application and store types out of LocalState, preserving 69 regressions before/after and the original type exports. Named-condition review retained backing access, projection getter and version-update timing. Existing regressions were corrected against the real SDK, retaining unchanged-data and aborted-event assertions. A review run against stale compiled code is a setup diagnostic, not red evidence; the rebuilt run passes. Shared preparation reuses projected state instead of a second deletion registry.

Integrated checks pass: 157 hosted browser scenarios, five SharedWorker/Studio scenarios, 539 baseline tests, 233 value regressions, 310 engine/store/branch/persistence tests, 74 tooling tests and 102 incoming-main regressions. Strict production/fixture/tool types pass; 116 changed TypeScript files have zero source-form findings. Four browser leaf bundles pass their existing budgets. Reports use `/tmp/pyric-sequences-integrated-`; the JSON ledger binds those reports to current inputs and artifacts.

Full 2B and all incomplete implementation/release gates remain open. Atomic work still includes queued-input lifetime, complete option/mask/transform validation, public types, error precedence, raw-store failure atomicity and event/capture/replay semantics. Authoritative persistence, recovery, bounded observations, full live execution and credentials remain required.


## Queued write input ownership, 2026-09-13

Four S1 red/green cycles cover two failures: modifying a field-mask array after a hosted batch/transaction set changed the selected field; modifying nested data after an in-page batch/transaction set changed the committed document. Browser host adapters now copy supported set options and masks when queued. The in-page batch set and transaction queue reuse the existing document copier to capture plain containers. The expected assertions are unchanged from red to green; reports and input snapshots use `/tmp/pyric-queued-mask-`, `/tmp/pyric-queued-tx-mask-`, `/tmp/pyric-queued-inpage-data-` and `/tmp/pyric-queued-inpage-tx-data-`.

The real Firebase SDK independently confirms all four outcomes against disposable local emulators: `/tmp/pyric-queued-transactions-oracle.ts` and `/tmp/pyric-queued-transactions-oracle.log`. JSON object key order is excluded from that comparison. Additional transport cases began green and are characterisation; the ten-case matrix covers hosted/SharedWorker masks and hosted/SharedWorker/in-page nested set values for both write APIs.

Separate review consolidated client option copying and moved the existing document copier from field merging into `document-copy.ts`. The same 310 regressions pass before and after the mechanical move, and after named-condition review. The copier retains the existing class-instance handling. An initial regression command named a nonexistent test file; the corrected command executed real write-rehydration and auth-lens tests. A transaction compile failure required narrowing a captured local value instead of asserting its type. Neither diagnostic counts as behavioural red evidence.

Current verification passes 167 hosted-fixture browser scenarios, five SharedWorker/Studio scenarios, 539 baseline tests, 233 value regressions, 310 engine/store/branch/persistence regressions, 74 tooling tests and 102 runtime-chip/asset regressions. Strict production, fixture and tool checks pass. Source-form review reports zero findings in 117 TypeScript files. The worker-client bundle is 53,874 bytes, an increase of 101 bytes within its 98,304-byte budget; all four browser leaf checks pass. Reports use `/tmp/pyric-queued-final-` and `/tmp/pyric-queued-reviewed-`.

This is partial queued-input coverage. In-page masks, batch update payloads, mutable SDK/native values, own-key/class fidelity and pending single-write options remain open, alongside complete validation, public types and event/capture/replay intent. The full hosted/live implementation and release gates remain required.

## Queued masks, nested updates, and Date values, 2026-09-13

Five further S1 red/green cycles cover in-page batch/transaction field masks, in-page batch nested updates, and hosted/in-page Date capture. Mutating a queued mask or nested update previously changed the committed document. Hosted Dates previously arrived as strings and failed timestamp rules; in-page Dates retained the later mutation (`99999` milliseconds instead of `12345`). The fixes copy in-page masks and update containers, encode native Dates with the existing timestamp marker, and detach Dates in the shared document copier without resolving transforms.

Red/green reports and input snapshots use `/tmp/pyric-inpage-mask-`, `/tmp/pyric-inpage-tx-mask-`, `/tmp/pyric-inpage-update-copy-`, `/tmp/pyric-queued-date-wire-`, and `/tmp/pyric-queued-date-inpage-`. All five pairs retain byte-identical behavioral fixtures between red and green. Separate review consolidates the fixtures into 24 scenarios across batches/transactions and hosted/SharedWorker/in-page execution. Additional cases began green as characterization.

The real Firebase SDK reference was rerun against disposable local emulators: `/tmp/pyric-date-validation-oracle.ts`, with output in `/tmp/pyric-date-reviewed-oracle.log`. It confirms queue-time capture and shows that Invalid Date stores as epoch while a valid Date outside Firestore range throws `invalid-argument` synchronously. Invalid/out-of-range validation parity is still unimplemented; this is not a complete Date validation claim.

The rebuilt candidate passes 181 hosted-fixture and five Studio/SharedWorker scenarios, 539 baseline, 233 value, 310 engine, 74 tooling and 102 runtime-chip/asset tests. Strict types pass; 118 TypeScript files have zero code-form findings. All four browser budgets pass. Reports use `/tmp/pyric-date-final-`, `/tmp/pyric-date-reviewed-`, and `/tmp/pyric-date-copy-reviewed-engine.log`. The JSON ledger binds 125 source files, three built artifacts and 33 reports to the current candidate, including the five red/green pairs.

Full 2A/2B and implementation/release gates remain open. Other mutable values, own-key/class fidelity, pending single-write options, validation, public types and event/capture/replay intent still require work, alongside the remaining host lifecycle, persistence, observation and live-mode contracts.

## Timestamp validation, precision, and default query order, 2026-09-13

Nine S1 red/green cycles establish Date range refusal before queueing, Timestamp nanosecond bounds and error precedence, microsecond precision before storage/rules and query execution, and implicit document-key ordering. SDK Timestamp objects retain their original nanoseconds. Reports and immutable input snapshots use `/tmp/pyric-timestamp-{upper,lower,inpage,nanos-negative,nanos-upper,storage-hosted,storage-rules,query}-{red,green}*` and `/tmp/pyric-query-default-order-{red,green}*`. The in-page storage read initially passed and is recorded as characterization; the later strict-rules assertion exposed a separate real failure.

Actual Firebase 12.13.0 references in `/tmp/pyric-timestamp-range-oracle.log` and `/tmp/pyric-timestamp-order-oracle.log` establish the independent expectations. The latter uses disposable local emulators. Earlier stored-Timestamp and cursor expectations incorrectly preserved sub-microsecond precision; the corrected assertions now match the SDK. Four legacy default-order cases were retained with corrected SDK-confirmed results, following ADR-0009's separate correctness-fix provision. No source test was silently dropped.

Separate review preserves evaluation timing, names decisions, reuses the Timestamp bounds, and removes an unused private query predicate. The reviewed matrix contains 54 scenarios. Final reports use `/tmp/pyric-timestamp-final-`: 226 hosted-fixture browser scenarios, five Studio/SharedWorker scenarios, 539 baseline, 233 value, 310 engine, 29 query/order, 74 tooling and 102 runtime regressions pass. Strict types and 123-file source-form checks pass; all four browser bundles stay within budget.

The ledger audit verifies 130 current source inputs, three artifacts, embedded Studio, 46 report hashes and nine red/green snapshot pairs. Source digest: `b3aeda4aba6290d1d51d563eeee28eb3123ccf95ae27db6a154ffd316c8df87b`. This remains scoped evidence. Complete inbound/value validation, write intent, public adapter types, lifecycle, durability, observations, live execution, credentials and release gates remain open.

## Modular transaction document snapshots, 2026-09-13

One S1 red/green cycle reproduces and fixes the in-page `snapshot.exists is not a function` failure through normal served SDK imports. The transaction boundary binds its existing read, then applies the same snapshot tagging and value normalization used by ordinary modular reads. The read still participates in the transaction's conflict tracking. Its existing query overload is forwarded unchanged. The first fixture run was refused because its recursive open rules violated the CLI's fixture policy; `/tmp/pyric-transaction-snapshot-setup.log` is a setup diagnostic, not red evidence.

The unchanged original assertion passes in `/tmp/pyric-transaction-snapshot-green.log`; red/green input snapshots preserve the same fixture hash. Separate review extends coverage to existing and missing documents across all three execution paths. The five additional cases began green. The six SDK regression files pass 172 tests, including transaction retry, max-attempt, tenant and captured-identity behavior. Source inspection confirms that the underlying adapter constructs a fresh transaction per callback attempt.

Current reports use `/tmp/pyric-transaction-snapshot-`: 232 integrated hosted-fixture browser scenarios, five Studio/SharedWorker scenarios, 539 baseline tests, the 172 SDK regressions, and the six focused snapshot cases pass. Affected strict production and fixture types pass. The 125-file source-form check reports no issues, and all four browser budgets pass. Pyric, CLI and the embedded 133-page site were rebuilt. Earlier engine/value/query/tool reports remain historical; they are not reported as rerun for this adapter change.

This corrects an observable runtime boundary but does not complete the modular transaction contract. Its public declarations still inherit Admin types; converter behavior, complete value/reference preservation and typed SDK adapter fixtures remain required. Align the public adapter and declarations in subsequent behavior slices rather than extending the method replacement into a general wrapper framework. Full wire, lifecycle, persistence, observation, live-mode and release gates remain open.


## Transaction converters and reference values, 2026-09-13

Five S1 red/green cycles now preserve converted transaction document models, converter propagation into a following read, queued modular references, and references copied from transaction snapshot data. The first three cycles were completed before the prompt-only turn and revalidated here; two further cycles fix the reference paths. Reports and immutable input snapshots use `/tmp/pyric-transaction-converter-{inpage,hosted,followup}-`, `/tmp/pyric-modular-reference-copy-`, and `/tmp/pyric-transaction-reference-value-`. Every pair retains identical fixture bytes and the same behavioral assertion between red and green.

The modular adapter keeps reads inside the backing transaction and captures its database identity at operation start. Reference methods live outside the Admin error-translation proxy, which otherwise wraps the returned object and loses its metadata. Both backing and modular references carry the existing query registration. Snapshot decoding uses the receiving owner's reference factory. The shared document copier preserves registered references in queued inputs and replaces the native clone that erased scalar types in transaction reads. Separate review restored the unchanged query conformance assertions; the intermediate 30-of-31 browser report remains a failure diagnostic.

Positive type fixtures compile the converted model through `pyric/firestore` and the published worker adapter without assertions. The real Firebase 12.13.0/local-emulator oracle in `/tmp/pyric-transaction-converter-oracle.log` establishes lazy conversion, missing-document behavior and retained converter identity. Current browser assertions verify the resulting model and a subsequent converted read; they do not independently establish every oracle property.

The reviewed candidate passes all 243 hosted-fixture browser scenarios (30 files), five rebuilt Studio/SharedWorker scenarios, 539 baseline, 187 SDK, 233 value and 310 atomic-engine tests. Strict production/public fixture types and the 133-file source-form check pass. Four browser budgets pass; the worker client is 54,426 bytes against 98,304. Pyric, CLI and the 133-page embedded site were rebuilt. Final reports use `/tmp/pyric-transaction-converter-final-`; the JSON ledger records current source, contracts, artifacts and report identities. A fresh fetch confirms HEAD and origin/main are both e207262f.

This remains partial 2A/2B evidence. Converter removal/reapplication, converted writes, query/listener converters, full snapshot/batch/transaction types, foreign-reference ownership checks, mutable scalar/own-key fidelity and complete validation remain required. Host lifecycle, authoritative persistence, bounded observations, full live execution, credential isolation and release gates are also unfinished. No full implementation or release gate is closed.


## Converter lifecycle and converted model writes, 2026-09-13

Six S1 red/green cycles establish converter removal/reapplication on factory references and basic converted writes through setDoc, batches and transactions. Removing a converter previously returned a backing reference without the modular method; the same lifecycle test now reads raw data, retains the original converted reference and reapplies conversion successfully. Hosted setDoc, hosted batch/transaction set and in-page batch/transaction set previously sent app-model fields into rules instead of the converted database fields. The unchanged assertions now pass the actual local rule and read the expected stored document through the SDK.

Immutable red/green input snapshots and reports use `/tmp/pyric-converter-lifecycle-`, `/tmp/pyric-converted-set-hosted-`, `/tmp/pyric-converted-batch-hosted-`, `/tmp/pyric-converted-transaction-hosted-`, `/tmp/pyric-converted-batch-inpage-`, and `/tmp/pyric-converted-transaction-inpage-`. Every pair retains the same fixture bytes and behavioral assertion. Separate review expands to 12 cases; six additional transport/operation cases began green.

Review removes intermediate reference shells and shares model conversion within each adapter. Conversion remains separate from encoding to preserve evaluation order. The modular batch now owns an explicit SDK-reference interface over its backing batch, returns itself for chaining, and forwards its existing per-commit options. Database identity remains captured when the batch or transaction starts. Positive type fixtures compile model writes through both published adapters without index signatures or assertions. An initial build failed on an unavailable type export; the corrected local type import builds successfully, and the compile failure is not behavior-red evidence.

The current candidate passes 255 browser scenarios in 32 hosted-fixture files, five rebuilt Studio/SharedWorker cases, 539 baseline, 187 SDK, 233 value and 310 atomic-engine tests. All affected strict types pass. The code-form check reports no findings in 136 TypeScript files. Four browser budgets pass; the worker client measures 54,530 bytes against 98,304. Pyric, CLI and the embedded 133-page site were rebuilt. Final reports use `/tmp/pyric-converted-writes-final-`; focused review uses `/tmp/pyric-converted-writes-reviewed-`.

These are partial 2A/2B results. Full document input validation is still required; the modular atomic helper retains a raw DocumentData assertion on the unconverted path and must not be treated as a runtime validator. Other reference producers, converter options, synchronous exception timing, full generic/overload constraints, worker transaction chaining, query/listener converters and update-with-converter behavior still need proof. Host lifecycle, durable authority, bounded observations, full live execution, credential isolation and release gates remain unfinished. No full implementation or release gate is closed.


## Document validation before atomic queueing, 2026-09-13

Four recorded S1 red/green cycles reject numeric document roots and numeric converter output before batch queueing. The pending in-page cycle was revalidated with an observed exit 0. Hosted execution previously queued the invalid input and rejected the complete batch at commit; in-page execution could create an empty document. The unchanged assertions now observe invalid-argument, retain the valid write and confirm the invalid document is absent. Reports and input snapshots use `/tmp/pyric-{document-input,converter-input}-{inpage,hosted}-`.

Both adapters validate after conversion through one document-root validator, reusing the shared FirebaseError. Mechanical commit `ecd73fe0` extracts the existing plain-object predicate while retaining its previous import path; the same 310 engine tests pass before and after. The browser adapter consumes the validator through the existing internal value-codec export, without importing engine code. The raw DocumentData assertion in modular atomic conversion is removed.

Separate review retains the original four assertions in a 30-case batch/transaction matrix across hosted, SharedWorker and in-page execution. Twenty-six cases began green, including null, array and class roots. Nine existing valid converted-write cases also pass. The installed Firebase SDK, using disposable local emulators, independently confirms all ten operation/input combinations in `/tmp/pyric-document-shapes-oracle.log`.

Final reports use `/tmp/pyric-document-input-final-`: 285 hosted-fixture browser cases in 33 files, five rebuilt Studio/SharedWorker cases, 539 baseline, 187 SDK, 233 value and 310 engine cases pass. Strict production and public fixture types pass. Code form reports zero findings in 140 TypeScript files; all four browser budgets pass. Pyric, CLI and the embedded 133-page site were rebuilt. The JSON record binds committed and uncommitted source changes relative to main `e207262f`, current artifacts, contracts, and reports.

These checks cover root shape before atomic queueing. Nested unsupported values, complete own-key fidelity, single-write/update validation, converter options and exception timing, public type compatibility and malformed wire payloads remain unfinished. Host lifecycle, authoritative persistence, bounded observations, full live execution, credentials and release gates also remain open. No full implementation or release gate is closed.


## Malformed wire paths and shared atomic application, 2026-09-13

Three S1/S2 red/green cycles reject non-string document paths in setDoc, batch writes and transaction writes. Each failing case replaced a valid path with an array containing that path after the application encoded its request. The host coerced the array into a valid string and executed the write. The unchanged assertions now receive invalid-argument and a healthy client confirms that no document was written. Reports and immutable input snapshots use `/tmp/pyric-wire-path-hosted-`, `/tmp/pyric-wire-batch-path-hosted-`, and `/tmp/pyric-wire-transaction-path-hosted-`.

A small wire validator reuses the shared FirebaseError and rejects coercion before reference construction; SDK path-segment validation remains unchanged. Expanded review revealed a separate transaction application loop bypassing the batch check. That failure is retained in `/tmp/pyric-wire-path-review-before-transaction.log`. The focused transaction cycle precedes its fix. Separate review then consolidates atomic write application and removes the unknown-to-writer assertion and transaction adapter cast. Reads use the already-proven callable snapshot shape and retain their data-access timing and conflict validation.

The final six-case matrix uses actual WebSocket fault injection for hosted execution and native MessagePort fault injection for SharedWorker. SharedWorker clients are separate tabs in one browser context; hosted clients use isolated browser contexts. The healthy client writes after the refusal, and both clients read that value, proving continued access to the same host. Two SharedWorker cases began green; its transaction case exposed the same missing check as hosted transactions and passed after that fix.

The reviewed 104-case atomic/snapshot selection passes. Final reports use `/tmp/pyric-wire-path-final-`: all 291 hosted-fixture browser cases in 34 files, five rebuilt Studio/SharedWorker cases, 539 baseline, 187 SDK, 233 value and 310 engine cases pass. Strict production and public fixture types pass. Code form reports zero findings in 142 TypeScript files, and all four browser budgets pass with unchanged sizes. Pyric, CLI and the embedded 133-page site were rebuilt. A fresh fetch confirms origin/main remains e207262f and is contained by HEAD ecd73fe0. The JSON ledger binds current source, contracts, artifacts and reports.

This is partial 2C evidence. The check covers setDoc and atomic write descriptor path types, not complete messages. Other paths, malformed envelopes/descriptors, value schemas, negotiated versions, session admission and size/depth limits remain open. Host lifecycle, authoritative persistence, bounded observations, full live execution, credentials and release requirements also remain unfinished. No full implementation or release gate is closed.


## Malformed atomic descriptors and list containers, 2026-09-13

Four S1/S2 red/green cycles reject unknown atomic methods, null descriptors, non-array write lists and a non-array transaction read set. The unknown-method red shows a valid sibling committed while the invalid descriptor was silently skipped: a healthy client's SDK reads returned ["First","Missing"]. The read-set red shows both writes committed after an empty string was treated as zero reads. Null descriptors and object-shaped write lists instead returned unknown errors. Each unchanged behavioral assertion now requires invalid-argument and no document mutation.

Reports and immutable input snapshots use `/tmp/pyric-wire-unknown-method-`, `/tmp/pyric-wire-null-write-`, `/tmp/pyric-wire-write-list-`, and `/tmp/pyric-wire-read-list-`. Every recorded red/green pair retains identical fixture bytes and command. The stronger unknown-method test checks storage through the healthy SDK client before checking the error; that assertion order was established and rerun red before implementation.

The shared atomic writer rejects invalid descriptor containers and unknown methods. Batches and transactions check their write lists before execution; transactions also check the read-list container. Separate review consolidates the array check in one assertion and removes the redundant batch commit cast. The assertion proves only unknown[], without claiming that entries have been validated. Existing remote batch and transaction writers still emit arrays and set/update/delete descriptors. These changes reuse the shared FirebaseError and add no resource owner.

The reviewed fourteen-case matrix covers both atomic APIs and WebSocket/MessagePort transports where applicable; ten additional cases began green. Each test verifies no mutation through a healthy client's normal SDK, checks invalid-argument, then proves both clients can read a healthy write from the same host. Hosted clients use isolated browser contexts; SharedWorker clients use separate tabs in one context, with fault injection confined to the faulty page. The transaction application performs a real SDK read before queueing both writes. The embedded application and native fault-injection JavaScript are exercised by the browser, not by the fixture TypeScript project.

The focused twenty-case atomic/path selection passes. Final reports use `/tmp/pyric-atomic-wire-final-`: all 305 hosted-fixture cases in 35 files, five rebuilt Studio/SharedWorker cases, 539 baseline, 187 SDK, 233 value and 310 engine cases pass. Strict production and public fixture types pass. Code form reports zero findings in 143 TypeScript files; four browser budgets pass with unchanged sizes. Pyric, CLI and the embedded 133-page site were rebuilt. The JSON ledger binds current source, contracts, artifacts and reports.

This remains partial 2C evidence. Individual transaction read entries and serialized data, complete write option/value schemas, remaining path fields, envelopes, admission, negotiated versions and size/depth limits remain required. Full wire adoption, host lifecycle, authoritative persistence, bounded observations, live execution, credentials and release gates remain open. No full implementation or release gate is closed.


## Transaction read entries and paths, 2026-09-13

Two S1/S2 red/green cycles reject null transaction read entries and array-valued read paths. Null entries previously returned unknown; an array path was coerced into a valid reference and both queued writes committed. The unchanged assertions now require invalid-argument and no document mutation through a healthy client's SDK. Reports and input snapshots use `/tmp/pyric-wire-null-read-` and `/tmp/pyric-wire-read-path-`; each pair retains the same command and fixture bytes. The initial anchored filter collected no tests and is retained as a collection diagnostic, not red evidence.

The host checks the entry container before reading fields and reuses the existing string-path validator before constructing the reference. Separate review preserves conflict detection, read timing and transaction ownership. The 24-case atomic/path review passes, including two new SharedWorker cases that began green. Both clients remain able to read a healthy write after refusal. These checks remain partial: serialized read data, encoding, full payload schemas, other paths, admission and resource limits are still required.

Final reports use `/tmp/pyric-wire-read-final-`: 309 browser scenarios in 35 hosted-fixture files, five Studio/SharedWorker scenarios and the 539-test baseline pass. Strict CLI production and public fixture types pass; code form reports zero issues in 143 TypeScript files and all four browser budgets pass. The CLI was rebuilt. Pyric and embedded Studio inputs and artifacts are unchanged and explicitly reused. Earlier SDK/value/engine reports remain historical, rather than being presented as fresh host verification. Only the host write handler and existing atomic-request fixture changed since the previous evidence snapshot. The JSON ledger binds current source, contracts, artifacts and reports. No full implementation or release gate is closed.


## Transaction read-data validation, 2026-09-13

Four S1/S2 red/green cycles reject missing read data, a missing JSON field, malformed JSON and scalar serialized document roots. Every red returned aborted instead of invalid-argument, misclassifying malformed requests as conflicts. The unchanged assertions now require invalid-argument, no mutation, and continued shared-state access through both clients' normal SDK calls. Reports and immutable input snapshots use `/tmp/pyric-wire-read-data-`, `/tmp/pyric-wire-read-json-type-`, `/tmp/pyric-wire-read-json-syntax-`, and `/tmp/pyric-wire-read-root-`; each pair retains identical command and fixture bytes.

The host validates the data envelope and JSON field, decodes client data before conflict comparison, and reuses the existing encoding check and document-root validator. Null remains the missing-document representation. The current remote transaction implementation echoes the worker's original serialized envelope, including its encoding metadata; this is source evidence, not a new remote runtime proof. Separate review consolidates test read-data payloads into one declarative map used by both transport adapters. The 34-case atomic/path review passes. Six additional cases began green: four SharedWorker counterparts and both unsupported-read-encoding cases. Full nested-value schemas, qualified identity, write options, admission and resource bounds remain open.

Final reports use `/tmp/pyric-wire-read-data-final-`: 319 browser scenarios in 35 hosted-fixture files, five Studio/SharedWorker scenarios and the 539-test baseline pass. Strict CLI/public fixture types, 143-file code form and all four browser budgets pass. The CLI was rebuilt; unchanged Pyric and embedded Studio artifacts are explicitly reused after digest verification. Earlier SDK/value/engine reports remain historical. Only the host write handler and existing atomic-request fixture changed since the previous source snapshot. The JSON ledger binds current inputs, artifacts and reports, including four red/green pairs. No full implementation or release gate is closed.


## Hosted reconnect and RTDB disconnect intent: partial S1/S2 lifecycle evidence

The pending reconnect cycle has valid red/green evidence: an identity-protected
Firestore listener retained its old value after socket loss, then passed the
unchanged assertion after the client and host retained its logical session.
The grant is private to the connection and excluded from consumer presence.
Review names the attachment-history flag and preserves backoff timing.

A second cycle demonstrated RTDB disconnect intent being delayed until session
expiry: the other browser read `online` when `offline` was required. The bridge
now reports interruption, and the host drains its existing RTDB disconnect queue
after accepted work without removing Auth. The unchanged test passes. Separate
review extends the case through reconnect, another write and app deletion; a
fresh observer reads the later value, proving consumed intent did not rerun.
The lost-ack case also reads count `1` through the resumed app and another client.

Red/green transcripts and input snapshots use `/tmp/pyric-reconnect-listener-`
and `/tmp/pyric-rtdb-socket-loss-`. Two initial reconnect fixture setup mistakes
were corrected before valid red evidence; they are not product failures or TDD
reds. The seven-case reviewed lifecycle report is
`/tmp/pyric-reconnect-rtdb-reviewed-browser.log`.

Final reports use `/tmp/pyric-reconnect-final-`: 321 browser scenarios across
37 files, five rebuilt Studio/SharedWorker cases, 539 baseline tests in 72
isolated processes, and 16 additional bridge tests in four processes all pass.
The additional bridge suite initially could not listen inside the sandbox;
that diagnostic is preserved at `/tmp/pyric-reconnect-bridge-sandbox-error.log`.
The unchanged suite passed with local networking enabled. Strict CLI and public
fixture types pass, 146 changed TypeScript files have zero code-form issues,
and all four browser leaves remain within their declared budgets. CLI and
Studio were rebuilt; identical Pyric source/artifacts were reused explicitly.
Fresh origin/main remains `e207262f`, contained by HEAD `ecd73fe0`.

This is partial 3B–3D evidence. RTDB `.info/connected` still returns a fixed
value. Heartbeat detection, tenant/lens and other-service restoration, malformed
or stale session access, expiry/resource bounds, interrupted subscription
creation and complete boot/shutdown accounting remain required. The full
hosted/live implementation and release gates remain open. Current source,
contract, toolchain, artifact and report identities are recorded in the JSON
ledger; earlier snapshots remain historical.


## RTDB connectivity listeners: three S1 red/green cycles

A normal .info/connected listener previously stayed true after physical socket
loss. The socket now exposes connection observation through its ClientPort;
the RTDB adapter uses its existing snapshot and listener registration helpers.
The unchanged loss/recovery test passes. An additional explicit-control test
exposed goOffline leaving the listener true. RTDB now owns a networkEnabled
choice per logical port and combines it with physical connectivity. A third
test caught the new local path delivering to a listener created after app
deletion; the existing deleted-port refusal now protects that path as well.

Red/green transcripts and input snapshots use `/tmp/pyric-rtdb-connectivity-`,
`/tmp/pyric-rtdb-connectivity-controls-`, and
`/tmp/pyric-rtdb-connectivity-deleted-`. Each has the same fixture bytes and
command between red and green. The initial strict build's optional-method
narrowing diagnostic is preserved separately and does not count as red.

Separate review names the app-controlled state networkEnabled and tests
per-client isolation, explicit offline choice surviving reconnect, SharedWorker
controls, and unsubscribe/onlyOnce in both transports. Thirteen focused cases
pass, including six existing reconnect/disconnect/deletion regressions. The
reviewed report is `/tmp/pyric-rtdb-connectivity-reviewed-browser.log`.

Final reports use `/tmp/pyric-rtdb-connectivity-final-`: 328 browser scenarios in
38 files, five rebuilt Studio/SharedWorker cases and 539 baseline tests in 72
isolated processes pass. Strict CLI and public fixture types pass. All 149
changed TypeScript files have zero code-form issues, and the four declared
browser leaf budgets pass. CLI and Studio were rebuilt; identical Pyric source
and artifacts are explicitly reused. The JSON ledger binds these results to
current source, contracts, toolchain, lockfile and artifacts.

These checks establish the declared .info/connected listener cases. Parent
.info snapshots, one-shot metadata reads, in-page connectivity, complete host
offline semantics, heartbeat/expiry, stale-session access and full resource
accounting remain required. Earlier bridge, SDK/value/engine and tool reports
remain historical unless freshly listed. The full implementation and release
gates remain open.


## RTDB parent metadata and in-page controls: two S1 cycles

The parent metadata red expected connected:false after goOffline but received
connected:true. The worker adapter now constructs both parent metadata and
its connected child from the existing connectivity observer. A second red
showed the in-page connected listener remaining true after goOffline. The
in-page adapter now observes its existing RtdbConnectionLifecycle and owns the
registration through the existing listener registry and app cleanup callback.

The paired transcripts and input snapshots use
`/tmp/pyric-rtdb-parent-metadata-` and
`/tmp/pyric-rtdb-inpage-connectivity-`. Each red/green pair retains identical
fixture bytes and its exact command. TypeScript errors encountered during
implementation/review are separate build diagnostics, not red evidence.

Review snapshots mutable registrations and optional priority values before
narrowing, names the lifecycle class's branch decisions, and replaces
work-performing ternaries in onValueInternal with explicit branches. Five
additional cases began green: parent metadata in SharedWorker and in-page
execution, in-page unsubscribe/onlyOnce, and deleted-app refusal in
SharedWorker and in-page execution. Fourteen connectivity cases and six other
lifecycle cases pass in `/tmp/pyric-rtdb-metadata-final-focused-browser.log`.

Actual Firebase 12.13.0 SDK probes used goOffline before reads and an isolated
localhost emulator endpoint; no backend was started. The first probe shows
onValue/onlyOnce delivering metadata while both get calls are still pending
at a one-second observation deadline. This is neither a connected-backend
result nor an indefinite-pending claim. The sandbox retains its established
parent serverTimeOffset of zero; the real SDK parent before first connection
contains only connected:false. The second probe returns only connected:false
and the iteration key connected for an orderByKey/equalTo metadata query.
That supplies an independent expectation for the next implementation slice.
Scripts and reports are bound in the JSON reference records.

Final reports use `/tmp/pyric-rtdb-metadata-final-`. All 335 browser scenarios
in 38 files, five Studio/SharedWorker cases, 539 baseline tests in 72 isolated
processes and 508 RTDB tests in 63 isolated processes pass. Strict Pyric, CLI
and public fixture types pass; 151 changed TypeScript files have zero
code-form issues; all four browser leaf budgets pass. Pyric, CLI and Studio
were rebuilt, and the identical site tree is embedded in the CLI. Fresh
origin/main is still e207262f and is contained by HEAD ecd73fe0.

The metadata query gap is concrete: the worker observer currently ignores
query constraints, while in-page constrained queries retain the old fixed
backend metadata path. Filtering and connectivity transitions need their own
red/green proof next. Reset/import, full host offline behavior, heartbeat,
expiry, stale-session admission and complete resource accounting remain open,
as do the rest of the hosted/live implementation and release requirements.
Earlier additional bridge, SDK/value/engine and tooling reports remain
historical unless freshly listed. No full gate is closed by this snapshot.


## Filtered RTDB metadata: four S1 cycles and a shared projection

The hosted filter red returned serverTimeOffset even though the query selected
only connected. The in-page red selected the correct field but stayed true
after goOffline. Both adapters now apply the existing query projection to
parent metadata from their connection owner. Two further reds each delivered
the same serverTimeOffset selection three times during an offline/online
cycle. Existing equality functions now suppress unchanged selected rows.

Red/green transcripts and input snapshots use `/tmp/pyric-rtdb-query-hosted-`,
`/tmp/pyric-rtdb-query-inpage-`, `/tmp/pyric-rtdb-query-stable-hosted-`, and
`/tmp/pyric-rtdb-query-stable-inpage-`. Each pair preserves its command and
fixture bytes. Review parameterizes the original assertions and adds eight
characterizations: SharedWorker parity, empty selected results and scoped off
preserving the parent listener. All twelve query cases and twenty existing
lifecycle cases pass in `/tmp/pyric-rtdb-query-review-browser.log`.

Commit 1eb24f46 extracts the unchanged projection into a shared internal leaf
and retains the backend exports. All 508 RTDB tests pass before and after the
move. Separate review names its branch decisions and removes nested ternaries;
508 regressions pass again. Commit feb8992c moves only the query types and
re-exports to remove a type-only dependency cycle. A compiler audit verifies
identical emitted JavaScript for both affected files. The named-decision edits
and feature behavior were excluded from that mechanical commit.

The projection owns no runtime imports or resources. A scoped AST import audit
includes type-only edges and finds no cycle among the backend query facade,
projection and JSON value definitions. This is not a repository-wide graph
proof. A dedicated RTDB listener budget was declared at 32 KiB before its first
measurement and added to the existing CI check. Its final output is 12,930
bytes, including the shared projection, with no forbidden imports. The older
worker barrel does not export these listeners; its unchanged size alone could
not have established this boundary. The checker and its engine exclusions
remain unchanged; all 13 checker tests pass.

Final reports use `/tmp/pyric-rtdb-query-final-`. All 347 browser scenarios in
39 files, five rebuilt Studio/SharedWorker cases, 539 baseline tests in 72
isolated processes, and 508 RTDB tests in 63 isolated processes pass. Strict
Pyric, CLI and public fixture typechecks pass. All 155 changed TypeScript files
have zero code-form findings, and all five browser budgets pass. Pyric, CLI and
Studio were rebuilt; the embedded site matches the rebuilt site tree. Fresh
origin/main remains e207262f and is contained by HEAD feb8992c.

The earlier offline SDK probes remain unchanged independent references; they
were not rerun or relabeled as new runtime evidence. Scalar metadata queries,
remaining constraint/lifetime combinations, separate get semantics, reset and
import, complete host offline behavior, heartbeat/expiry, authority and
persistence, full resource accounting and live execution remain unfinished.
The next reset integration check should verify that a service-scoped CLI
reset invalidates pending RTDB disconnect work; the current handler's root
remove is not evidence of a generation change. All full implementation and
release gates remain open.


## RTDB replacement boundaries, 2026-09-13

Origin/main advanced to `548e50a76349f357d04c13e17ffcaf05d43b584f` and was merged at `a99a06a55a29e75fd42bcb844a8065a781fa44c7`. Git reapplied tracked work successfully; all pre-merge untracked file digests were unchanged. Current candidate evidence uses this main revision as its source and code-form baseline. Earlier red/green snapshots retain their original input identities.

The new fixture uses S1 and S2: normal served Firebase SDK imports and actual consumer-wire export/import/checkpoint/reset operations. One browser registers disconnect intent; another observes the shared data. After replacement, a real socket loss is followed by resumed app deletion. The acknowledged deletion precedes a fresh observer's final read, so the assertion does not race an unfinished disconnect drain.

| Cycle | Relevant red observation | Unchanged green |
| --- | --- | --- |
| Import | The restored `saved` value became `obsolete` after the old connection ended. | The restored value survives. |
| Checkpoint restore | The saved checkpoint was overwritten by old disconnect intent. | Restored checkpoint data survives. |
| Unrecognized import | An invalid bundle returned success and replaced state. | Import refuses before replacement; existing disconnect intent still executes. |
| Full reset | A fresh SDK observer received `PERMISSION_DENIED` because reset removed the deployed RTDB rules. | It reads the empty state under the retained rules. |

Each pair has a command, assertion-failure transcript, unchanged fixture digest between red and green, source/artifact snapshots and exit statuses. Prefixes are `/tmp/pyric-rtdb-import-`, `/tmp/pyric-rtdb-restore-`, `/tmp/pyric-rtdb-invalid-import-` and `/tmp/pyric-rtdb-reset-rules-`. An initial fixture endpoint timeout and intermediate TypeScript failures were corrected before the valid pair evidence; they are not behavioral red/green results.

The host now cancels registered disconnect queues through one sandbox-owned reset subscription. Import, checkpoint restoration and full reset reuse that boundary. Caller-specific clearing was removed. The sandbox's disposal clears the subscription. RTDB reset clears data and priorities while retaining rules; state restoration continues to adopt imported rules. The import guard uses the existing parser's unrecognized-bundle result before destructive replacement. Review checks fresh disconnect intent and both allowed and denied SDK reads after replacement. The modified persistence class also removes redundant assertions and boolean staging while preserving its serialized representation.

Final reports use `/tmp/pyric-rtdb-replacement-final-`: 352 browser cases in 40 files, five isolated SharedWorker/Studio cases, 539 worker/bridge tests in 72 processes, 508 RTDB tests in 63 processes, and 17 tests from the merged Flow change in four processes. The upstream self-hosted Flow browser test also passes with a separate output directory and no reused server. Strict Pyric, CLI and fixture types pass. The code-form check reports 160 files and no issues. All five browser budgets pass unchanged. Pyric, CLI and the 134-page Studio/site artifact were rebuilt; the embedded site tree matches exactly.

These results are partial 3D and import-refusal evidence. Already-running operations crossing reset, metadata reset notifications, explicit replacement scenarios in SharedWorker/in-page execution, and service-scoped reset remain unproven. Service CLI commands currently refuse a running serve and use a separate in-process sandbox; hosted command/MCP attachment remains required. Nonempty malformed bundles, versions, checksums and complete service schemas still need validation before import. Complete persistence, admission, resource, live-execution and release gates remain open.


## Stdio MCP discovery context, 2026-09-13

The previous ownership candidate remains historical. Fresh origin/main is
`548e50a76349f357d04c13e17ffcaf05d43b584f`, already contained by HEAD
`a99a06a55a29e75fd42bcb844a8065a781fa44c7`. Existing local changes were preserved.

Two S2/S3 behavior cycles use the real CLI stdio transport and HTTP MCP endpoint:

| Cycle | Relevant red observation | Unchanged green |
| --- | --- | --- |
| Copied discovery pointer | MCP initialized successfully against another project's host. | Initialization refuses with the project diagnostic; the original host remains usable. |
| Replacement after discovery | A proxy initialized successfully against a replacement host on the same address. | The stale proxy receives an instance-change error; fresh discovery can initialize and list tools. |

Exact commands and source/test/artifact snapshots use
`/tmp/pyric-hosted-stdio-project-{red,green}` and
`/tmp/pyric-hosted-stdio-instance-{red,green}`. Each red/green pair retains the
same fixture digest and behavioral assertion. The first instance-green launch
was rejected by automatic approval review before a process started; the same
command later executed successfully. No usage reset was consumed. Setup/type
failures and the rejected launch are not behavioral red evidence.

Discovery returns the canonical directory containing the selected pointer.
The proxy forwards it with the pinned host instance on every request. The
endpoint validates them after Host/Origin checks and before session creation or
lookup. Separate review replaces broad JSON-RPC casts and non-null assertions
with type guards, names selector/relay decisions, and corrects comments that
mistook a pointer for project ownership. Twenty-seven selection/address
regressions passed before and after that review. The new validation leaf
imports only node:fs; it introduces no return dependency into the proxy or mount.

Four additional stdio cases are characterization: browser-written data is
visible through MCP; subdirectory and symlink callers attach correctly; a
Unicode workspace root discovers its frontend host. All six cases also pass
on Node 22.15.0. Three copied-standalone scenarios pass, including writing via
stdio into the browser's host and refusing a copied pointer. The packaged case
began green and is not an invented TDD cycle.

Final combined verification passed under `/tmp/pyric-hosted-stdio-final-`:
389 browser scenarios, five Studio cases, 656 affected regressions, strict
types, 178-file code form and all five browser budgets. The source/artifact
evidence snapshot records these completed runs and the packaged/runtime cases.

These headers validate discovery context, not client authentication. Explicit
endpoint clients retain existing Host/Origin policy; older servers may ignore
the headers. Full admission/version negotiation, proxy resource bounds and
uncertain-write errors, all writer entry points, authoritative persistence,
bounded observations and complete browser/hosted live execution remain required.
No full subsection or release gate is closed by these cases.
