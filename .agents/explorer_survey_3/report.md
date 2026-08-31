# Pyric Investigation Report: Requirement R5 & Test Infrastructure

**Agent**: Explorer 3  
**Date**: 2026-08-31  
**Scope**: Requirement R5 (Closed-by-Default Unconfigured Sandboxes for RTDB and Storage) and Monorepo Build & Test Infrastructure.

---

## Executive Summary

This investigation analyzed Pyric's sandbox runtimes across Realtime Database (RTDB) and Cloud Storage, as well as the monorepo build and testing infrastructure. 

Current Pyric RTDB and Storage sandbox runtimes default to open-by-default allow when security rules are unconfigured or missing. This violates production Firebase security invariants where unconfigured services reject client operations.

We have identified:
1. The exact runtime files and mechanisms controlling rules evaluation and default policy in RTDB and Storage.
2. The root causes of open-by-default behavior in both engines.
3. The exact lines of code and remediation logic required to fail-closed deny (`PERMISSION_DENIED` in RTDB, `storage/unauthorized` in Storage).
4. The full structure of the Bun workspace monorepo, test suites, execution commands, and existing test coverage.
5. Concrete test placements and test specifications for regression suites covering requirements R1 through R5.

---

## Part 1: Requirement R5 — Closed-by-Default Unconfigured Sandboxes

### 1.1 Realtime Database (RTDB) Sandbox Runtime

#### A. Architecture & File Locations
The RTDB sandbox runtime is structured into distinct layers:

1. **Client & App Facades**:
   - `packages/pyric/src/database/instances.ts`: Exports `getDatabase(target)` and `getAdminDatabase(target)`. Resolves `FirebaseApp`, `Sandbox`, or `SandboxContext` to an `RtdbBackend` via `getOrCreateBackend(sandbox)`.
   - `packages/pyric/src/database/routing.ts`: Target tagging (`kind: 'sandbox' | 'sandbox-live'`) and internal target extraction (`targetOf`).

2. **Sandbox Singleton & Lifecycle**:
   - `packages/pyric/src/database/sandbox/backend-for.ts`: Maintains a `WeakMap<Sandbox, RtdbBackend>` so each `Sandbox` instance shares exactly one backend instance. Registers the `'rtdb'` persistable service for snapshots, restores, and resets.
   - `packages/pyric/src/database/sandbox/backend.ts`: `RtdbBackend` facade coordinating `BackendState`, `WritePlane`, `ValueListeners`, `ChildListeners`, `Transactions`, and `PersistenceState`.
   - `packages/pyric/src/database/sandbox/backend-state.ts`: Contains the in-memory `DataTree`, `PriorityState`, `MutationHistory`, and creates `readonly rules = new RulesEvaluator();` and `activeRules: { rules: Record<string, unknown> } | null = null;`.

3. **Rules Evaluation & Execution Planes**:
   - `packages/pyric/src/database/sandbox/rules-eval.ts`: Defines `RulesEvaluator`, `permissionDenied()` error constructor, and evaluation context types.
   - `packages/pyric/src/database/sandbox/write-plane.ts`: `WritePlane` class containing `get()`, `getQuery()`, `set()`, `remove()`, `update()`, `validateSet()`, `validateUpdate()`, and `cancelDeniedListeners()`. Evaluates operations against `this.state.rules.evaluate(...)` and throws `permissionDenied()` if `evaluation.check !== 'allow'`.

4. **Sandbox Controls & CLI Worker Boot**:
   - `packages/pyric/src/database/sandbox-namespace.ts`: `sandbox` namespace containing `setDefaultPolicy(db, policy)`, `setRules(db, rulesJson)`, `DEFAULT_DENY_RTDB_RULES`, `DEFAULT_OPEN_RTDB_RULES`.
   - `packages/pyric/src/database/sandbox-controls.ts`: Public `pyric/sandbox/database` exports (`setRules`, `getActiveRules`, `setData`, `snapshotState`).
   - `packages/cli/src/serve/worker/serve-init.ts`: Worker boot initialization (lines 224–238) configuring RTDB rules or setting default policy.

#### B. Where Security Rules are Configured or Loaded
Security rules for RTDB are loaded/configured in three places:
1. **In-Page / Modular Sandbox API**: Calling `sandbox.setRules(db, rulesJson)` (`packages/pyric/src/database/sandbox-namespace.ts:53`) or `setRules(sandbox, rulesJson)` (`packages/pyric/src/database/sandbox-controls.ts:10`). Both forward to `backend.setRules(rulesJson)` -> `writePlane.setRules(rulesJson)` -> `RulesEvaluator.setRules(rulesJson)`.
2. **Compiled Rules Seam**: `RulesEvaluator.setRules` calls `compileRtdbRules(rulesJson)` from `packages/pyric/src/rules/rtdb/compiled-rules.ts`.
3. **CLI / Worker Server**: In `packages/cli/src/serve/rules.ts`, rules are loaded from `database.rules.json` (or `firebase.json#database.rules`). During worker init (`packages/cli/src/serve/worker/serve-init.ts:225–238`), if `payload.databaseRules` is provided, `rtdbSandbox.setRules(rtdb, payload.databaseRules)` is called. If absent and `payload.permissive` is false, it sets `rtdbSandbox.setDefaultPolicy(rtdb, 'deny')`.

#### C. Why Unconfigured Rules Currently Allow by Default
In `packages/pyric/src/database/sandbox/rules-eval.ts`:
- **Line 102**:
  ```ts
  private defaultPolicy: RtdbDefaultPolicy = 'allow';
  ```
- **Lines 171–184**:
  ```ts
  if (this.compiled === null) {
    if (this.defaultPolicy === 'deny') {
      return {
        check: 'no-rule',
        reasons: ['No RTDB rules loaded; default deny.'],
        errorCode: 'NO_MATCHING_RULE',
        errorMessage: 'No RTDB rules loaded; default deny.',
      };
    }
    return {
      check: 'allow',
      reasons: ['No RTDB rules loaded; default allow.'],
    };
  }
  ```
When a developer calls `initializeSandbox()` and then `getDatabase(sandbox)` without explicitly configuring rules or calling `setDefaultPolicy`, `this.compiled` is `null`. Because `this.defaultPolicy` initializes to `'allow'`, every write and read evaluates to `{ check: 'allow' }`.

#### D. Exact Remediation Logic for RTDB
1. **Target File**: `packages/pyric/src/database/sandbox/rules-eval.ts`
   - **Line 102**:
     ```ts
     // BEFORE:
     private defaultPolicy: RtdbDefaultPolicy = 'allow';

     // AFTER:
     private defaultPolicy: RtdbDefaultPolicy = 'deny';
     ```
   - **Lines 17–22 & 125**: Update docstring comments to declare fail-closed deny parity with Firebase production.
2. **Target File**: `packages/pyric/src/database/sandbox-controls.ts`
   - Line 9: Update docstring for `setRules`: `Pass null to restore default deny.`
   - Export `setDefaultPolicy(sandbox: LocalSandbox, policy: 'allow' | 'deny'): void` delegating to `getOrCreateBackend(sandbox).setDefaultPolicy(policy)` for parity with `sandbox-namespace.ts`.
3. **Special Cases Preserved**:
   - **System Metadata Paths**: Lines 147–170 of `rules-eval.ts` already permit reading `/.info` and `/.info/*` (e.g. `/.info/serverTimeOffset`, `/.info/connected`) regardless of security rules, preserving RTDB SDK handshake compatibility.
   - **Admin Handles**: `getAdminDatabase(sandbox)` bypasses rule checks entirely via `adminGet`, `adminSet`, etc. in `WritePlane`.

---

### 1.2 Storage Sandbox Runtime

#### A. Architecture & File Locations
The Storage sandbox runtime is structured into:

1. **Client & App Handles**:
   - `packages/pyric/src/storage/instances.ts`: `getStorage(app, bucketUrl)` maps `FirebaseApp` to `getStorageSandbox`.
   - `packages/pyric/src/storage/service.ts`: Core handle factory `getStorageSandbox(target, options)`, internal admin factory `getAdminStorageSandbox(target, options)`, and service lifecycle `StorageService`.
   - `packages/pyric/src/storage/reference.ts`: `ref(storage, path)` producing `StorageReference`.

2. **Gated Operations**:
   - `packages/pyric/src/storage/upload.ts`: `uploadBytes`, `uploadString`.
   - `packages/pyric/src/storage/download.ts`: `getBytes`, `getBlob`, `getDownloadURL`, `deleteObject`.
   - `packages/pyric/src/storage/metadata.ts`: `getMetadata`, `updateMetadata`.
   - `packages/pyric/src/storage/list.ts`: `listAll`.

3. **Rules Enforcement & Error Dispatch**:
   - `packages/pyric/src/storage/enforce.ts`: `enforceRules(service, input, target, provenance)`. Central bottleneck for all rules checks.
   - `packages/pyric/src/storage/sandbox/rules-evaluator.ts`: AST evaluation of storage rules.
   - `packages/pyric/src/storage/errors.ts`: `StorageError` class and `unauthorized(method, path, detail)` factory (`code === 'storage/unauthorized'`).

#### B. Where Security Rules are Configured or Loaded
1. Rules are supplied to `getStorageSandbox(target, options: StorageOptions)` via `options.rules?: string`.
2. Inside `ensureService(sandbox, options, caller)` (`packages/pyric/src/storage/service.ts:175–247`):
   - Rules are parsed using `parseStorageRules(source)` (and resolved via `resolveModulesBrowser` if using `2+modules`).
   - The compiled `StorageRules` are attached to `StorageService(backend, rules)`.
   - Rules are only accepted on the **FIRST** storage call for a `Sandbox`. Subsequent differing rules throw to prevent silent rules wipes.
   - If `options.rules` is omitted, `service.rules` is `null`.
3. In the CLI worker (`packages/cli/src/serve/worker/serve-init.ts:254–257`), `getStorageSandbox` is initialized with `payload.storageRules` if provided.

#### C. Why Unconfigured Rules Currently Allow by Default
In `packages/pyric/src/storage/enforce.ts`:
- **Lines 7–10**:
  ```ts
  * Behavior:
  *   - No rules configured → allow. The v1 scope's session-archive
  *     ruleset is opt-in; bare `getStorage` with no `rules` option
  *     keeps the open-by-default semantics consistent with the
  *     pre-Slice-8 surface.
  ```
- **Lines 73–79**:
  ```ts
  if (!service.rules) {
    // Open-by-default: no rules configured, no evaluation happened.
    // Still emit `allow` for parity — an unrestricted op is legitimately
    // "allowed", just never evaluated.
    emitOperation(target, input, 'allow', undefined, 'user', false, boundProvenance);
    return;
  }
  ```
When `service.rules` is `null`, `enforceRules` immediately returns without throwing, allowing any upload, download, metadata modification, deletion, or listing to proceed unrestricted.

#### D. Exact Remediation Logic for Storage
1. **Target File**: `packages/pyric/src/storage/enforce.ts`
   - **Lines 73–79**:
     ```ts
     // BEFORE:
     if (!service.rules) {
       // Open-by-default: no rules configured, no evaluation happened.
       emitOperation(target, input, 'allow', undefined, 'user', false, boundProvenance);
       return;
     }

     // AFTER:
     if (!service.rules) {
       const reasons = ['No Storage rules configured; default deny.'];
       emitOperation(target, input, 'deny', reasons, 'user', false, boundProvenance);
       throw unauthorized(input.request.method, input.request.path, ' — No Storage rules configured; default deny.');
     }
     ```
   - **Lines 7–10**: Update docstring comments to document the fail-closed deny behavior when rules are missing or unconfigured.
2. **Target File**: `packages/pyric/src/storage/list.ts`
   - **Line 55**: Update comment acknowledging fail-closed enforcement on `listAll`.
3. **Special Cases Preserved**:
   - **Admin Handle Bypass**: Lines 69–72 in `packages/pyric/src/storage/enforce.ts`:
     ```ts
     if (target?.kind === 'sandbox' && target.admin === true) {
       emitOperation(target, input, 'not-applicable', undefined, 'admin', false, boundProvenance);
       return;
     }
     ```
     `getAdminStorageSandbox(sandbox)` sets `target.admin = true`, which returns before line 73 and bypasses rule evaluation as intended.
   - **Error Code Contract**: `unauthorized()` constructs a `StorageError` with code `storage/unauthorized`, which matches production Firebase Storage SDK behavior for permission denied.

---

## Part 2: Monorepo Build and Test Infrastructure

### 2.1 Workspace Map & Monorepo Structure
Pyric is a Bun workspace monorepo configured in the root `package.json`:

```
pyric/
├── package.json               # Root workspace manifest & scripts
├── bun.lock                   # Bun lockfile (v1.3.14)
├── scripts/                   # Root build, packaging, linting, and CI scripts
│   ├── build.sh               # Monorepo build orchestrator
│   └── ci/                    # CI planning, cache, and gate scripts
├── packages/
│   ├── pyric/                 # Core client SDK mirrors (Firestore, Database, Storage, Auth, Rules)
│   ├── pyric-admin/           # Firebase Admin SDK mirrors
│   ├── cli/                   # @pyric/cli binary, bridge, server, verify, assurance
│   ├── create-pyric/          # npm create pyric project generator
│   ├── ui/                    # Headless React components & hooks for sandbox/studio
│   ├── studio/                # Studio console UI application
│   ├── site-docs/             # Documentation & Studio host (Astro site)
│   ├── conformance/           # Private conformance evidence graph & verification gates
│   └── playground/            # Browser agent playground
└── examples/                  # Workspace example applications
```

### 2.2 Build Tools & Scripts
- **Package Manager / Runner**: Bun 1.3.14.
- **Build Pipeline**:
  - `bun run build`: Executes `bash scripts/build.sh`. Cleans `dist/` dirs, emits TypeScript declaration stubs, performs strict builds in dependency order, and builds the embedded Astro site.
  - `bun run pretest`: Executes `bash scripts/build.sh --packages-only` (builds workspace packages while skipping the heavy Astro site).
  - `bun run typecheck`: Runs `tsc --noEmit` across packages.

### 2.3 Test Suite Execution (`bun test`)
Root `package.json` defines the canonical test script:
```bash
bun test --cwd packages/pyric \
  && bun test --cwd packages/pyric-admin \
  && bun test --cwd packages/create-pyric \
  && bun test --cwd packages/cli \
  && bun run test:chat-template \
  && bun run --cwd packages/ui test \
  && bun run --cwd packages/studio test \
  && bun test --cwd packages/conformance \
  && bun test scripts/...
```

Targeted execution options:
- `bun test --cwd packages/pyric`: Runs 5,972 unit/integration tests across 436 files in ~15s.
- `bun test --cwd packages/pyric-admin`: Runs 663 tests across 50 files in ~5.6s.
- `bun test --cwd packages/cli`: Runs CLI, server, and worker tests.
- Single file: `bun test path/to/file.test.ts`.

---

## Part 3: Detailed Regression Test Plan for R1–R5

### Requirement R1: Strict Rules Unary Type Enforcement
- **Vulnerability**: Unary NOT (`!`) in Firestore and Storage expression evaluators previously used JavaScript truthiness coercion (`!val` or `!truthy(val)`). Negating missing fields, undefined, or non-boolean primitives (e.g. `!request.auth.token.admin`) evaluated to `true` instead of throwing an evaluation error.
- **Implementation Targets**:
  - `packages/pyric/src/rules/simulator/evaluator.ts:74`: Replace `return !evaluate(expr.operand, ctx, scope);` with a strict boolean requirement using `requireBoolean` or throwing `RuleEvalError`.
  - `packages/pyric/src/storage/sandbox/rules-evaluator.ts:251`: Replace `return !truthy(a);` with type check throwing `RuleEvalError` on non-boolean operands.
- **Dedicated Regression Test Placement**:
  - Firestore: `packages/pyric/test/rules/simulator/unary-strict-boolean.test.ts`
    - Verify `!true === false` and `!false === true`.
    - Verify `!request.auth.token.missing` throws `RuleEvalError` and denies access.
    - Verify `!null`, `!0`, `!""`, `![]`, `!{}` throw `RuleEvalError` and fail closed.
  - Storage: `packages/pyric/test/storage/sandbox/rules-unary-strictness.test.ts`
    - Verify `allow read: if !request.auth.token.admin;` denies access when `admin` claim is missing or non-boolean.

### Requirement R2: Non-Truncating DataSnapshot Path Resolution
- **Vulnerability**: In `packages/pyric/src/rules/rtdb/grammar/simulator.ts:122–126`, `child(path)` broke out of its path iteration loop on the first missing/non-object segment. This truncated `currentPath` (e.g., `child('a/b/c')` when `a` is missing truncated to `/a` rather than `/a/b/c`). Subsequent `.parent()` calls prematurely returned the root snapshot `/`, which exists and caused `exists()` to return `true`.
- **Implementation Target**:
  - `packages/pyric/src/rules/rtdb/grammar/simulator.ts:116–136`: Continue iterating all path segments when traversing through null/missing nodes to maintain the virtual path depth.
- **Dedicated Regression Test Placement**:
  - `packages/pyric/test/rules/rtdb/grammar/datasnapshot-virtual-path.test.ts`
    - Assert `data.child('a/b/c').parent().exists() === false` when `a` does not exist.
    - Verify multi-level `.parent()` chaining:
      - `data.child('a/b/c').parent().path === '/a/b'`
      - `data.child('a/b/c').parent().parent().path === '/a'`
      - `data.child('a/b/c').parent().parent().parent().path === '/'`

### Requirement R3: Exhaustive Multi-Path RTDB Validation on Deletions
- **Vulnerability**: In `packages/pyric/src/rules/rtdb/simulation/handler.ts:78`, a null value is treated as a deletion, and `.validate` rules are bypassed for deletions. In multi-location updates where one path is deleted while siblings are updated, sibling `.validate` rules enforcing cross-field invariants were bypassed.
- **Implementation Target**:
  - `packages/pyric/src/rules/rtdb/simulation/handler.ts`: In multi-path updates, evaluate `.validate` rules across the union of affected pre-write and post-write paths.
  - `packages/pyric/src/database/sandbox/write-plane.ts:226–255`: Ensure multi-path updates evaluate `.validate` rules across all affected parent and sibling invariants.
- **Dedicated Regression Test Placement**:
  - `packages/pyric/test/rules/rtdb/simulation/multipath-deletion-validation.test.ts`
    - Multi-path update deleting a required subtree while updating siblings triggers `.validate` failure.
    - Schema rules like `newData.hasChildren(['req1', 'req2'])` fail closed when a multi-path write removes `req1`.

### Requirement R4: Document Path Canonicalization & Root Clamping
- **Vulnerability**: In `packages/pyric/src/rules/simulator/document-lookups.ts:5–20`, `normalizeDocumentPath` strips standard prefixes but fails to resolve `..` relative segments or prevent navigating outside the document collection root (`/databases/$(database)/documents`).
- **Implementation Target**:
  - `packages/pyric/src/rules/simulator/document-lookups.ts`: Resolve `.` and `..` segments and clamp or reject path traversal escaping the document root.
- **Dedicated Regression Test Placement**:
  - `packages/pyric/test/rules/simulator/document-path-canonicalization.test.ts`
    - Test `get(/databases/$(database)/documents/users/../secrets/123)` cannot escape collection boundaries.
    - Verify lookups attempting root escape throw or evaluate to non-existent resource.

### Requirement R5: Closed-by-Default Unconfigured Sandboxes
- **Vulnerability**: Unconfigured RTDB sandboxes defaulted to `'allow'` policy in `RulesEvaluator`. Unconfigured Storage sandboxes returned `allow` in `enforceRules` when `service.rules` was null.
- **Implementation Targets**:
  - `packages/pyric/src/database/sandbox/rules-eval.ts:102`: Default `defaultPolicy` to `'deny'`.
  - `packages/pyric/src/database/sandbox-controls.ts`: Export `setDefaultPolicy`.
  - `packages/pyric/src/storage/enforce.ts:73–79`: Fail closed with `throw unauthorized(...)` when `!service.rules`.
- **Existing Test Updates Needed**:
  - `packages/pyric/test/storage/enforce.test.ts:300–310`: Update `no-rules mode is open` to assert fail-closed rejection.
  - `packages/pyric/test/storage/list-rules.test.ts:74–80`: Update to assert `listAll` throws `storage/unauthorized`.
  - `packages/cli/test/serve/worker/serve-init.test.ts:187–203`: Update to assert worker rejects storage operations when rules are unconfigured.
  - Test helper adjustment: In `packages/pyric/test/database/cdd/support.ts:55–60`, explicitly call `databaseSandbox.setDefaultPolicy(db, 'allow')` in `setup()` so unit tests of pure data-plane logic remain permissive without depending on an open default.
- **Dedicated Regression Test Placement**:
  - RTDB: `packages/pyric/test/database/unconfigured-sandbox-fail-closed.test.ts`
    - Tests `get`, `set`, `update`, `remove`, and listeners on an unconfigured database sandbox reject with `PERMISSION_DENIED`.
    - Tests `/.info/` system metadata remains readable.
    - Tests `getAdminDatabase(sandbox)` can read and write without rules.
  - Storage: `packages/pyric/test/storage/unconfigured-sandbox-fail-closed.test.ts`
    - Tests `uploadBytes`, `getBytes`, `getMetadata`, `deleteObject`, and `listAll` on an unconfigured storage sandbox reject with `storage/unauthorized`.
    - Tests `getAdminStorageSandbox(sandbox)` continues to allow admin operations.

---

## Conclusion

The root causes of open-by-default behavior are localized to explicit early-return allow logic in `storage/enforce.ts` and an `'allow'` default policy in `database/sandbox/rules-eval.ts`. The codebase is well-factored, and targeted changes at these seams will cleanly establish fail-closed security invariants across both runtimes.
