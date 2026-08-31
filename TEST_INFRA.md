# Pyric Security Rules Soundness Parity: Test Infrastructure & Architecture Specification

## 1. Overview & Testing Philosophy

The Pyric Security Rules Soundness Parity test infrastructure provides exhaustive, requirement-driven, opaque-box end-to-end verification for Pyric's security rules evaluation engines across Firestore, Realtime Database (RTDB), and Cloud Storage.

### 1.1 Core Principles
1. **Opaque-Box Verification**: Tests interact exclusively through public APIs, simulation handlers, and sandbox facades (`SimulateFirestoreRulesHandler`, `evaluateStorageRules`, `DataSnapshot`, `SimulateHandler`, `getDatabase`, `getStorageSandbox`). Internal private implementation details are not mocked.
2. **Fail-Closed Security Invariants**: Parity with production Firebase requires that any syntax error, type violation, path traversal attempt, or unconfigured service defaults to fail-closed deny (`PERMISSION_DENIED` or `storage/unauthorized`).
3. **No Facade or Trivial Tests**: All assertions exercise real AST evaluators, Ohm grammar interpreters, WritePlanes, and storage enforcement pipelines. No mock engines or tautological assertions (`expect(true).toBe(true)`) are permitted.
4. **Deterministic Oracle Derivation**: Expected outputs are derived directly from documented Firebase Security Rules language specifications, production Firebase fail-closed invariants, and requirements documented in `ORIGINAL_REQUEST.md` and `PROJECT.md`.

---

## 2. Feature Inventory Mapping

| Feature ID | Feature Name | Engine Scope | Key Invariant |
|---|---|---|---|
| **F1** | Strict Unary NOT Type Checking | Firestore & Cloud Storage Rules Evaluators | Unary `!` operand must be strictly boolean; non-boolean, null, or undefined operands throw runtime evaluation error and fail closed (DENY). |
| **F2** | Virtual Path Hierarchy in DataSnapshot | RTDB Rules Simulator (`DataSnapshot`) | Full virtual path hierarchy is preserved across non-existent or primitive nodes; chained `.parent()` calls traverse upward without premature collapse to root (`/`). |
| **F3** | Multi-Path RTDB Deletion Validation | RTDB Multi-Location Updates & Simulator | Subtree deletions in multi-path writes evaluate `.validate` rules across the union of pre-write and post-write paths; surviving sibling schema invariants cannot be bypassed. |
| **F4** | Document Path Canonicalization & Root Clamping | Firestore Rules (`normalizeDocumentPath`, `get`, `exists`) | Resolves relative segments (`.` and `..`), clamps traversal at document/collection root, and enforces even segment count parity for documents. |
| **F5** | Closed-by-Default RTDB Sandboxes | RTDB Sandbox Runtime (`RulesEvaluator`, `WritePlane`) | Unconfigured or missing security rules default to `deny`; client reads and writes throw `PERMISSION_DENIED` while preserving `/.info/*` metadata and admin handle access. |
| **F6** | Closed-by-Default Storage Sandboxes | Storage Sandbox Runtime (`enforceRules`) | Unconfigured or missing rules (`service.rules === null`) fail-closed with `storage/unauthorized` on client operations while preserving admin handle bypass. |

---

## 3. 4-Tier Test Design Methodology

The test suite implements a 4-Tier architecture guaranteeing comprehensive coverage:

### Tier 1: Feature Coverage (Equivalence Classes)
- **File**: `packages/pyric/test/e2e-soundness/tier1-features.test.ts`
- **Objective**: Target each feature in isolation with representative equivalence classes.
- **Criteria**: $\ge 5$ test cases per feature covering primary happy paths and negative fail-closed paths.
- **Scope**:
  - F1: Firestore & Storage unary `!` on `true`, `false`, `null`, undefined token claims, string, number.
  - F2: `DataSnapshot.child()` and `.parent()` navigation, virtual paths on missing nodes, root boundary.
  - F3: Sibling `.validate` enforcement on multi-path updates deleting required dependent fields.
  - F4: Document path normalization with `..`, `.`, root clamping, and segment parity validation.
  - F5: Unconfigured RTDB sandbox rejecting client mutations/reads while allowing `/.info/` and admin bypass.
  - F6: Unconfigured Storage sandbox rejecting client upload/download/list while allowing admin bypass.

### Tier 2: Boundary & Corner Cases
- **File**: `packages/pyric/test/e2e-soundness/tier2-boundaries.test.ts`
- **Objective**: Adversarial edge cases, type boundaries, empty states, and traversal limits.
- **Criteria**: $\ge 5$ test cases per feature.
- **Scope**:
  - F1: Falsy JS values (`""`, `0`, `[]`, `{}`) that in JS coerce to `false` (making `!val` true) but in rules MUST fail closed with evaluation errors. Double negation `!!val`.
  - F2: Navigation through primitive leaves (number, boolean, string), 10-level deep virtual paths, consecutive slashes `///`, trailing slashes, empty strings.
  - F3: Simultaneous multi-path deletions, nested deletions below wildcard nodes, atomic updates deleting all child keys.
  - F4: Excessive `../../../../` root escape attempts, odd segment counts, trailing dots, empty collection paths.
  - F5: Dynamic reset to null rules (`setRules(db, null)`), deep path mutations under default deny, root path reads.
  - F6: Unconfigured storage operations with deep paths, empty prefix `listAll`, metadata updates, multi-tenant sandbox isolation.

### Tier 3: Cross-Feature Combinations
- **File**: `packages/pyric/test/e2e-soundness/tier3-combinations.test.ts`
- **Objective**: Pairwise and multi-feature interaction testing across service boundaries.
- **Scope**:
  - F1 + F4: Unary `!` combined with canonicalized document lookups (`!exists(/databases/.../../doc)`).
  - F1 + F2: RTDB rule expressions combining unary `!` with virtual `DataSnapshot.child().parent().exists()`.
  - F2 + F3: Multi-path updates validating against virtual path snapshots created via `child()` and `parent()`.
  - F1 + F5: RTDB sandbox lifecycle transitioning from unconfigured default deny to configured strict rules.
  - F1 + F6: Storage sandbox transition from unconfigured default deny to configured rules with strict boolean expressions.
  - F3 + F5: Admin database bypass seeding initial data tree followed by client multi-path deletion triggering sibling validate.
  - F4 + F6: Storage rules utilizing Firestore cross-service lookup `firestore.get()` with canonicalized paths and strict negation.

### Tier 4: Real-World Application Scenarios
- **File**: `packages/pyric/test/e2e-soundness/tier4-scenarios.test.ts`
- **Objective**: End-to-end integration scenarios simulating real-world production architectures.
- **Scope**:
  - Multi-Tenant SaaS isolation with tenant path clamping and claim verification.
  - E-Commerce order state machine enforcing sibling payment/invoice invariants on multi-path updates.
  - Role-Based Access Control (RBAC) across Cloud Storage and Firestore user documents with strict flag checks.
  - Social Network activity feed with atomic deletion invariants and virtual follower snapshots.
  - Secure Document Management System with audit log enforcement and sandbox lifecycle transitions.

---

## 4. Test Suite Execution & Runner Guide

The test suite is powered by `bun test`.

### 4.1 Running All E2E Soundness Tests
```bash
bun test packages/pyric/test/e2e-soundness/
```

### 4.2 Running Specific Tiers
```bash
# Tier 1: Feature Coverage
bun test packages/pyric/test/e2e-soundness/tier1-features.test.ts

# Tier 2: Boundary & Corner Cases
bun test packages/pyric/test/e2e-soundness/tier2-boundaries.test.ts

# Tier 3: Cross-Feature Combinations
bun test packages/pyric/test/e2e-soundness/tier3-combinations.test.ts

# Tier 4: Real-World Application Scenarios
bun test packages/pyric/test/e2e-soundness/tier4-scenarios.test.ts
```

### 4.3 Running Specific Features via Filter
```bash
# Test only F1 (Unary NOT)
bun test packages/pyric/test/e2e-soundness/ --filter "F1"

# Test only F2 (Virtual Path)
bun test packages/pyric/test/e2e-soundness/ --filter "F2"

# Test only F3 (Multi-Path Validation)
bun test packages/pyric/test/e2e-soundness/ --filter "F3"

# Test only F4 (Document Path Normalization)
bun test packages/pyric/test/e2e-soundness/ --filter "F4"

# Test only F5 (Closed-by-Default RTDB)
bun test packages/pyric/test/e2e-soundness/ --filter "F5"

# Test only F6 (Closed-by-Default Storage)
bun test packages/pyric/test/e2e-soundness/ --filter "F6"
```

### 4.4 Running Full Monorepo Tests
```bash
bun test
```

---

## 5. Minimum Test Count Calculation

Per project specifications, the minimum test count across Tiers 1–4 is:
$$\text{Count} \ge 11 \times N + \max(5, \lfloor N / 2 \rfloor)$$
For $N = 6$ features (F1 through F6):
$$\text{Count} \ge 11 \times 6 + \max(5, 3) = 66 + 5 = 71\text{ tests}$$

The implemented test suite provides **98 comprehensive test cases**:
- Tier 1: 36 test cases (6 features $\times$ 6 tests)
- Tier 2: 36 test cases (6 features $\times$ 6 tests)
- Tier 3: 14 test cases
- Tier 4: 12 test cases
- **Total**: 98 tests ($> 71$ threshold by $+38\%$).
