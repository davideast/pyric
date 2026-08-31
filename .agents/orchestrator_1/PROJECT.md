# Project: Pyric Security Rules Soundness Parity

## Architecture
Pyric provides lightweight, fast local emulators/sandboxes for Firebase services, including Firestore, Realtime Database (RTDB), and Cloud Storage. Each service contains a security rules evaluation engine:
- **Firestore & Cloud Storage**: CEL-like expression evaluation language. Operates on AST nodes parsed from security rules declarations, evaluating expressions with typed values, helper functions, and context objects (`request`, `resource`). Must fail-closed on type errors and invalid operations.
- **Realtime Database**: Hierarchical tree-based rules language with `.read`, `.write`, and `.validate` rules. Evaluated against `data` and `newData` `DataSnapshot` objects. Multi-location updates (`update()`) write multiple paths simultaneously and require schema `.validate` rules to pass across the entire modified dataset.
- **Sandbox Default Posture**: Unconfigured or missing rules across RTDB and Storage sandbox runtimes must default to fail-closed (`PERMISSION_DENIED`) rather than permitting unrestricted access.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Strict Unary NOT Type Checking | Enforce strict boolean operands on unary `!` operations in Firestore (`requireBoolean`) and Storage (`RuleEvalError`); fail-closed on non-boolean, null, undefined. | M1 | ORIGINAL_REQUEST §R1, Explorer 1 |
| F2 | Virtual Path Hierarchy in DataSnapshot | Preserve full virtual path hierarchy across non-existent/primitive child navigations in RTDB `DataSnapshot.child()`; chained `.parent()` navigates virtual ancestors without collapsing to root. | M2 | ORIGINAL_REQUEST §R2, Explorer 2 |
| F3 | Multi-Path RTDB Deletion Validation | Evaluate `.validate` schema rules across the union of pre-write and post-write paths in RTDB multi-location updates and deletes; ensure surviving sibling invariants cannot be bypassed. | M3 | ORIGINAL_REQUEST §R3, Explorer 2 |
| F4 | Document Path Canonicalization & Root Clamping | Resolve relative path segments (`..`) in `normalizeDocumentPath`, clamp within document root and collection boundaries; disallow collection boundary escape in `get()`, `exists()`, and `existsAfter()`. | M4 | ORIGINAL_REQUEST §R4, Explorer 1 |
| F5 | Closed-by-Default RTDB Sandboxes | Default RTDB `rules-eval.ts` policy to `deny` when unconfigured or missing rules; return `PERMISSION_DENIED` on client data operations while preserving `/.info/` access. | M5 | ORIGINAL_REQUEST §R5, Explorer 3 |
| F6 | Closed-by-Default Storage Sandboxes | Deny client operations (upload, download, list) in Storage `enforce.ts` when `service.rules` is null; throw `unauthorized` (`storage/unauthorized`) while preserving admin bypass. | M5 | ORIGINAL_REQUEST §R5, Explorer 3 |
| F7 | Full Monorepo Test Suite & Regression Suite | Ensure all existing monorepo tests (`bun test`) pass, and add dedicated regression suites demonstrating the fixes for F1–F6. | M6 | ORIGINAL_REQUEST §Verification, Explorer 3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Strict Rules Unary Type Enforcement | Implement strict boolean validation for unary `!` in Firestore (`packages/pyric/src/rules/simulator/evaluator.ts`) and Storage (`packages/pyric/src/storage/sandbox/rules-evaluator.ts`), throwing `EvalError` / `RuleEvalError`. | None | PLANNED |
| M2 | Non-Truncating DataSnapshot Path Resolution | Remove premature loop break in `packages/pyric/src/rules/rtdb/grammar/simulator.ts:child()`, maintain full virtual paths and correct `.parent()` traversal. | None | PLANNED |
| M3 | Exhaustive Multi-Path RTDB Validation on Deletions | Update `packages/pyric/src/rules/rtdb/simulation/handler.ts` and `packages/pyric/src/database/sandbox/write-plane.ts` to evaluate `.validate` on union of pre-write and post-write paths. | M2 | PLANNED |
| M4 | Document Path Canonicalization & Root Clamping | Update `packages/pyric/src/rules/simulator/document-lookups.ts` `normalizeDocumentPath` to resolve `..` with root and collection boundary clamping, plus even segment parity validation. | None | PLANNED |
| M5 | Closed-by-Default Unconfigured Sandboxes | Change default RTDB policy to `'deny'` in `packages/pyric/src/database/sandbox/rules-eval.ts`; enforce fail-closed deny in Storage `packages/pyric/src/storage/enforce.ts`; update test harness setups. | None | PLANNED |
| M6 | Monorepo Verification & Adversarial Hardening | Run full `bun test` across monorepo packages, verify all dedicated regression test suites for R1–R5, run Challenger stress tests, and execute Forensic Audit. | M1, M2, M3, M4, M5 | PLANNED |

## Interface Contracts
### Rules Unary `!` Operator (Firestore & Storage)
- **Input**: Expression operand `expr.operand`
- **Behavior**: If operand is not strictly a boolean (`typeof v !== 'boolean'`), throw `EvalError` (Firestore) or `RuleEvalError` (Storage).
- **Result**: Evaluator catches error and marks rule verdict as `DENY` / fails closed.

### RTDB `DataSnapshot.child(path)` & `DataSnapshot.parent()`
- **Input**: Path string (e.g. `'a/b/c'`).
- **Behavior**: Iterate through all segments. Even if intermediate value is `null`, `undefined`, or primitive, `_path` must reflect the complete virtual path (`/a/b/c`).
- **Parent navigation**: `.parent()` removes the trailing path segment without collapsing to `/`. If parent path does not exist, `.exists()` returns `false`.

### RTDB Multi-Path Validation
- **Input**: Write operation with `updates` list and `mergedRootData`.
- **Behavior**: All paths modified or deleted, plus all sibling nodes sharing an ancestor with the write locations, must have their `.validate` rules evaluated against `mergedRootData`.
- **Failure**: Any failing `.validate` rule returns `allowed: false`.

### Firestore `normalizeDocumentPath(path)`
- **Input**: Document path string from `get()`, `exists()`, `getAfter()`, etc.
- **Behavior**: Strips `/databases/(default)/documents/`, resolves relative segments `.` and `..`, clamps within collection/document root so traversal cannot escape collection boundaries, and enforces even segment count.

### Sandbox Default Security Policy
- **RTDB**: Missing rules evaluate to `check: 'no-rule'`, throwing `PERMISSION_DENIED` on client data access. System paths `/.info/*` remain accessible. Admin handles bypass rules.
- **Storage**: `service.rules === null` throws `unauthorized` (`storage/unauthorized`) on client operations. Admin handles (`target.admin === true`) bypass rules.

## Code Layout
- `packages/pyric/src/rules/simulator/evaluator.ts` (Firestore unary `!`)
- `packages/pyric/src/storage/sandbox/rules-evaluator.ts` (Storage unary `!`)
- `packages/pyric/src/rules/rtdb/grammar/simulator.ts` (RTDB `DataSnapshot.child`/`parent`)
- `packages/pyric/src/rules/rtdb/simulation/handler.ts` (RTDB `.validate` traversal)
- `packages/pyric/src/database/sandbox/write-plane.ts` (RTDB multi-path update dispatch)
- `packages/pyric/src/rules/simulator/document-lookups.ts` (Firestore path canonicalization)
- `packages/pyric/src/database/sandbox/rules-eval.ts` (RTDB default deny)
- `packages/pyric/src/database/sandbox-controls.ts` (RTDB sandbox controls export)
- `packages/pyric/src/storage/enforce.ts` (Storage default deny)
- `packages/pyric/test/rules/simulator/` (Firestore rules tests)
- `packages/pyric/test/rules/rtdb/` (RTDB rules tests)
- `packages/pyric/test/storage/` (Storage rules tests)
- `packages/pyric/test/database/` (RTDB sandbox tests)
