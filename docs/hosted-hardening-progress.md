# Hosted sandbox hardening

Base: `6b0728b830faa788b53ea97fc764f5c3397fe14d` on `hosted-live-mode`.
This bounded milestone leaves the broader hosted/live-mode goal incomplete.
Use the already approved S1–S6 seams, vertical TDD, and applicable universal gates.
Do not modify the manual demo project. Commit and push each verified slice.

## Ordered queue

1. Anonymous UID uniqueness — verified locally. Deletion/restart cannot transfer UID-owned data to a new identity; retained accounts preserve their UID, claims, creation time and last-login time.
2. Session retention expiry — verified locally. The original app obtains fresh admission after the retention window, with Auth restored before listeners. Expired/invalid grants remain refused; app deletion cancels recovery; uncertain writes never replay.
3. Checkpoint restoration — verified locally. Account/Storage metadata, Firestore typed values and literal maps survive the scoped round trips and host restart. Corrupt service inputs refuse before reset; legacy records and branch consumers retain their value semantics. Broader atomicity/concurrency gaps remain explicit.
4. Restoration diagnostics — verified locally. Startup text and readiness JSON count bucketed documents and controller Auth accounts correctly, including Auth-only and fresh state.
5. Interrupted recovery — verified locally. A second interruption restores the original identity and one listener; delayed old-socket events cannot overwrite or disconnect the recovered app, and deletion during Auth restoration cancels recovery.
6. Reset/import with active apps — verified locally. Hosted and default SharedWorker listeners follow replacement without reviving unsubscribed listeners; paused transactions retry against replacement state. Complete portable imports restore Storage bytes/metadata and await durable persistence, including an older asynchronous save and hard restart.
7. Persistence-failure recovery — verified locally. Failed writes report uncertainty; mutations remain refused even after permissions are repaired. Restart restores durable documents/Storage bytes, the original app does not replay its uncertain increment, and new writes succeed.
8. Malformed requests — in progress. Invalid outer JSON/envelope kinds, worker envelopes and non-string browser worker request/subscription IDs reject before dispatch. Unsupported handshake versions refuse without admitting consumers or replacing the SharedWorker peer; buffered frames cannot operate after refusal. Healthy apps remain usable and recoverable protocol errors permit reconnect. Known-frame/legacy relay payloads, reply version validation and size/depth boundaries remain open.
9. Lifecycle cleanup — pending. Repeated startup failures, interrupted initialization, reconnect, deletion and shutdown release resources and ownership.
10. Sleep/resume with delayed disconnect notification — pending. An expired host session recovers even when the browser observes the interruption late; invalid grants remain refused and uncertain writes never replay.
11. Identity and tenant isolation across clients — pending. Switching or signing out in one app cannot change another app's identity, tenant, claims or Rules access, including after recovery.
12. RTDB disconnect behavior — pending. Connectivity signals and registered disconnect operations follow the declared session-lifetime contract across transient loss, expiry and explicit app deletion.
13. Concurrent transactions and atomic writes — pending. Two clients contend through normal SDK calls without lost updates; rejected batches remain atomic and ambiguous acknowledgments do not trigger transport replay.
14. Packed installation and runtime selection — pending. An isolated consumer uses the built package through served imports and Vite cold/warm startup, reload and HMR; default SharedWorker, explicit hosted and in-page select their intended implementation.
15. Origin and project admission isolation — pending. An unrelated browser origin or another project's discovery/session credentials cannot attach to, inspect or mutate this host; intended clients still connect.
16. Slow-client isolation and bounded event delivery — pending. A stalled Studio/event consumer cannot exhaust retained queues or starve another app's SDK operations; overflow and lost history remain explicit.
17. Rules hot reload with active apps — pending. Valid Rules changes update enforcement and active listeners according to the existing service contract; invalid edits report their failure without falsely claiming successful enforcement.
18. Client/host version compatibility — pending. Actual packed consumers within the declared compatibility range work against the candidate host; unsupported combinations refuse clearly before mutation and never silently select another runtime.
19. Fault diagnostics and redaction — pending. Existing CLI, runtime and Studio diagnostics distinguish connection, restoration and persistence failures while excluding credentials and private document contents from default support output.
20. Combined verification and morning handoff — pending. Current affected matrix, runtime parity, types, source form, applicable packaging; fixes, reports, remaining failures and manual QA steps.

### Added follow-on gates

These five additions extend the ordered queue; they do not promise overnight completion or expand it into hosted live-mode implementation. Finish the current verified slice before advancing. Reuse existing evidence when its inputs and assertions cover the requirement; reproduce a failure before changing implementation.

| Item | Prerequisites | Required evidence before completion |
| --- | --- | --- |
| 10. Delayed disconnect | Session expiry and interrupted recovery (2, 5) | Separate host expiry from browser notification in a public lifecycle fixture. Prove recovery of the original valid identity and listeners, a subsequent authorized write, invalid-grant refusal and absence of mutation replay. An observed-interruption clock test alone is insufficient. |
| 11. Identity isolation | Identity, recovery and active-app replacement (1, 5, 6) | Two independent browser contexts with distinct users/tenants exercise allowed and denied SDK operations before and after one changes identity and reconnects. Assert each client's resulting user/token and downstream Rules decision; compare SharedWorker behavior where applicable. |
| 12. RTDB disconnect | Recovery and cleanup (5, 9, 10) | Public SDK observers and a second client verify `.info/connected`, disconnect execution timing, cancellation and absence of duplicate effects across transient loss, expiry and deletion. Resolve expected behavior against the existing support contract before writing assertions. |
| 13. Concurrent writes | Persistence failure and request validation (7, 8) | Two clients produce a real transaction conflict and the expected committed result through SDK retry semantics. A rejected batch changes no documents. A lost-acknowledgment fixture proves the transport does not replay a non-idempotent mutation. Reuse existing engine semantics rather than adding another scheduler. |
| 14. Packed consumer | Completed source fixes and cleanup (9) | Install the actual package in an isolated directory outside the workspace. Verify selected runtime and an SDK write/listener round trip through served imports and Vite, including reload/HMR without duplicate delivery. Run applicable minimum-Node and browser-boundary checks; retain package identity and commands so final verification can reuse this evidence. |

Every item also requires the advancement checks below. Broader redesigns discovered by these probes are recorded separately, with the failing scoped requirement left open. At the stopping point, perform the final verification and handoff for completed slices even if later queue items remain untouched.

### Second five additions

Items 15–19 extend the existing queue at the user's request; final verification moves to item 20. They audit existing hosted behavior and do not expand live-mode implementation. Current work and its prerequisite order remain intact. These are completion conditions, not claims that failures have already been reproduced.

| Item | Prerequisites | Required evidence before completion |
| --- | --- | --- |
| 15. Admission isolation | Request validation and packed consumer (8, 14) | Through real browser/socket and CLI discovery boundaries, try an unrelated origin, another project's discovery record and a grant issued by another host. Prohibited attempts refuse before exposing state or changing data; an authorized client still completes a write/listener round trip. Record the existing admission policy and test supported configurations without broadening network exposure. |
| 16. Slow-client isolation | Request bounds and cleanup (8, 9) | Stall one event consumer while another app performs SDK operations. Before implementation, record workload, configured queue/history bounds, duration sufficient to reach those bounds, and numerical memory/latency budgets. Measure bounded retention and healthy-client responsiveness, assert the declared overflow/gap signal, then verify disconnect cleanup. A short happy-path run or undefined budget cannot pass. |
| 17. Rules hot reload | Active-app replacement and identity isolation (6, 11) | Edit real fixture Rules files while two clients retain listeners. Check allowed and denied SDK operations before and after valid changes, listener behavior, an invalid edit and subsequent repair. Preserve each service's established invalid-source policy; do not assume every service retains its last valid Rules. Assert diagnostics agree with actual enforcement and compare supported SharedWorker behavior. |
| 18. Version compatibility | Packed installation (14) | Record the supported client/host version range first. Install representative actual artifacts in isolated consumers, retaining versions and package hashes. Supported combinations pass Auth, SDK write/listener and reconnect checks. Unsupported combinations produce an actionable compatibility error before mutation or runtime fallback. Malformed-version frame coverage from item 8 alone is insufficient; this does not create a new backwards-compatibility promise. |
| 19. Fault diagnostics | Restoration, persistence recovery and event delivery (4, 7, 16) | Induce connection refusal, restoration failure and persistence failure in disposable fixtures. Existing public diagnostics identify the selected runtime and failing stage without contradicting SDK outcomes. Seed recognizable credential and private-data markers; verify default diagnostic/support output excludes them and recovery clears stale failure status. Reuse existing surfaces rather than introducing a new telemetry system. |

Apply the same approved seams, vertical TDD and universal gates to these additions. Reuse matching existing evidence; a characterization that already passes needs no invented fix. If the night ends earlier, prepare item 20's handoff for completed slices and explicitly list untouched items. Production Firebase and the manual demo remain outside this work.

## Advancement requirements

Each behavioral change needs an actual public-boundary red and unchanged-fixture green, separate review, current affected regression results, strict production/fixture types, and changed-code form. Runtime and browser-boundary checks apply to the touched owner. Existing passing coverage may be reused only with matching inputs and scope. Larger architectural gaps remain explicitly open; they do not waive a failed scoped acceptance test.

## Evidence

The previous planning turn changed no implementation. Initial inspection confirms the clean worktree and exact pushed base above. Task 1 begins at normal served SDK imports plus the public remote admin and real host lifecycle (S1/S2/S3).

### U3 tooling prerequisite

Editing one Auth method exposed a checker mismatch with U3's modified-function scope: the checker rechecked every untouched method in the enclosing class. The checker now explicitly records unchanged class members only when the class header is unchanged. Modified members remain checked in full; new classes and changed headers retain whole-class checking. This changes no U3 code-form rule and adds no source-specific exemption. The broad Auth backend split remains separate from the user-authorized narrow repair.

The S6 scope regression failed before the correction (`/tmp/pyric-hardening-class-scope-red.log`: 12 pass, 1 fail) and passed unchanged afterward (`/tmp/pyric-hardening-class-scope-green.log`: 13 pass). Review covers constructors, field initializers, accessors, static blocks, changed headers, duplicate members and added suppressions. Final checker/API/CLI/CI tests pass 28 cases in 8.61 seconds; strict tool types and the current changed-code check pass. Reports: `/tmp/pyric-hardening-class-scope-review.log`, `/tmp/pyric-hardening-class-scope-types.log`, `/tmp/pyric-hardening-uid-code-form-review.json`.

### Task 1 verification

The normal SDK regression twice reproduced both `anonymous-1` reuse and access to the deleted user's owner-only document. A public Auth probe reproduced the repeated UID in two independent sandboxes without browser or persistence involvement. UUID allocation in the existing shared anonymous factory passes the unchanged original regression (4.6 seconds total); the retired counter is removed. No new runtime branch, dependency, persistence schema or resource owner is introduced.

An initial retained-account fixture incorrectly reused its saved browser session; explicit SDK sign-out corrected that setup. The corrected test then exposed a real persistence defect: creation time changed and last-login time became null. A second unchanged-fixture red/green cycle now preserves both through the existing export/seed contract and state codec. The new fields are optional so legacy seeds remain readable. Existing exact-shape export tests now explicitly expect the additional timestamp fields and retain their other assertions.

Final scoped verification, all terminal and without retries:

| Check | Result | Report |
| --- | --- | --- |
| Identity, restart/admission, Auth durability, legacy seeds, checkpoints, three runtime paths | 32 passed in 1.1 minutes | `/tmp/pyric-hardening-identity-final-browser.log` |
| All six identity cases under Node 22.15.0 | 6 passed in 16.3 seconds | `/tmp/pyric-hardening-identity-minimum-node.log` |
| Auth, app registry, persistence, worker identity and state codec | 487 passed, 42 isolated files, zero skips | `/tmp/pyric-hardening-identity-final-regressions-corrected.log` |
| Pyric, CLI, hosted fixture strict types | Passed | `/tmp/pyric-hardening-identity-final-{pyric,cli,fixture}-types.log` |
| Code form from milestone base | Eight TypeScript files, zero findings | `/tmp/pyric-hardening-identity-final-code-form.json` |
| Browser client / live entry | 54,943/98,304 and 387,843/524,288 bytes; zero boundary findings | `/tmp/pyric-hardening-identity-browser-{client,live}.json` |

Red/green logs, fixture copies and current input hashes are archived in `ignored/hardening/uid/`. The initial Chromium sandbox refusal, incorrect saved-session fixture, and nonexistent state-test path are retained as setup/review failures, not behavioral red evidence. The corrected final regression invocation uses `packages/cli/test/serve/state-store.test.ts`.

No new resource owner, Buffer/browser fallback, or conformance registry row was added. Existing Rules evaluation is exercised through both allowed and denied public SDK reads/writes. The copied standalone artifact and whole feature/release gates remain unverified; final milestone integration will cover applicable packaging. The manual demo was not changed.

## Remote backup

Tooling commit `506c0383` is local. Automatic approval review rejected its push twice, requiring direct user authorization despite the active goal's explicit push instruction. An asynchronous approval question is pending for this and subsequent verified hardening commits. Continue independent local work; do not bypass the rejection or claim the branch is remotely backed up beyond `6b0728b8`.

Identity task commit: `9b418216627fa53d892dbc0580d7e51b0db2616b`, also local pending push authorization.

## Task 2 verification

`bun x playwright test --config packages/cli/test/e2e/hosted/playwright.config.ts session-expiry.pw.ts` failed at the intended SDK listener assertion: expected `After expiry`, received `Before expiry` after the real 60-second host retention window. The isolated fixture drops attach frames for 62 seconds, keeps another remote consumer writing, then permits reconnection. It also requires a subsequent owner-authorized write, the original UID, and no new anonymous account. Report: `/tmp/pyric-hardening-session-expiry-red.log`, terminal exit 1 (`4cd3d4`). The unchanged fixture passed after the repair (`/tmp/pyric-hardening-session-expiry-green.log`, terminal exit 0 `381fc1`). The original fixture and reports are preserved in `ignored/hardening/session-expiry/`.

The client previously retried the expired grant and treated its refusal as terminal. It now measures the observed interruption with the monotonic browser clock across connection attempts, discards the resume grant after the shared 60-second policy window, and explicitly requests fresh admission. The existing restoration owner configures Auth before observers and operations. A failed fresh attempt keeps retrying; a protocol refusal remains terminal. The host's resume validation and resource-expiry behavior are unchanged. No secrets are persisted and no second session owner is introduced.

Review added a direct old-grant refusal after the real window and four short browser-clock cases: deleted user, deleted app, invalid grant, and a failed first fresh-admission attempt. The clock cases exercise client decisions; the real-clock case separately proves the host actually expires the old grant.

Final current checks: 26 focused browser cases in 2.0 minutes, four short cases on Node 22.15.0 in 10.3 seconds, 59 session/relay regressions in six isolated processes, strict CLI/fixture types, four-file code form with zero findings, and three browser boundaries. Socket: 7,259/16,384 bytes; worker client: 54,943/98,304; RTDB listeners: 12,930/32,768. Reports use `/tmp/pyric-hardening-session-expiry-`; archived input hashes bind them to the source and emitted CLI files. The minimum-Node run did not repeat the long real-clock scenario. Whole-feature and copied-standalone checks remain reserved for the final milestone join.

## Task 3: Auth refresh slice

The all-service checkpoint probe reached restore after correcting two fixture assumptions: use modular `reload(user)` and the supported RTDB snapshot `priority` property. Its actual restore assertion exposed stale Auth claims and regenerated Storage metadata. These are separate failures; the combined round trip remains open.

Minimization showed that claim reads without reload already worked. The worker's shared refresh helper wrote the session's old token claims into the account before re-minting it. Thus reload could undo both an admin revocation and a restored checkpoint. The helper now reads the stored account and keeps the port tenant, removing the stale write and conditional spread. Email/password refresh use the same correction. No new service, adapter, dependency, resource owner or runtime decision is introduced.

`bun x playwright test --config packages/cli/test/e2e/hosted/playwright.config.ts checkpoint-auth.pw.ts` reproduced expected `saved`, received `changed` after restore and reload (`/tmp/pyric-hardening-checkpoint-auth-red.log`, exit 1). The exact fixture then passed unchanged in 3.9 seconds (`/tmp/pyric-hardening-checkpoint-auth-green.log`, exit 0). Both fixture and logs are archived in `ignored/hardening/checkpoint/`. Earlier passing minimization probes and the pre-restore reload failure are diagnostic evidence, not the final red/green pair.

That review labeled all three refresh operations as hosted, default SharedWorker and in-page, but the runtime-selection correction below withdraws the old in-page claim (those cases ran SharedWorker): the SDK sees the revoked claims, retains its tenant, fails a protected write, and the public admin account retains the revocation. Final affected checks pass 33 browser cases in 54.4 seconds, ten minimum-Node cases in 17.2 seconds, and 57 regressions in four isolated files. CLI and fixture strict types pass; changed-code form has zero findings. Reports use `/tmp/pyric-hardening-checkpoint-auth-`. The source change is confined to the host helper; browser leaves and shared SDK implementation are unchanged. Applicable packaging remains at the final join. This slice does not close the all-service checkpoint or corruption requirements.

Auth refresh commit: `87c7e951`, local pending push authorization.

## Task 3: Storage round-trip slice

After the Auth repair, the original all-service test still failed only on Storage generation and timestamps. The minimized supported-SDK probe also showed that `cacheControl` disappeared. Capture retained only a few upload fields, and apply used a new upload that regenerated object metadata. The shared full-state owner now uses the existing lossless Storage persistence functions. Optional extra metadata and Blob type preserve current records; legacy records retain their upload-based compatibility path. Existing path ordering is unchanged. This adds no runtime selection, new persistence engine, service owner or base64 implementation.

The minimized regression failed at the metadata equality assertion (`/tmp/pyric-hardening-checkpoint-storage-minimal-red.log`, exit 1). Both it and the original four-service regression passed unchanged in `/tmp/pyric-hardening-checkpoint-storage-green.log` (two cases, 10.8 seconds). The first attempted minimized fixture called the explicitly unsupported served `updateMetadata`; that setup failure is not the behavioral red. The final fixture uses supported upload metadata.

Review verifies exact metadata and bytes, removal of newer objects, legacy checkpoint records, all three runtime paths, exact public account metadata immediately after restore, and SDK state after SIGKILL/restart with credential sign-in. Final checks pass 30 affected browser cases in 51.6 seconds, five minimum-Node cases in 12.9 seconds, and 117 full-state/checkpoint/branch/Storage regressions in eleven isolated files. Strict Pyric/CLI/fixture types pass; three-file source form and client/live browser boundaries have zero findings (54,943/98,304 and 387,843/524,288 bytes). Reports use `/tmp/pyric-hardening-checkpoint-storage-`; current hashes and original fixtures are archived in `ignored/hardening/checkpoint/`.

The full-state contract covers the default Storage bucket. Arbitrary-bucket checkpoint coverage, coherent concurrent capture, all-service atomic apply and branch-promotion metadata fidelity are not established by this slice. Corrupt-state refusal is still the next scoped requirement; task 3 and the milestone remain incomplete. The manual demo is unchanged.

Storage round-trip commit: `0c834446`, local pending push authorization.

## Task 3: Corruption refusal slice

The first public SDK regression proved a failed restore had already erased the current document: malformed `auth.users` reached the service only after the sandbox reset. Seven sequential red/green cycles cover account arrays, other service containers, account/object records, corrupt bytes/Storage rules/RTDB envelopes, empty paths and incorrect byte lengths, invalid checkpoint counts, and a slash-only path that normalizes to the bucket root. Original fixtures and each red/green pair are retained in `ignored/hardening/checkpoint/corruption-*.{log,pw.ts.txt}`; their commands are in the reports.

The restore owner now validates the serialized state before reset. The existing host account and object metadata schemas moved unchanged into `sandbox/internal/state-schemas.ts`, used by both host state and checkpoints. The 78-line checkpoint validator composes those schemas with the existing Storage path normalizer, byte decoder and rule compiler. Envelope validation requires finite timestamps and nonnegative integer counts. This adds no dependency, persistence owner, rollback engine or new runtime branch.

A diagnostic initially treated invalid Firestore syntax as corrupt state. Source inspection showed this is deliberately allowed during rule editing: Firestore installs the source and reports lint errors. That probe remains archived as `content-contract-probe.*`; it is not counted as a valid corruption red. A separate compatibility test saves and restores an intentionally invalid Firestore source. Storage differs: its normal setter compiles before installation, so an unparseable saved Storage source must refuse before state replacement.

Final verification is terminal, with no retries or skipped cases:

| Check | Result | Report |
| --- | --- | --- |
| Corruption, all-service round trip, Auth, Storage durability, legacy state and three runtimes | 45 passed in 1.2 minutes | `/tmp/pyric-hardening-checkpoint-corruption-final-browser.log` |
| Scoped corruption and checkpoint cases under Node 22.15.0 | 20 passed in 32.5 seconds | `/tmp/pyric-hardening-checkpoint-corruption-minimum-node.log` |
| State codec, checkpoints, branches and Storage persistence, 13 isolated files | 131 passed, zero skips | `/tmp/pyric-hardening-checkpoint-corruption-final-regressions.log` |
| Strict Pyric, CLI and fixture types | Passed | `/tmp/pyric-hardening-checkpoint-corruption-{pyric-build,cli-build,fixture-types}.log` |
| Changed code form | Eight TypeScript files, zero findings | `/tmp/pyric-hardening-checkpoint-corruption-form.json` |
| Client/live browser boundaries | 54,943/98,304 and 387,843/524,288 bytes; zero findings | `/tmp/pyric-hardening-checkpoint-corruption-browser-{client,live}.json` |

Every corruption case checks the healthy SDK document, the unchanged public account list, and a successful subsequent write. One also kills/restarts the host and checks the durable document. The SharedWorker path verifies empty bytes and all base64 padding remainders. Malformed-file fault injection is hosted; valid restoration is checked across all three runtimes. No production Firebase or manual demo data was used.

These checks establish structural corruption refusal and the specified object consistency checks, not detection of arbitrary edits that remain valid data. Atomic rollback after a later resource/I/O failure, concurrent capture, general input resource limits and arbitrary buckets remain separate gaps. Task 3 stays open until ordinary Firestore special values are checked; the existing full-service fixture currently uses plain document fields. Applicable packaging remains at the milestone join.

## Task 3: Firestore value fidelity — verified locally

The original SDK checkpoint tests lost Timestamp methods after restore. Full-state capture now uses the existing declared Firestore value encoding before JSON removes wrapper identity, and restoration decodes that declaration. Review reproduced a literal timestamp-shaped map being converted into a Timestamp; escaping ordinary maps with the existing codec fixes that without a second scalar codec. Full-state branch storage retains the declaration, and promotion decodes documents before writing them.

Two further public-boundary failures were reproduced and repaired. Malformed encoded bytes erased healthy state before restore failed; checkpoint validation now decodes Firestore inputs before reset. A plain SDK write followed by host restart converted a literal map into a Timestamp even without checkpoint operations; newly written persistence buckets now declare their value encoding individually. Legacy buckets retain their prior decoding contract, and bucket-level declarations allow old and newly flushed records to coexist.

The published in-process MCP branch interface exposed `literal.fields.note` in its diff instead of the actual field `literal.note`. Diff now decodes documents before walking fields. The first hosted MCP probes used operations that its tool surface does not expose and count only as setup failures. Review also corrected an invalid promotion expectation: promotion applies branch changes relative to its base, so an unchanged branch must preserve a later live edit. The field-path assertion is unchanged and passes; this fixture does not prove promotion of an actual changed typed value.

Current terminal checks: 42 affected browser cases passed in 1.1 minutes; the cases then labeled in-page actually selected SharedWorker, as corrected below; eight focused cases passed on Node 22.15.0 in 16.1 seconds; 107 regressions passed in eight isolated files; strict Pyric/CLI/fixture types, changed-code form and client/live browser boundaries passed. Reports use `/tmp/pyric-hardening-checkpoint-values-`, with source-bound copies in `ignored/hardening/checkpoint-values/`. The byte-corruption, literal-map restart and branch-path red fixtures are retained there. The minimized restart test is now named `checkpoint-literal-restart.pw.ts`; its behavioral assertions are unchanged.

Final compatibility review passes legacy full-state maps without an encoding declaration, mixed old/new persistence buckets after actual host restart, and changed-value promotion through persisted MCP branches. The promotion check uses a real unauthenticated read with installed Rules requiring a Timestamp at the specified instant and a literal map with its original fields. An initial Rules simulation had no seeded resource and was unsuitable for this assertion; the corrected read evaluates the actual promoted document. These are review checks, not additional claimed red/green fixes.

The three added review cases pass individually; the two branch cases plus legacy/mixed-bucket cases pass together under Node 22.15.0 (four cases, 7.0 seconds). Final fixture types and fifteen-file code form pass. Production and emitted input hashes match the preceding 42-case combined browser run, eight-case minimum-Node run, 107 regressions, production typechecks and browser boundaries, so that evidence is reused. `ignored/hardening/checkpoint-values/verified-inputs.json` binds the final inputs and reports. All processes are terminal, without retries or skipped cases.

Task 3's scoped round trips and corruption refusal are verified. Current readers accept legacy records; downgrade compatibility with older readers is not established. General checkpoint atomicity, coherent concurrent capture and arbitrary buckets remain separate. Applicable packaging remains at the milestone join. Later queue items are untouched; the manual demo has not been changed.

## Task 4: Restoration diagnostics — verified locally

The S1/S3 restart regression read both saved documents through the SDK while readiness reported zero documents and zero users. Startup summary code only inspected the older top-level document and Auth sections; the current controller stores documents in buckets and accounts in its service metadata. The original fixture passed unchanged after the shared state-count helper learned both representations (`/tmp/pyric-hardening-restoration-diagnostics-{red,green}.log`).

`state-summary.ts` counts document paths without rehydrating values or serialising the keyspace. Controller account counts take precedence over the older separate Auth section, including an empty account list. Startup diagnostics and seed labels use that summary, and the existing state-store recovery-backup check reuses its document count. This adds no persisted fields, runtime owner or transport change.

Separate review verifies both the human-readable startup line and JSON, empty/fresh startup, and Auth-only restoration checked against the public remote account list. The affected matrix passes 18 browser cases in 35.6 seconds (restart, reset, seed and runtime parity); 34 state-store/persistence/session regressions pass in four isolated files. Both diagnostics cases pass on Node 22.15.0 in 6.7 seconds. CLI/fixture strict types and five-file code form pass. Reports and source/emitted hashes are archived in `ignored/hardening/restoration-diagnostics/verified-inputs.json`; every process is terminal. Browser runtime modules were unchanged; applicable packaging remains at the final milestone join.

Checkpoint value commit: `d5f1c10775d063bbdd80d4f3d5fe34b94e17b57c`, local pending push authorization. Task 5 is next. The manual demo remains untouched.

## Task 5: Interrupted recovery — verified locally

Three S1/S2/S3 characterization tests pass without a production change. A real host restart followed by a second socket cut during Auth restoration retains the UID, permits an owner-authorized write and delivers each subsequent document value once. Deleting the app while its restoration request is held closes the socket; advancing the browser retry clock produces neither another restoration of that UID nor a resume of its grant, and SDK app enumeration stays empty. A browser platform interceptor retains a real document snapshot and close event, then delivers them after recovery: neither changes the current document nor prevents a subsequent SDK write/listener round trip.

Review corrected fixture assumptions rather than weakening product expectations. Same-host retained admission does not run Auth restoration, so the interruption fixture requires a real restart. Runtime panel and app sockets both use worker ports; selecting the first socket or counting every attachment is not an app-specific oracle. The final delayed-event fixture selects an actual document snapshot and intercepts before SDK delivery. The deletion fixture identifies the app by its public UID and admission grant. Initial setup failures, the intermittent all-port count failure and diagnostic runs are retained separately; none is claimed as a product red/green pair.

Final evidence: 13 affected recovery browser cases pass in 36.6 seconds; the three new cases pass on Node 22.15.0 in 12.2 seconds. Strict fixture types, three-file source form and whitespace checks pass. The long real-clock expiry case is reused: its fixture, protocol, session owner, socket source and emitted owner hashes match the task 2 evidence. No production source changed, so this slice requires no new runtime parity, bundle or package build claim. Applicable packaging remains at the final join. Reports, reviewed input hashes and setup evidence are under `ignored/hardening/interrupted-recovery/`. Task 6 is next; the manual demo is untouched.

Recovery verification commit: `08a3fdc9`, local pending push authorization.

## Task 6: Active-app reset slice — verified locally

The public two-context reset fixture failed after a successful reset acknowledgment: an active SDK listener still displayed `Before reset` instead of the missing document. The unchanged fixture passed after the worker reset handler reused `restoreSubscriptions` following restoration of project Rules. This is the same retained-intent owner used by checkpoint restore; no second listener registry or runtime selection policy was added.

Review extends the fixture to default SharedWorker tabs, sharing a browser context only for that runtime. Both apps observe cleared data and subsequent SDK writes. A secondary listener unsubscribed before reset stays stopped while another active listener follows both updates. An ordered SDK read confirms the unsubscribe was processed before the control request. Existing checks cover reset with an in-flight Storage save, unhealthy-persistence refusal, checkpoint listeners, RTDB disconnect invalidation and SharedWorker checkpoint controls. The old in-page checkpoint label is withdrawn by the runtime-selection correction below.

Current checks: 11 affected browser cases pass in 22.4 seconds; 17 reset/RTDB cases pass on Node 22.15.0 in 32.6 seconds; seven worker reset/subscription regressions pass in two isolated files. Strict CLI/fixture types, two-file source form, whitespace checks and the worker-client browser boundary pass (54,943 / 98,304 bytes, zero findings). The original red/green pair and reviewed input hashes are archived under `ignored/hardening/active-app-replacement/`. No full task 6 completion is claimed: active Firestore import, remaining stale work and the final milestone packaging/integration checks are open.

Reset repair commit: `bb3bd157`, local pending push authorization.

## Task 6: Active-app import slice — verified locally

The unchanged hosted SDK import fixture failed after `{ ok: true }`: the document listener still showed `Before import` instead of `Saved value`. The import handler now invokes the existing `restoreSubscriptions` after loading the snapshot. The original fixture passes; no new registry, generation owner or transport branch was introduced.

Review covers two independent hosted contexts and two default SharedWorker tabs. Active document and collection-query listeners show the imported value, a document created after export disappears, subsequent SDK writes reach both apps, and the listener unsubscribed before import stays stopped. The original red/green fixture and results are preserved separately from this expanded review.

Current evidence: 28 affected replacement browser cases pass in 52.4 seconds, including reset, checkpoint, RTDB disconnect/refusal and SharedWorker checks. The then-labeled in-page checkpoint case actually used SharedWorker; see the correction below. Both reviewed import scenarios also pass on minimum Node; exact timing is retained in the archived report. Fifteen existing connection/checkpoint/subscription regressions pass across four isolated files. Strict CLI build, fixture types, two-file source form and whitespace checks pass. The client source and its prior boundary result are unchanged by this host-only call. Inputs and logs are archived under `ignored/hardening/active-app-replacement/import-verified-inputs.json`. Pending transaction work and asynchronous persistence across replacement remain to be probed before task 6 can close.


## Runtime-selection correction and in-page token refresh

The parity fixture's `--inpage` flag did not select in-page mode. An explicit runtime assertion failed with expected `in-page`, actual `shared-worker`. This withdraws the earlier in-page claims derived from `checkpoint-auth.pw.ts`, `checkpoint-storage.pw.ts`, `checkpoint-values-runtime.pw.ts`, and the first transaction-replacement probe. Their historical raw reports remain preserved, but are not in-page evidence.

A shared fixture helper now selects in-page mode through the established browser setting before imports and supplies the expected public runtime diagnostic. Corrected runtime assertions cover the affected parity and active-app replacement fixtures. The genuine in-page peer does not expose the worker relay: checkpoint, restore, export/import and reset requests through that relay return `unimplemented`. The new capability test verifies this refusal while Firestore typed values/literal maps and Storage bytes/metadata remain intact through normal SDK reads. Worker-control round trips remain verified for hosted and SharedWorker only. No in-page checkpoint/restore parity is claimed.

In-page Auth administration uses its existing public MCP tools. This exposed a real failure before the first protected write: `getIdTokenResult(true)` returned the new role, but Rules still saw old session claims. The shared Auth backend now updates the matching current session's claims on forced refresh, preserving its tenant and identity. Both token APIs use the same cache/refresh path. The existing transition guard preserves notification semantics; refreshing a held user cannot alter a different current user or undo sign-out. The unchanged in-page Auth/Rules fixture now passes.

Reviewed evidence: 31 affected browser cases pass in 52.3 seconds, including four hosted/SharedWorker transaction-replacement characterizations. Seven genuine in-page cases pass on Node 22.15.0 in 10.9 seconds. Forty-two existing Auth tests pass across five isolated files; strict Pyric/CLI/fixture types and source form pass. Worker-client and live-Firestore browser boundaries remain 54,943 / 98,304 and 387,843 / 524,288 bytes with zero findings. Explicit runtime assertions for active-app reset/import have a separate minimum-Node result. Reports and source/artifact hashes are archived under `ignored/hardening/inpage-token-refresh/`; misselection and unsupported-relay evidence remain under `ignored/hardening/runtime-selection/`.

A separate tenant-token issue was observed: the in-page `User.tenantId` is `tenant-blue`, but its `IdTokenResult.claims.firebase` lacks `tenant`. The diagnostic is retained in `ignored/hardening/runtime-selection/inpage-auth-identity-probe.log`. This remains open for item 11; the current repair proves role propagation and retained Rules tenant scope, not complete tenant-token parity. Asynchronous persistence across import remains open for item 6. Final combined/package verification and later queue items remain required.

## Task 6: Complete transfers and stale work — verified locally

The Storage overlap probe first exposed a transfer omission: export/import used persistence records whose Storage snapshot/restore hooks deliberately carry no object data. A minimized ordinary SDK round trip reported a successful import but returned the later bytes. New portable exports now reuse the existing complete checkpoint envelope, and imports reuse its validation and restore path. Legacy record imports remain readable with their historical service coverage. No second service codec or persistence owner was introduced.

After that repair, the unchanged overlap test reached a separate durability failure: the object disappeared in memory but returned after hard restart. Import now awaits the existing ordered persistence flush before acknowledging success, matching named checkpoint restore. The unchanged original round-trip and overlap fixtures pass. Both red stages, intermediate sources and final reports are retained under `ignored/hardening/import-storage/`.

Separate review verifies hosted and default SharedWorker metadata/bytes, removal of later objects, valid legacy import, corrupt complete-import refusal before data loss, and subsequent SDK writes/listener delivery. Four transaction characterizations pause a normal SDK transaction before reset/import; the callback retries against replacement data and commits without resurrecting obsolete fields. These already pass without a transaction implementation change.

Final checks: 42 affected browser cases passed in 1.3 minutes; ten new import/transaction cases passed under Node 22.15.0 in 20.2 seconds. Twenty regressions passed in five isolated files. Strict CLI and fixture types, eight-file changed-code form and whitespace checks passed. Worker-client and live-Firestore boundaries remain 54,943/98,304 and 387,843/524,288 bytes with zero findings. Final fixture formatting was verified by the minimum-Node run and refreshed type/form checks. No full browser-suite rerun was needed.

This closes the scoped active-app replacement and stale-work checks for item 6. New complete exports require a reader supporting checkpoint envelopes; legacy record exports cannot recover Storage bytes they never contained. Downgrade compatibility, coherent concurrent capture and rollback after a later service/I/O failure are not established. In-page worker controls remain explicitly unsupported; ordinary in-page SDK/MCP support is preserved. Item 7 and later items, final packaging/integration verification and the morning handoff remain open. The manual demo is untouched.

## Task 7: Persistence repair and restart — verified locally

Two new characterization scenarios pass without a production change. Both establish durable data, make the state directory unwritable, observe `committed-but-not-durable`, and prove a later mutation is refused without changing the in-memory result. Repairing permissions while the host is alive does not clear its unhealthy admission state. After hard restart, Firestore and Storage read their earlier durable values and accept new writes. The final Firestore scenario retains the original app across restart and verifies that its uncertain increment is not replayed.

The affected persistence-failure group passed 36 browser cases in one minute across SDK, Auth, RTDB, Storage, MCP and service CLI entry points. That run included the earlier fresh-reader version of the document recovery test; the stronger retained-app review and Storage recovery then passed under Node 22.15.0 in 7.8 seconds (two cases). The other 34 checks and all production inputs are unchanged. Final strict fixture types and one-file source form pass. No implementation fix, new red claim, runtime selection change or resource owner was needed. Existing production build and browser-boundary evidence from `52524c56` remains applicable.

Reports and source/artifact hashes are retained under `ignored/hardening/persistence-repair/`. The failure model is an unwritable state directory followed by permission repair and a hard process restart; this does not prove crash atomicity across arbitrary partial multi-service writes or recovery from every disk fault. Those broader architectural gaps remain explicit. Item 8 is next; final combined/packaging verification and the morning handoff remain open.

Complete-import and stale-work commit: `52524c5671c0661504b9783bbb69e3a9b807f408`, local pending push authorization.

## Task 8: Worker envelope rejection — verified slice

A null worker message escaped the consumer handler as an uncaught `TypeError`. The CLI kept the process alive, but the SDK write stayed pending. The retained real-host diagnostic identifies the null `.t` read. A socket-boundary check makes the unchanged regression pass by closing the affected connection before dispatch. Review found that an object with an unknown message type was silently ignored and also left the request pending; the boundary now recognises the declared worker message types before dispatch. The type inventory is checked against `InboundMessage['t']`. This recognises envelope kinds, not complete service payloads.

Review also caught an error in the initial repair: close code 1008 is terminal in this client's admission policy, so an affected app could not recover. The final implementation uses a protocol-error close for malformed envelopes while preserving 1008 admission refusals. The unchanged recovery review then passes: a separate app writes successfully, and the affected app resumes its listener and performs a subsequent valid write. Earlier failing review output and intermediate source are retained rather than counted as successful evidence.

Final verification: 22 affected browser cases passed under Node 22.15.0 in 48.1 seconds, including eight malformed-envelope variants, invalid-grant refusal, hosted restart recovery, SharedWorker import/write validation and explicit in-page control refusal. Thirty-one existing bridge peer/session regressions pass in three isolated files. Strict CLI/fixture types, two-file source form and staged whitespace checks pass. The new runtime check is confined to the Node socket boundary; no browser runtime owner or bundle dependency was added. Reports and source/artifact hashes are under `ignored/hardening/worker-envelope/`.

Item 8 remains in progress. Next: correlation-field validation, outer JSON/envelope handling, remaining method payloads, protocol-version refusal and declared size/depth boundaries. Passing these eight malformed worker-body cases does not establish general request validation or resource bounds. The later queue, final packaging/integration verification and manual handoff remain open.

Persistence-repair characterization commit: `39f2facdc61e463f716d79363e661f7be107b499`, local pending push authorization.

## Task 8: Browser worker correlation IDs — verified slice

The null-request-ID regression reproduced both a pending SDK promise and an already-applied write visible in the document listener. The socket validator now requires string IDs for correlated worker requests before dispatch, so an invalid ID cannot cause a mutation with an unmatchable reply. The unchanged original test passes; review covers missing, numeric, Boolean, array and object IDs, unchanged data before the healthy client's write, and subsequent recovery of the affected app.

A separate subscription regression reproduced an original listener that never received its first snapshot after its subscription ID was replaced with null. Subscription and unsubscribe envelopes now require string subscription IDs before dispatch. The unchanged regression passes, and review adds a missing subscription ID. The fixture's document-target guard was refined to distinguish Firestore targets from RTDB/AI target objects after strict typechecking caught the missing narrowing; no cast or suppression was added. Existing string-ID semantics are retained; this slice introduces no ID length or value policy.

Final verification: 31 affected browser cases passed under Node 22.15.0 in 1.1 minutes. The group includes the eight new request/subscription-ID checks, previous malformed-envelope checks, admission refusal, deletion during recovery, hosted restart, SharedWorker import/write validation and explicit in-page control refusal. Thirty-one existing peer/session regressions pass across three isolated files. Strict CLI/fixture types, three-file changed-code form and staged whitespace checks pass. No browser implementation or resource owner changed. Reports and source/artifact hashes are retained under `ignored/hardening/request-id/`.

This closes the scoped browser worker correlation checks, not all of item 8. Outer JSON/envelopes, legacy relay correlation, remaining method payloads, protocol-version refusal and size/depth limits remain to be verified. Later items and final packaging/integration/handoff are still open.

Envelope rejection commit: `9787eac1d150676d9d9a05143cb5247893b37d4d`, local pending push authorization.

## Task 8: Outer frame rejection and shared fault fixture — verified slice

Two separate public-wire regressions reproduced pending SDK writes when the outer frame contained invalid JSON or an unknown message type. The socket parser previously returned silently on both paths. It now closes the offending connection with the existing protocol-error behavior before dispatch. Each unchanged original regression passed after its correction. Review covers null, array, numeric and string roots, missing frame type and a non-string type, along with no mutation, an independently usable app and subsequent recovery of the affected app.

The three malformed-write scenario files had identical setup and assertion bodies. Review extracted those bodies into `malformed-write-fixture.ts`; the tests now supply just their wire transformation. Before extraction, the normalised bodies were compared and matched exactly, including refusal, isolation, listener recovery, subsequent writes and the absence of uncaught host exceptions. The original files are retained in the evidence archive. Subscription-specific tests retain their distinct fixture instead of adding modes to this helper.

Final verification: 39 affected browser cases passed under Node 22.15.0 in 1.4 minutes, including all extracted callers, eight outer-frame cases, correlation/subscription validation, admission refusal, deletion/restart recovery, SharedWorker behavior and explicit in-page control refusal. Thirty-one peer/session regressions passed in three isolated files. Strict CLI/fixture types, five-file source form and staged whitespace checks pass. The production change adds only explicit rejection on the existing parser's two failure paths; no runtime owner or browser dependency changed. Reports and source/artifact hashes are retained under `ignored/hardening/outer-frame/`.

Item 8 remains open for validation of known outer-frame payloads and legacy relay correlation, remaining method payloads, protocol-version refusal and size/depth bounds. This does not claim full protocol validation or cross-version compatibility. Later queue items, final packaging/integration verification and the morning handoff remain open.

Correlation-ID commit: `8308ea40abc53694a4a06824db189cfbc7f8a2b7`, local pending push authorization.


## Task 8: Protocol admission and buffered-frame refusal — verified slice

At the approved S1/S2/S3 seams, an unsupported consumer handshake (`protocol: 999`) received a real worker-session grant. A separate unsupported peer handshake replaced the default SharedWorker peer and received consumer presence data. Both now refuse with close code 1008 and an expected-version diagnostic before registration. Protocol 1 remains the existing wire contract; this does not establish package-version compatibility.

A third public-boundary regression sent an invalid handshake followed immediately by a valid attach and a write. Despite receiving refusal, the SDK read the forbidden document: already-buffered frames were still dispatched while the socket was closing. The socket handler now checks its existing ready state before parsing/dispatching. No parallel connection state, dependency or resource owner was added. The production change is ten lines in `bridge/server/peer.ts`.

The initial consumer red passes unchanged. The peer fixture's first post-fix run reached the follow-up write but correctly failed Rules because its remote control was unauthenticated. That fixture now waits for public peer readiness and uses explicit admin control. The corrected fixture was rerun against the missing peer-version check, failed at the same refusal assertion, and then passed unchanged with the fix restored. The buffered-write regression also passes unchanged after the socket-state check. Original fixtures, intermediate production sources and all reports are archived under `ignored/hardening/protocol-admission/`; the initial fixture mistake is retained separately from valid red/green evidence.

Separate review extracted repeated socket refusal assertions and verifies that no reply/presence/grant precedes closure. Eight invalid version values (future, zero, absent, null, string, Boolean, array and object) are refused for worker-port consumers, legacy consumers and SharedWorker peers: 24 handshake probes within two browser scenarios. Buffered-frame review also covers invalid session grants and invalid JSON. Normal SDK writes/listeners and public remote writes still work; runtime diagnostics explicitly identify hosted and default SharedWorker execution.

Final terminal checks: 37 affected browser scenarios pass in 1.4 minutes on Node 22.15.0; 31 peer/session/relay regressions pass in three isolated files; strict CLI and hosted-fixture types pass; changed-code form checks two TypeScript files with zero findings. Commands and hashes are archived in `verified-inputs.json`. No retries or skips. This edit changes only the Node socket handler, so existing browser dependency/bundle evidence remains applicable; the in-page capability and SharedWorker active-import scenarios pass in the affected group. No SDK return shape, cross-runtime codec or conformance registry row changes. Final packaging remains at the milestone join.

Known-frame and legacy relay payload validation, reply-version validation, size/depth limits and later queue items remain open. This slice proves refusal of invalid wire versions; item 18 still requires actual packaged client/host combinations. The manual demo is untouched. Local commits remain pending the existing push authorization question.
