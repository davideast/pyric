# Plan — Pyric Security Rules Soundness Parity

## Objective
Remediate 5 critical security soundness vulnerabilities (false allows) in Pyric across Firestore, RTDB, and Cloud Storage to guarantee parity with production Firebase fail-closed invariants.

## Scope Breakdown
- **R1: Strict Rules Unary Type Enforcement** (Firestore & Storage rules AST/evaluator)
  - Unary `!` on non-boolean/null/undefined must throw `RuleEvalError` and fail closed.
- **R2: Non-Truncating DataSnapshot Path Resolution** (RTDB rules simulator)
  - `DataSnapshot.child().parent()` on missing or primitive nodes preserves virtual path hierarchy.
- **R3: Exhaustive Multi-Path RTDB Validation on Deletions** (RTDB rules simulator)
  - Multi-location writes/updates check `.validate` on union of pre-write and post-write paths.
- **R4: Document Path Canonicalization & Root Clamping** (Firestore rules evaluator)
  - `normalizeDocumentPath` resolves `..` and clamps within document root boundaries; `get()` and `exists()` cannot escape.
- **R5: Closed-by-Default Unconfigured Sandboxes** (RTDB & Storage sandboxes)
  - Missing or unconfigured rules evaluate to fail-closed `PERMISSION_DENIED`.

## Execution Phases
1. **Phase 0: Architectural Survey & Discovery**
   - Dispatch 3 parallel Explorers to investigate relevant modules, existing test harnesses, build commands, and pinpoint the exact files and lines responsible for R1-R5.
2. **Phase 1: Feature Inventory & Interface Contracts**
   - Synthesize explorer reports into `PROJECT.md`.
3. **Phase 2: Implementation & Iteration Loops**
   - Assign Worker(s) to implement fixes adhering strictly to Firebase Rules Language specification and fail-closed invariants.
   - Run unit tests and monorepo test suite (`bun test`).
4. **Phase 3: Review, Adversarial Challenge, & Forensic Audit**
   - 2 Reviewers independently verify correctness, robustness, and conformance.
   - 2 Challengers generate edge cases, fuzzing, and adversarial stress tests.
   - 1 Forensic Auditor verifies no test hardcoding, facade bypasses, or integrity violations.
5. **Phase 4: Gate Clearance & Sentinel Handoff**
   - Ensure all gate criteria are met (Build/test pass + APPROVE from reviewers + clean audit).
   - Deliver comprehensive completion report to Sentinel.
