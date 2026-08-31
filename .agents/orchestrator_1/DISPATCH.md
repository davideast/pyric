## 2026-08-31T20:27:37Z

You are the Project Orchestrator for Pyric Security Rules Soundness Parity.
Your working directory is: /Users/deast/repos/davideast/pyric/.agents/orchestrator_1
The workspace directory is: /Users/deast/repos/davideast/pyric
The original user request is documented in: /Users/deast/repos/davideast/pyric/ORIGINAL_REQUEST.md

Task Summary:
Fix critical soundness vulnerabilities (false allows) in Pyric's Security Rules evaluation engines across Firestore, Realtime Database (RTDB), and Cloud Storage to guarantee parity with production Firebase fail-closed security invariants.

Domain Model: Firestore and Cloud Storage security rules predate CEL and are CEL-like rather than official CEL. Terminology and semantics should reflect the Firebase Rules Language specification.

Requirements:
- R1. Strict Rules Unary Type Enforcement: In Firestore and Storage rules expression evaluator, enforce strict boolean operands on unary NOT (!) operations. Negation on non-boolean, null, or undefined values must throw a runtime evaluation error (RuleEvalError) and fail closed.
- R2. Non-Truncating DataSnapshot Path Resolution: In RTDB rules simulator, preserve full path hierarchy when navigating through non-existent or primitive nodes in DataSnapshot.child(). Chained .parent() calls on missing child snapshots must navigate upward through the full virtual path hierarchy rather than collapsing prematurely to root (/).
- R3. Exhaustive Multi-Path RTDB Validation on Deletions: In RTDB multi-location writes and updates, ensure .validate schema rules are evaluated across the union of pre-write and post-write paths. Deletion of subtrees must not bypass sibling validation rules enforcing schema invariants.
- R4. Document Path Canonicalization & Root Clamping: In Firestore security rules evaluation, resolve relative path segments (..) and enforce document root containment in normalizeDocumentPath. Document lookups via get() and exists() must not be permitted to escape collection boundaries via unclamped relative traversal.
- R5. Closed-by-Default Unconfigured Sandboxes: Ensure unconfigured or missing security rules across RTDB and Storage sandbox runtimes default to fail-closed deny (PERMISSION_DENIED) rather than open-by-default allow.

Acceptance Criteria:
1. Evaluating unary ! on non-boolean or undefined identifiers (e.g. !request.auth.token.admin where admin is missing) throws runtime evaluation error and denies access.
2. Calling data.child('a/b/c').parent().exists() when a does not exist evaluates to false.
3. Multi-path updates containing deletions trigger sibling .validate rule checks and fail closed if invariants are violated.
4. Document lookups using relative path traversal (e.g., get(/databases/$(database)/documents/users/../secrets/123)) cannot access documents outside clamped collection root.
5. Database or storage operations against unconfigured sandboxes receive permission-denied errors.
6. Existing monorepo test suites pass (`bun test`).
7. Dedicated regression tests are added for each of R1–R5 demonstrating the fix of the previous false-allow behavior.
