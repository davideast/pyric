# Hosted sandbox hardening

Base: `6b0728b830faa788b53ea97fc764f5c3397fe14d` on `hosted-live-mode`.
This bounded milestone leaves the broader hosted/live-mode goal incomplete.
Use the already approved S1–S6 seams, vertical TDD, and applicable universal gates.
Do not modify the manual demo project. Commit and push each verified slice.

## Ordered queue

1. Anonymous UID uniqueness — active. Prove deletion/restart cannot transfer UID-owned data to a new identity, and retained accounts still restore.
2. Session retention expiry — pending. Fresh admission restores the legitimate app; invalid/revoked grants remain refused and uncertain writes never replay.
3. Checkpoint restoration — pending. Supported Firestore/Auth/RTDB/Storage data and identity metadata round trip; corruption refuses before replacing healthy state.
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

### Task 1 in progress

The normal SDK regression twice reproduced both `anonymous-1` reuse and access to the deleted user's owner-only document. A public Auth probe reproduced the repeated UID in two independent sandboxes without browser or persistence involvement. UUID allocation in the existing shared anonymous factory passes the unchanged original regression (4.6 seconds total); the retired counter is removed. No new runtime branch, dependency, persistence schema or resource owner is introduced.

Review passed 482 existing Auth/app/persistence/worker tests in 41 isolated processes. Browser review also confirms deletion and Rules isolation across hosted, SharedWorker and in-page paths. An initial retained-account fixture incorrectly reused its saved browser session; after adding explicit SDK sign-out, the same test exposed a real persistence defect: restored account creation time changes and last-login time becomes null. This remains red and must be fixed before Task 1 is complete. Source/report evidence is under `/tmp/pyric-hardening-uid-*`; the original matched red/green fixture and logs are preserved in `ignored/hardening/uid/`.
