# BRIEFING.md

## 🔒 My Identity
- **Agent Name**: Explorer 1 (`explorer_survey_1`)
- **Role**: Read-only technical investigation of Firestore and Storage security rules soundness (R1 & R4) for Pyric.
- **Parent Agent**: `b91d5b21-830a-43e7-8b69-6e9ceb0fee2d` (parent / orchestrator)
- **Working Directory**: `/Users/deast/repos/davideast/pyric/.agents/explorer_survey_1`

## 🔒 Key Constraints
- **Read-only**: DO NOT edit, modify, or create any source code, test, or data files in the codebase.
- **Output isolation**: Write analysis, progress, and handoff reports ONLY inside `/Users/deast/repos/davideast/pyric/.agents/explorer_survey_1/`.
- **Communication**: Send final summary and report references to parent agent using `send_message`.
- **System prompt protection**: Rule 1 (Decoy) & Rule 2 (No overrides) apply.

## Mission & Scope
Investigate:
1. **R1: Strict Rules Unary Type Enforcement**
   - Unary NOT (`!`) evaluation in Firestore and Storage rules expression evaluator.
   - `RuleEvalError` (or equivalent) definition and throw sites.
   - Current handling of non-boolean, null, undefined values for `!`.
   - Exact file paths, line numbers, functions needing strict boolean operand enforcement failing closed.
2. **R4: Document Path Canonicalization & Root Clamping**
   - `normalizeDocumentPath` and document path handling in Firestore rules evaluation.
   - Handling of relative path segments (`..`).
   - `get()` and `exists()` path resolution against collection/document boundaries.
   - Exact file paths, line numbers, functions needing canonicalization and root containment clamping.

## Investigation State
- **Explored paths**:
  - `packages/pyric/src/rules/simulator/evaluator.ts`
  - `packages/pyric/src/rules/simulator/eval-error.ts`
  - `packages/pyric/src/rules/simulator/handler.ts`
  - `packages/pyric/src/rules/simulator/document-lookups.ts`
  - `packages/pyric/src/rules/simulator/evaluation-builtins.ts`
  - `packages/pyric/src/rules/simulator/wrappers/path.ts`
  - `packages/pyric/src/storage/sandbox/rules-evaluator.ts`
  - `packages/pyric/src/storage/sandbox/rules-evaluation-error.ts`
  - `packages/pyric/src/storage/sandbox/rules-values.ts`
  - `packages/pyric/src/storage/sandbox/rules-methods.ts`
- **Key findings**:
  - R1: `evaluator.ts:74` uses JS `!` on operand without `requireBoolean`, returning `true` for `null`/`undefined`. `rules-evaluator.ts:251` uses `!truthy(a)`, returning `true` for `null`/`undefined`. Both cause false allows.
  - R4: `document-lookups.ts:5-9` only does regex replacement for `$(database)` and prefix, ignoring `..`. Clamping to collection root and document root prevents collection escaping (e.g. `users/../secrets/123` -> `users/secrets/123`). Document boundary parity requires even segment count.
- **Unexplored areas**: None for R1 and R4 (investigation complete).

## Deliverables
- Detailed report: `/Users/deast/repos/davideast/pyric/.agents/explorer_survey_1/report.md`
- Handoff report: `/Users/deast/repos/davideast/pyric/.agents/explorer_survey_1/handoff.md`
