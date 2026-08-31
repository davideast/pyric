# Original User Request

## Initial Request — 2026-08-31T20:26:51Z

Fix critical soundness vulnerabilities (false allows) in Pyric's Security Rules evaluation engines across Firestore, Realtime Database (RTDB), and Cloud Storage to guarantee parity with production Firebase fail-closed security invariants.

Working directory: /Users/deast/repos/davideast/pyric
Integrity mode: development

Note on Domain Model: Firestore and Cloud Storage security rules predate CEL and are CEL-like rather than official CEL. Terminology and semantics should reflect the Firebase Rules Language specification.

## Requirements

### R1. Strict Rules Unary Type Enforcement
In the Firestore and Storage rules expression evaluator, enforce strict boolean operands on unary NOT (`!`) operations. Evaluating negation on non-boolean, null, or undefined values must throw a runtime evaluation error (`RuleEvalError`) and fail closed, matching production Firebase rules behavior.

### R2. Non-Truncating DataSnapshot Path Resolution
In the Realtime Database rules simulator, preserve full path hierarchy when navigating through non-existent or primitive nodes in `DataSnapshot.child()`. Chained `.parent()` calls on missing child snapshots must navigate upward through the full virtual path hierarchy rather than collapsing prematurely to the root node (`/`).

### R3. Exhaustive Multi-Path RTDB Validation on Deletions
In Realtime Database multi-location writes and updates, ensure `.validate` schema rules are evaluated across the union of pre-write and post-write paths. Deletion of subtrees must not bypass sibling validation rules enforcing schema invariants.

### R4. Document Path Canonicalization & Root Clamping
In Firestore security rules evaluation, resolve relative path segments (`..`) and enforce document root containment in `normalizeDocumentPath`. Document lookups via `get()` and `exists()` must not be permitted to escape collection boundaries via unclamped relative traversal.

### R5. Closed-by-Default Unconfigured Sandboxes
Ensure unconfigured or missing security rules across RTDB and Storage sandbox runtimes default to fail-closed deny (`PERMISSION_DENIED`) rather than open-by-default allow.

## Acceptance Criteria

### Correctness & Fail-Closed Parity
- [ ] Evaluating unary `!` on non-boolean or undefined identifiers (e.g. `!request.auth.token.admin` where `admin` is missing) throws a runtime evaluation error and denies access.
- [ ] Calling `data.child('a/b/c').parent().exists()` when `a` does not exist evaluates to `false`.
- [ ] Multi-path updates containing deletions trigger sibling `.validate` rule checks and fail closed if invariants are violated.
- [ ] Document lookups using relative path traversal (e.g., `get(/databases/$(database)/documents/users/../secrets/123)`) cannot access documents outside the clamped collection root.
- [ ] Database or storage operations against unconfigured sandboxes receive permission-denied errors.

### Verification & Regression
- [ ] Existing monorepo test suites pass (`bun test`).
- [ ] Dedicated regression tests are added for each of R1–R5 demonstrating the fix of the previous false-allow behavior.
