# Progress

Last visited: 2026-08-31T20:32:20Z

## Status
- Fully investigated R2: Non-Truncating DataSnapshot Path Resolution.
  - Located DataSnapshot in `packages/pyric/src/rules/rtdb/grammar/simulator.ts`.
  - Identified root cause in `child()` (line 125 `break;`) and `parent()` (line 145 re-invoking buggy `child()`).
  - Confirmed and reproduced false-allow reproduction where `data.child('a/b/c').parent().exists()` collapses to `/` and evaluates to `true`.
  - Defined exact remediation preserving full virtual path.
- Fully investigated R3: Exhaustive Multi-Path RTDB Validation on Deletions.
  - Located multi-location write / update processing across SDK (`operations.ts`), sandbox write-plane (`write-plane.ts`), rules evaluator (`rules-eval.ts`), and simulation handler (`handler.ts`).
  - Identified root cause in `findFailingValidate`: line 79 (`if (!newData.exists()) return null;`), line 104 (`remainingPath` skipping sibling branches), line 117 (`snapshotChildKeys(newData)` ignoring pre-write deleted keys), and single-path `pathSegments` invocation (lines 339-345) ignoring sibling subtrees affected by deletions.
  - Identified root cause in `WritePlane.update` (line 244/255 shallow multi-key update dropping `updates` and evaluating each leaf independently).
  - Confirmed and reproduced false allow where deleting a node bypasses sibling validation rules enforcing schema invariants.
  - Defined exact remediation evaluating `.validate` across the union of pre-write and post-write paths.
- Proceeding to write `report.md` and `handoff.md`.
