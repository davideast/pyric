# Hosted sandbox hardening

Base: `6b0728b830faa788b53ea97fc764f5c3397fe14d` on `hosted-live-mode`.
This bounded milestone leaves the broader hosted/live-mode goal incomplete.
Use the already approved S1–S6 seams, vertical TDD, and applicable universal gates.
Do not modify the manual demo project. Commit and push each verified slice.

## Ordered queue

1. Anonymous UID uniqueness — verified locally. Deletion/restart cannot transfer UID-owned data to a new identity; retained accounts preserve their UID, claims, creation time and last-login time.
2. Session retention expiry — verified locally. The original app obtains fresh admission after the retention window, with Auth restored before listeners. Expired/invalid grants remain refused; app deletion cancels recovery; uncertain writes never replay.
3. Checkpoint restoration — in progress. Account and Storage metadata round trip, including host restart. Corrupt envelopes, service records and fallible Storage inputs now refuse before reset. Firestore special-value fidelity is the remaining round-trip check before closing this item.
4. Restoration diagnostics — pending. Startup text and readiness JSON match authoritative SDK state.
5. Interrupted recovery — pending. A second interruption restores identity/listeners once; obsolete callbacks and app deletion cannot revive sessions.
6. Reset/import with active apps — pending. Both browsers see replacement; removed listeners stay removed and stale work cannot resurrect data.
7. Persistence-failure recovery — pending. Accurate uncertainty, later mutation refusal, and repaired-storage restart preserve the last durable state.
8. Malformed requests — pending. Invalid envelopes, payloads, versions, and size/depth boundaries fail without mutation or disruption of another client.
9. Lifecycle cleanup — pending. Repeated startup failures, interrupted initialization, reconnect, deletion and shutdown release resources and ownership.
10. Combined verification and morning handoff — pending. Current affected matrix, runtime parity, types, source form, applicable packaging; fixes, reports, remaining failures and manual QA steps.

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
