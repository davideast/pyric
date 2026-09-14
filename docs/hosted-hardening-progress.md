# Hosted sandbox hardening

Base: `6b0728b830faa788b53ea97fc764f5c3397fe14d` on `hosted-live-mode`.
This bounded milestone leaves the broader hosted/live-mode goal incomplete.
Use the already approved S1–S6 seams, vertical TDD, and applicable universal gates.
Do not modify the manual demo project. Commit and push each verified slice.

## Ordered queue

1. Anonymous UID uniqueness — verified locally. Deletion/restart cannot transfer UID-owned data to a new identity; retained accounts preserve their UID, claims, creation time and last-login time.
2. Session retention expiry — next. Fresh admission restores the legitimate app; invalid/revoked grants remain refused and uncertain writes never replay.
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
