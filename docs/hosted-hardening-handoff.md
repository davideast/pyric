# Hosted hardening QA handoff

> Historical checkpoint. Superseded by [combined milestone verification](hosted-milestone-verification.md). Its pending-item list describes the earlier candidate, not current phase status.

Status: milestone verification and remote backup complete. This is the bounded hardening milestone, not completion of hosted sandbox or live mode.

The starting remote checkpoint was `6b0728b830faa788b53ea97fc764f5c3397fe14d` on `origin/hosted-live-mode`. The verified implementation candidate is `136da70991cbdca838adbe6ccaeb121089d10f82`, with 42 verified commits before the handoff commit `3f3a4ed6`. All 43 commits were pushed to `origin/hosted-live-mode` after direct user authorization. Combined runtime verification ran against `b306dd3b`; the subsequent review refactor preserves all existing emitted JavaScript byte for byte. No PR or release has been created. The manual demo and its data were left untouched.

## Completed locally

| Queue item | Result | Main commits |
| --- | --- | --- |
| 1. Anonymous identity | Deleted accounts cannot donate a reused anonymous UID; saved account metadata survives restart. | `9b418216` |
| 2. Session expiry | Observed interruptions beyond retention obtain fresh admission and restore Auth/listeners without replaying uncertain writes. | `fcf71613` |
| 3. Checkpoints | Scoped Auth, Firestore, RTDB and Storage round trips preserve values and metadata; corrupt inputs refuse before reset. | `87c7e951`, `0c834446`, `87d073dd`, `d5f1c107` |
| 4. Startup diagnostics | Restored document and account counts reflect the controller state, including Auth-only restoration. | `f33381c6` |
| 5. Interrupted recovery | Repeated interruptions, delayed old-socket events and deletion during recovery have public regression coverage. | `08a3fdc9` |
| 6. Active state replacement | Reset/import restore active listeners; stale transactions retry; full Storage imports preserve bytes/metadata and wait for persistence. | `bb3bd157`, `ad630702`, `52524c56` |
| 7. Persistence refusal | Failed persistence reports uncertainty and refuses further mutations; repair plus restart restores durable state without replaying the uncertain write. | `39f2facd` |

The in-page claim-refresh correction is `11cb30f8`. SharedWorker remains the default; ordinary in-page SDK support remains present. Worker-only controls explicitly refuse in-page execution.

Item 8 is partial: protocol admission, malformed envelopes/correlation fields, mounted and standalone inbound limits, mounted consumer output limits, Firestore encoded depth, and selected query descriptor/constraint validation have verified slices. Served count queries were restored in `0536b8ad`. Full details and per-slice red/green evidence are in [the progress ledger](hosted-hardening-progress.md).

## Remaining failures and unverified behavior

- Known failure: in-page `User.tenantId` can be `tenant-blue` while `IdTokenResult.claims.firebase.tenant` is absent. The retained diagnostic is `ignored/hardening/runtime-selection/inpage-auth-identity-probe.log`. Item 11 remains open.
- Item 8 still needs detailed request/reply shapes, structural query/composite bounds, other decode paths and remaining outbound senders. Empty-array query behavior is characterized as existing Pyric behavior, not a new upstream compatibility claim.
- Checkpoint guarantees are limited to the specified round trips and corruption refusal. General rollback after later service/I/O failures, coherent concurrent capture, arbitrary buckets and downgrade compatibility remain unproven.
- Items 9–19 are untouched as queue tasks: cleanup; delayed disconnect notification; identity/tenant isolation; RTDB disconnect semantics; concurrent transactions/lost acknowledgments; actual packed installation/Vite/HMR; origin/project isolation; slow consumers; Rules reload; actual version combinations; fault diagnostics/redaction. Incidental coverage does not complete these items.
- The earlier push-approval blocker is resolved. The user explicitly authorized the push, and `origin/hosted-live-mode` accepted the verified commits through `3f3a4ed6`.

## Verification

Final reports and source/artifact hashes are archived in `ignored/hardening/handoff-audit/verified-inputs.json`. Exact commands are retained in that manifest and the selection/exit records alongside it. The combined browser run passed all 216 scenarios from the 59 added/changed hosted browser files since the checkpoint in 9.6 minutes. This is an affected selection, not the entire browser suite. Minimum Node is 22.15.0, with one worker and zero retries.

The combined regression runner first stopped at the opt-in Vite file because its enabling environment flag was omitted. Its preceding 185 passing tests remain valid; the remaining run enabled `PYRIC_BRIDGE_E2E=1` and `PYRIC_TEST_NODE=/tmp/node-v22.15.0-darwin-arm64/bin/node`, passing 953 tests. Together these cover 1,138 tests in 123 distinct files, with every selected file eventually executed successfully. The five setup skips in the first attempt are not counted as passing evidence.

| Check | Final evidence |
| --- | --- |
| Affected browser scenarios | 216 passed, 9.6 minutes, Node 22.15.0, no retries/skips. |
| Affected regressions | 1,138 passed across 123 distinct isolated files; includes the corrected opt-in Vite run. |
| Strict types | Pyric, CLI and hosted fixtures passed; after the type extraction, Pyric rebuilt and downstream CLI types passed again. |
| Code form | 123 changed TypeScript files, zero findings; whitespace check passed. |
| Scoped source graph | 1,017 source/generated files, 48 added edges, no added cycle or unresolved local import. Includes type edges; excludes third-party internals and computed dynamic imports. |
| Browser budgets | Five prior reports reused with matching compiler/package/lock/checker inputs and unchanged runtime JavaScript. Worker client 54,943/98,304 bytes; socket 7,425/16,384; RTDB listeners 12,930/32,768; value codec 18,638/24,576; live Firestore 387,843/524,288. |
| Copied standalone | Fresh host binary compiled successfully; four tests passed in 16.7 seconds outside the workspace, including SDK serving, project ownership and stdio MCP discovery. This does not establish item 14's npm installation/Vite/HMR contract. |

The final review found type-only schema cycles. Commit `136da709` moves the unchanged `SeedUser` declaration to an Auth leaf and imports Storage metadata directly, retaining field completeness checks and existing exports. All 1,027 preexisting JavaScript files remain byte-identical; the only new JavaScript file is an empty type-leaf export. This is an architecture review refactor, not a claimed new runtime bug fix.

## Short manual QA sequence

Use disposable local data for destructive checks. Keep two independent browsers open against the same hosted project.

1. Confirm `globalThis.__pyricRuntime?.getSnapshot().mode` reports `hosted`. Write a distinct greeting in each browser and confirm the other browser's existing listener receives it.
2. Record each browser's signed-in UID. Restart the host using the same project and port, then verify both original pages recover, retain their identities and can write again without reloading. Repeat once. Check that each write arrives once.
3. Save a checkpoint containing a typed Firestore document and a Storage object with metadata. Change them, restore, and verify the original values/bytes return in the active pages. Restart and check the restored state again.
4. On a disposable account, create UID-owned data, delete the account, restart, then sign in anonymously. Confirm the new UID differs and cannot read the old account's protected data.
5. In a separate disposable project, omit `--hosted` and verify default SharedWorker selection plus a write/listener round trip. Retain a genuine in-page smoke as well; do not treat worker-only control refusal as an in-page SDK failure.

Record the mode, action, expected result and observed result for any failure. Start follow-up implementation with the remaining item 8 contract gaps and item 9 cleanup; keep the in-page tenant-token failure visible for item 11.

## Verified commit inventory

The following commits follow the remote checkpoint; this handoff is committed separately.

```text
506c0383 fix(tooling): check changed class members at the function boundary
9b418216 fix(auth): preserve distinct identities across host restarts
fcf71613 fix(hosted): readmit apps after session retention expires
87c7e951 fix(auth): refresh sessions from current account claims
0c834446 fix(sandbox): retain Storage metadata in checkpoints
87d073dd fix(sandbox): reject corrupt checkpoints before resetting state
d5f1c107 fix(sandbox): preserve Firestore values across saved state boundaries
f33381c6 fix(hosted): report restored controller state accurately
08a3fdc9 test(hosted): verify interrupted recovery and stale connection isolation
bb3bd157 fix(hosted): restore active listeners after sandbox reset
ad630702 fix(hosted): restore active listeners after state import
11cb30f8 fix(auth): apply refreshed claims to the active in-page session
be069f31 docs: extend hosted hardening queue with five acceptance gates
52524c56 fix(hosted): transfer complete Storage state and persist imports before acknowledgment
39f2facd test(hosted): verify repaired persistence recovery without mutation replay
9787eac1 fix(hosted): reject malformed worker envelopes without stranding SDK calls
8308ea40 fix(hosted): validate browser worker correlation IDs before dispatch
db418806 fix(hosted): reject invalid outer frames and share malformed-write fixtures
c6ec9bed fix(hosted): refuse incompatible protocols and buffered frames after close
0dffc91c fix(hosted): validate legacy relay request envelopes before dispatch
a265c379 fix(hosted): reject incompatible host acknowledgments in consumers
a49237a1 fix: reject incompatible browser peer acknowledgments
54af48ee fix: validate hosted acknowledgment capabilities
2342f557 test: verify buffered peer work follows admission
af84168b fix: validate remote identity lens envelopes
99847f16 test: run Vite bridge lifecycle on Node
8e557bcd fix: bound mounted bridge WebSocket input
1aa8eb3f fix: bound standalone bridge WebSocket input
a87a405c fix: share standalone peer protocol admission
3428faef fix: validate sandbox peer handshake fields
489691a7 fix: share bridge outer message refusal
948087b5 fix: bound encoded Firestore write depth
cf5d21ff fix: validate transaction read document depth
0536b8ad fix: expose served SDK count queries
e4a7b448 fix: bound encoded query operands before decoding
30e1c63c fix: bound mounted consumer response frames
1d11ae6c fix: reject unsupported Firestore target descriptors
0f75daf8 fix: reject unsupported query order directions
26fba489 fix: validate query limits and preserve empty tails
b83b3693 fix: reject unsupported query filter operators
b306dd3b fix: reject non-array membership filter operands
136da709 refactor: remove checkpoint schema type cycles
```
