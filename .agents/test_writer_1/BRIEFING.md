# Briefing

## 🔒 My Identity
- Agent: test_writer_1
- Role: specialist, qa (E2E Test Suite Lead / Test Writer)
- Mission: Design and implement comprehensive, opaque-box E2E test suite for Pyric Security Rules Soundness Parity (F1–F6) covering Firestore, RTDB, and Cloud Storage security rules soundness fixes across 4 tiers.

## 🔒 Key Constraints
- Write and modify TEST CODE AND TEST METADATA ONLY (`TEST_INFRA.md`, `TEST_READY.md`, `packages/pyric/test/e2e-soundness/**`).
- NEVER modify implementation source code (`packages/*/src/**`).
- DO NOT CHEAT: All test cases must be genuine and execute against actual pyric APIs and engines. No mocking out evaluation engines or trivial passing assertions.
- 4-Tier Test Design Methodology:
  - Tier 1: Feature Coverage (>=5 test cases per feature covering equivalence class representatives)
  - Tier 2: Boundary & Corner Cases (>=5 test cases per feature covering null, undefined, primitive, deep nesting, traversal limits)
  - Tier 3: Cross-Feature Combinations (pairwise interactions)
  - Tier 4: Real-World Application Scenarios (realistic security rules schemas, role-based access, multi-tenant boundaries)
- Minimum count: at least 11 × N + max(5, N ÷ 2) test cases across Tiers 1-4. For N=6 features, 11 × 6 + 5 = 71 tests minimum.

## Loaded Skills
- None specified in prompt.

## Quality Status
- Build/test result: 98 E2E soundness tests implemented across 4 test files. Ran in ~210ms via `bun test packages/pyric/test/e2e-soundness/`. Currently 57 passing, 41 failing (characterizing in-progress fixes in F3, F4, F5, F6).
- Lint status: Clean (`bun run --cwd packages/pyric typecheck` exited 0).
- Tests added/modified:
  - `packages/pyric/test/e2e-soundness/tier1-features.test.ts` (38 tests)
  - `packages/pyric/test/e2e-soundness/tier2-boundaries.test.ts` (36 tests)
  - `packages/pyric/test/e2e-soundness/tier3-combinations.test.ts` (12 tests)
  - `packages/pyric/test/e2e-soundness/tier4-scenarios.test.ts` (12 tests)
  - `TEST_INFRA.md` published at repo root
  - `TEST_READY.md` published at repo root
