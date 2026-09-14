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
6. Reset/import with active apps — in progress. Both controls now rebind retained Firestore listeners in hosted and default SharedWorker mode. Active document/query updates and unsubscribe behavior are verified; stale-work probes remain open.
7. Persistence-failure recovery — pending. Accurate uncertainty, later mutation refusal, and repaired-storage restart preserve the last durable state.
8. Malformed requests — pending. Invalid envelopes, payloads, versions, and size/depth boundaries fail without mutation or disruption of another client.
9. Lifecycle cleanup — pending. Repeated startup failures, interrupted initialization, reconnect, deletion and shutdown release resources and ownership.
10. Sleep/resume with delayed disconnect notification — pending. An expired host session recovers even when the browser observes the interruption late; invalid grants remain refused and uncertain writes never replay.
11. Identity and tenant isolation across clients — pending. Switching or signing out in one app cannot change another app's identity, tenant, claims or Rules access, including after recovery.
12. RTDB disconnect behavior — pending. Connectivity signals and registered disconnect operations follow the declared session-lifetime contract across transient loss, expiry and explicit app deletion.
13. Concurrent transactions and atomic writes — pending. Two clients contend through normal SDK calls without lost updates; rejected batches remain atomic and ambiguous acknowledgments do not trigger transport replay.
14. Packed installation and runtime selection — pending. An isolated consumer uses the built package through served imports and Vite cold/warm startup, reload and HMR; default SharedWorker, explicit hosted and in-page select their intended implementation.
15. Combined verification and morning handoff — pending. Current affected matrix, runtime parity, types, source form, applicable packaging; fixes, reports, remaining failures and manual QA steps.

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

Separate review verifies all three refresh operations across hosted, default SharedWorker and in-page: the SDK sees the revoked claims, retains its tenant, fails a protected write, and the public admin account retains the revocation. Final affected checks pass 33 browser cases in 54.4 seconds, ten minimum-Node cases in 17.2 seconds, and 57 regressions in four isolated files. CLI and fixture strict types pass; changed-code form has zero findings. Reports use `/tmp/pyric-hardening-checkpoint-auth-`. The source change is confined to the host helper; browser leaves and shared SDK implementation are unchanged. Applicable packaging remains at the final join. This slice does not close the all-service checkpoint or corruption requirements.

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

Current terminal checks: 42 affected browser cases passed in 1.1 minutes, including all three runtime paths; eight focused cases passed on Node 22.15.0 in 16.1 seconds; 107 regressions passed in eight isolated files; strict Pyric/CLI/fixture types, changed-code form and client/live browser boundaries passed. Reports use `/tmp/pyric-hardening-checkpoint-values-`, with source-bound copies in `ignored/hardening/checkpoint-values/`. The byte-corruption, literal-map restart and branch-path red fixtures are retained there. The minimized restart test is now named `checkpoint-literal-restart.pw.ts`; its behavioral assertions are unchanged.

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

Review extends the fixture to default SharedWorker tabs, sharing a browser context only for that runtime. Both apps observe cleared data and subsequent SDK writes. A secondary listener unsubscribed before reset stays stopped while another active listener follows both updates. An ordered SDK read confirms the unsubscribe was processed before the control request. Existing checks cover reset with an in-flight Storage save, unhealthy-persistence refusal, checkpoint listeners, RTDB disconnect invalidation and SharedWorker/in-page checkpoint controls.

Current checks: 11 affected browser cases pass in 22.4 seconds; 17 reset/RTDB cases pass on Node 22.15.0 in 32.6 seconds; seven worker reset/subscription regressions pass in two isolated files. Strict CLI/fixture types, two-file source form, whitespace checks and the worker-client browser boundary pass (54,943 / 98,304 bytes, zero findings). The original red/green pair and reviewed input hashes are archived under `ignored/hardening/active-app-replacement/`. No full task 6 completion is claimed: active Firestore import, remaining stale work and the final milestone packaging/integration checks are open.

Reset repair commit: `bb3bd157`, local pending push authorization.

## Task 6: Active-app import slice — verified locally

The unchanged hosted SDK import fixture failed after `{ ok: true }`: the document listener still showed `Before import` instead of `Saved value`. The import handler now invokes the existing `restoreSubscriptions` after loading the snapshot. The original fixture passes; no new registry, generation owner or transport branch was introduced.

Review covers two independent hosted contexts and two default SharedWorker tabs. Active document and collection-query listeners show the imported value, a document created after export disappears, subsequent SDK writes reach both apps, and the listener unsubscribed before import stays stopped. The original red/green fixture and results are preserved separately from this expanded review.

Current evidence: 28 affected replacement browser cases pass in 52.4 seconds, including reset, checkpoint, RTDB disconnect/refusal and SharedWorker/in-page checks. Both reviewed import scenarios also pass on minimum Node; exact timing is retained in the archived report. Fifteen existing connection/checkpoint/subscription regressions pass across four isolated files. Strict CLI build, fixture types, two-file source form and whitespace checks pass. The client source and its prior boundary result are unchanged by this host-only call. Inputs and logs are archived under `ignored/hardening/active-app-replacement/import-verified-inputs.json`. Pending transaction work and asynchronous persistence across replacement remain to be probed before task 6 can close.
