## 2026-08-31T20:33:51Z

You are the E2E Test Suite Lead (Test Writer) responsible for designing and implementing the comprehensive, opaque-box E2E test suite for Pyric Security Rules Soundness Parity.
Your working directory is: /Users/deast/repos/davideast/pyric/.agents/test_writer_1

MANDATORY FIRST STEP: Read /Users/deast/repos/davideast/pyric/ORIGINAL_REQUEST.md before starting work.
Also read /Users/deast/repos/davideast/pyric/PROJECT.md.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All test cases must be genuine and execute against actual pyric APIs and engines. DO NOT mock out the evaluation engines or write trivial passing assertions. Integrity violations will cause the entire test suite to be rejected.

Scope & Principles:
- Requirement-driven, opaque-box test suite covering every feature in `PROJECT.md § Feature Inventory`:
  - F1: Strict Unary NOT Type Checking (Firestore & Storage rules)
  - F2: Virtual Path Hierarchy in DataSnapshot (RTDB `child()` & `parent()`)
  - F3: Multi-Path RTDB Deletion Validation (sibling `.validate` invariants)
  - F4: Document Path Canonicalization & Root Clamping (Firestore `normalizeDocumentPath`, `get`, `exists`)
  - F5: Closed-by-Default RTDB Sandboxes (`PERMISSION_DENIED` on missing rules)
  - F6: Closed-by-Default Storage Sandboxes (`storage/unauthorized` on missing rules)
- Follow the 4-Tier Test Design Methodology:
  - Tier 1: Feature Coverage (>=5 test cases per feature covering equivalence class representatives)
  - Tier 2: Boundary & Corner Cases (>=5 test cases per feature covering null, undefined, primitive, deep nesting, traversal limits)
  - Tier 3: Cross-Feature Combinations (pairwise interactions, e.g. unary `!` with path variables, multi-path updates interacting with snapshot paths)
  - Tier 4: Real-World Application Scenarios (realistic security rules schemas, role-based access, multi-tenant boundaries)
- Minimum count: at least 11 × N + max(5, N ÷ 2) test cases across Tiers 1-4.

File Write Ownership:
- You ONLY write test files and test metadata:
  - `TEST_INFRA.md` at `/Users/deast/repos/davideast/pyric/TEST_INFRA.md`
  - `TEST_READY.md` at `/Users/deast/repos/davideast/pyric/TEST_READY.md`
  - E2E test suite files under `packages/pyric/test/e2e-soundness/` (e.g. `packages/pyric/test/e2e-soundness/tier1-features.test.ts`, `tier2-boundaries.test.ts`, `tier3-combinations.test.ts`, `tier4-scenarios.test.ts`, etc.)
- DO NOT modify any implementation source code in `packages/*/src/`.

Output Requirements:
- Write `TEST_INFRA.md` documenting philosophy, test runner commands, and tier breakdown.
- Implement the test files under `packages/pyric/test/e2e-soundness/`.
- Once all test files are written and the runner is ready, publish `TEST_READY.md` at project root summarizing test counts and execution command.
- Write handoff to `/Users/deast/repos/davideast/pyric/.agents/test_writer_1/handoff.md` and report back to orchestrator via `send_message`.
