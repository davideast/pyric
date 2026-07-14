# 0007: Split the Firestore engine facade and shared sandbox facade mechanically

Status: Accepted follow-up for the app-registry/SharedWorker PR

Date: 2026-07-14

## Findings

Two files touched by the app/session lifecycle work remain above the ratified
structure limits:

- `packages/pyric/src/sandbox/firestore/local-environment.ts` is a 3,605-line
  Firestore engine facade. This PR adds only app-session scoping to its existing
  listener records and re-evaluation path.
- `packages/pyric/src/sandbox/internal/sandbox-impl.ts` is an 809-line shared
  runtime facade. This PR adds only the service-unregistration half of its
  existing persistence registration seam.

Both additions fix demonstrated lifecycle defects and are covered by focused
multi-app/deletion tests. Neither addition creates a new subsystem in its host
file. The files still violate the 600-line trigger and `SandboxImpl` remains
above the 400-line class smell threshold.

## Decision for this PR

Accept these two structural P2 findings as explicit follow-ups. Do not combine
their mechanical decomposition with the behavior change under review. The
ratified migration policy requires characterization first and pure moves in a
separate commit; splitting either facade here would intermingle a large move
with app/session semantics and make the correctness diff harder to audit.

This exception waives only file size and module shape. It does not waive
listener identity, app deletion, persistence registration, teardown ordering,
or SharedWorker session correctness.

## Follow-up boundary

Before the next Firestore or shared-sandbox-runtime behavior climb, land a
dedicated mechanical PR that:

1. Characterizes the current facades with the full Firestore simulator,
   persistence, app lifecycle, and worker suites before moving code.
2. Moves the Firestore engine to the ratified `firestore/sandbox/` location and
   splits listener delivery/re-evaluation, rules evaluation, reads/query
   execution, writes/batches/transactions, history, and facade lifecycle into
   concept files. Keep `LocalEnvironment` as the compatibility facade until all
   callers move.
3. Extracts `SandboxImpl` persistence/service-registry coordination and event
   history/dispatch into collaborators while leaving `SandboxImpl` as the
   cross-surface lifecycle facade.
4. Preserves every public package subpath and behavior; the mechanical commits
   contain no API or protocol change.
5. Runs the complete pyric, pyric-admin, CLI worker/browser, persistence,
   conformance, and packaging gates before merge.

Any correctness defect discovered while doing that work is not covered by this
exception and must be fixed independently, test-first.
