# Section 3: disconnect behavior and concurrent writes

Started 2026-09-15 at `14fdcc6d` on `hosted-live-mode`. Scope is hardening
items 12–13, using the approved S1 SDK, S2 bridge and S3 CLI lifecycle seams.
SharedWorker stays the default; hosted is opt-in; in-page fallback stays supported.
The existing manual projects on 43110 and 48765 are outside this work.

| Gate | Required outcome | State |
| --- | --- | --- |
| D1 | Explicit offline drains accepted RTDB disconnect work once; cancellation and deletion preserve per-app ownership in all three runtimes. | Verified: six SDK scenarios across hosted, SharedWorker and in-page, including a non-idempotent execution counter. |
| D2 | Physical hosted socket loss drains before retention expiry; recovery, actual expiry and deletion never replay consumed intent. New registrations work after recovery. Connectivity agrees with the transition. | Verified: transient socket loss, actual host expiry with a new grant, restored connectivity and fresh intent on deletion. |
| C1 | Two clients contend on Firestore and RTDB through SDK transactions without losing updates; observable retry follows a real conflict. | Verified: three-runtime Firestore conflict/retry and RTDB concurrent commit scenarios. |
| C2 | Rejected Firestore batches and RTDB multipath updates leave all affected values unchanged. | Verified: three-runtime batch and multipath rejection, read back through the second app. |
| C3 | Lost acknowledgments report uncertainty without replaying non-idempotent mutations; new work succeeds after recovery. | Verified: Firestore and RTDB lost acknowledgments; RTDB wire counts remain one per explicit increment. |
| J | Focused integration, applicable regressions, types and code-form checks pass; changes are reviewed, pushed and accompanied by runnable manual steps. | Verified: 49 distinct browser cases, 37 regressions, builds/types/form, hosted UI checkpoint and remote backup. |

The declared disconnect contract drains a physical connection's accepted queue
on socket loss, not at retained identity expiry. Reconnection does not re-register
consumed intent. Test one behavior at a time; preserve passing characterization
without inventing fixes. Record failures before changing production.

## Results

All scoped requirements already worked in production. This section adds public
SDK evidence and reusable manual fixtures; it does not add another scheduler,
connection owner, mutation queue or retry layer. No production source changed.
These are passing characterizations, not invented red/green fixes.

- The fast new group passes **13 cases in 26.1 seconds**.
- The affected integration group passes **37 cases in 146.2 seconds**, with zero
  skips, unexpected results or retries. One RTDB lost-ack case appears in both
  groups, giving **49 distinct browser scenarios**. The integration group includes
  the final disconnect-counter expiry case, existing connectivity and transient
  socket-loss cases, RTDB reset/import/checkpoint invalidation, and Firestore
  transaction retry across state replacement. The expiry test spends 62 seconds
  observing the real host retention window.
- **37 regressions** pass in five isolated files: RTDB disconnect (10), modular
  transactions (17), contention (4), Firestore atomic writes (5), and transaction
  write execution (1).
- Pyric and CLI TypeScript builds, strict browser-fixture types, changed-code form,
  JavaScript syntax and whitespace checks pass. All five new TypeScript files have
  zero code-form findings. Runtime source, dependencies, public SDK shapes,
  conformance registry rows and browser bundle inputs are unchanged, so no new
  bundle budget, codec fallback or conformance-count claim is needed.
- Hosted interactive checks in the Codex in-app browser passed the numbered
  disconnect and concurrent-write steps. SharedWorker and in-page parity were
  verified by the automated SDK scenarios. This is not independent browser-engine
  coverage or physical laptop-sleep evidence.

The first expiry harness held attach messages while browser attachment deadlines
continued to run. That is excluded diagnostic evidence; the corrected harness
pauses browser timers while the actual host clock advances. The initial atomic
assertion also incorrectly expected Firestore-style lowercase errors from RTDB;
its documented `PERMISSION_DENIED` code was retained, and the assertion corrected.
The disconnect review then added an incrementing effect counter so duplicate
execution cannot hide behind idempotent writes. The final cases pass with that
stronger assertion. No production fix was justified by these fixture corrections.

Commands, reports and input fingerprints are retained in `ignored/section3/`.
The [manual checkpoint](hosted-section-three-manual-qa.md) includes exact commands,
visible steps, expected results and the separate transport fault-injection command.
The hosted checkpoint is left on port **48768**; earlier demos remain untouched.

Section 3 closes hardening queue items 12–13. Packed installation/runtime selection,
origin/project isolation, slow consumers, Rules reload, version compatibility and
fault diagnostics remain in the later sections. This is not release acceptance.
