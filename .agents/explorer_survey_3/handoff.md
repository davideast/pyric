# Handoff Report: Explorer 3 (Sandboxes & Test Infrastructure)

## 1. Observation

### 1.1 RTDB Sandbox Runtime & Rules Loading
- `packages/pyric/src/database/instances.ts`: Lines 29–92 define `getDatabase(...)` and `getAdminDatabase(...)`, delegating to `getOrCreateBackend(sandbox)` (`packages/pyric/src/database/sandbox/backend-for.ts:14`).
- `packages/pyric/src/database/sandbox/backend.ts`: Line 44 defines `setRules(rules: { rules: Record<string, unknown> } | null): void` and line 45 defines `setDefaultPolicy(policy: 'allow' | 'deny'): void`.
- `packages/pyric/src/database/sandbox/rules-eval.ts`:
  - Line 102: `private defaultPolicy: RtdbDefaultPolicy = 'allow';`
  - Lines 171–184:
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
  - Lines 40–44:
    ```ts
    export function permissionDenied(): Error {
      const err = new Error('PERMISSION_DENIED: Permission denied') as Error & { code: string };
      err.code = 'PERMISSION_DENIED';
      return err;
    }
    ```
- `packages/pyric/src/database/sandbox-namespace.ts`: Lines 24–36 define `sandbox.setDefaultPolicy(db, policy)` and `sandbox.setRules(db, rulesJson)`.
- `packages/pyric/src/database/sandbox-controls.ts`: Public `pyric/sandbox/database` exports `setRules`, `getActiveRules`, `setData`, `snapshotState`, but currently lacks an exported `setDefaultPolicy`.

### 1.2 Storage Sandbox Runtime & Rules Loading
- `packages/pyric/src/storage/service.ts`: Lines 175–247 define `ensureService(sandbox, options, caller)`. If `options.rules` is omitted, `service.rules` is set to `null`.
- `packages/pyric/src/storage/enforce.ts`:
  - Lines 73–79:
    ```ts
    if (!service.rules) {
      // Open-by-default: no rules configured, no evaluation happened.
      // Still emit `allow` for parity — an unrestricted op is legitimately
      // "allowed", just never evaluated.
      emitOperation(target, input, 'allow', undefined, 'user', false, boundProvenance);
      return;
    }
    ```
  - Lines 87–91:
    ```ts
    if (!result.allowed) {
      emitOperation(target, input, 'deny', result.reasons, 'user', true, boundProvenance);
      const detail = result.reasons.length > 0 ? ` — ${result.reasons.join('; ')}` : '';
      throw unauthorized(input.request.method, input.request.path, detail);
    }
    ```
  - Lines 69–72: Admin handle bypasses rules evaluation:
    ```ts
    if (target?.kind === 'sandbox' && target.admin === true) {
      emitOperation(target, input, 'not-applicable', undefined, 'admin', false, boundProvenance);
      return;
    }
    ```
- `packages/pyric/src/storage/errors.ts`: Lines 71–76 define `unauthorized()` returning a `StorageError` with `.code === 'storage/unauthorized'`.
- `packages/pyric/test/storage/enforce.test.ts`: Lines 300–310 explicitly assert that `no-rules mode is open` and uploads/reads succeed.
- `packages/pyric/test/storage/list-rules.test.ts`: Lines 74–80 explicitly assert that `listAll` is a no-op when no rules are configured.

### 1.3 Monorepo & Build Tool Observations
- Monorepo package manager and test runner: Bun 1.3.14 (`package.json`).
- Root test script: `"test": "bun test --cwd packages/pyric && bun test --cwd packages/pyric-admin && bun test --cwd packages/create-pyric && bun test --cwd packages/cli && bun run test:chat-template && bun run --cwd packages/ui test && bun run --cwd packages/studio test && bun test --cwd packages/conformance && bun test scripts/..."`.
- Pretest script: `"pretest": "bash scripts/build.sh --packages-only"`.
- `bun test --cwd packages/pyric` executes 5,972 tests across 436 files in ~15s.
- `bun test --cwd packages/pyric-admin` executes 663 tests across 50 files in ~5.6s.

---

## 2. Logic Chain

1. **R5 RTDB Analysis**:
   - In `database/sandbox/rules-eval.ts`, line 102 initializes `private defaultPolicy: RtdbDefaultPolicy = 'allow';`.
   - When a sandbox is created via `initializeSandbox()` and accessed via `getDatabase(sandbox)` with no rules installed, `this.compiled` is `null`.
   - Lines 171–184 check `if (this.compiled === null)`: since `this.defaultPolicy` is `'allow'`, it returns `{ check: 'allow' }`.
   - Therefore, unconfigured RTDB sandboxes allow all reads and writes.
   - Setting `private defaultPolicy: RtdbDefaultPolicy = 'deny';` at line 102 causes `if (this.compiled === null)` to enter the `if (this.defaultPolicy === 'deny')` branch, returning `{ check: 'no-rule', reasons: ['No RTDB rules loaded; default deny.'] }`.
   - In `write-plane.ts`, `get`, `set`, `update`, `remove` check `evaluation.check !== 'allow'` and throw `permissionDenied()`, producing `Error: PERMISSION_DENIED: Permission denied` with `.code === 'PERMISSION_DENIED'`.
   - System metadata paths (`/.info` and `/.info/*`) are guarded on lines 147–170 before the `compiled === null` check and will remain accessible.

2. **R5 Storage Analysis**:
   - In `storage/service.ts`, if `options.rules` is omitted in `getStorageSandbox`, `service.rules` is set to `null`.
   - In `storage/enforce.ts`, lines 73–79 explicitly check `if (!service.rules)` and return without evaluating or throwing, allowing all client uploads, downloads, and listings.
   - Replacing this early return with:
     ```ts
     if (!service.rules) {
       const reasons = ['No Storage rules configured; default deny.'];
       emitOperation(target, input, 'deny', reasons, 'user', false, boundProvenance);
       throw unauthorized(input.request.method, input.request.path, ' — No Storage rules configured; default deny.');
     }
     ```
     ensures all operations against unconfigured Storage sandboxes throw `StorageError` with `code === 'storage/unauthorized'`, which is the canonical Firebase Storage permission denied error.
   - Admin handles (`getAdminStorageSandbox`) are guarded at lines 69–72 before line 73, preserving admin bypass.

3. **Monorepo Test Isolation & Regression Requirements**:
   - Because RTDB previously defaulted to `'allow'`, data-plane unit tests in `packages/pyric/test/database/cdd/support.ts` initialized bare sandboxes without configuring rules.
   - Changing the default to fail-closed deny will cause unconfigured data-plane tests to fail unless `databaseSandbox.setDefaultPolicy(db, 'allow')` or open rules are applied in their test fixture setup.
   - Existing open-by-default assertion tests (`packages/pyric/test/storage/enforce.test.ts:300–310`, `packages/pyric/test/storage/list-rules.test.ts:74–80`, and `packages/cli/test/serve/worker/serve-init.test.ts:187–203`) must be updated to assert fail-closed rejection.

---

## 3. Caveats

1. **Firestore Default State**: Firestore local sandbox (`packages/pyric/src/firestore/sandbox/local-environment.ts`) uses `DEFAULT_OPEN_RULES` for its in-page local environment, but requirement R5 in `ORIGINAL_REQUEST.md` is strictly scoped to RTDB and Storage.
2. **CDD Test Setup Refactoring**: Setting RTDB `defaultPolicy` to `'deny'` will require adding `databaseSandbox.setDefaultPolicy(db, 'allow')` into `packages/pyric/test/database/cdd/support.ts` setup helper so unit tests focusing exclusively on query/snapshot logic remain unblocked.

---

## 4. Conclusion

1. **R5 RTDB Fix**: Change line 102 of `packages/pyric/src/database/sandbox/rules-eval.ts` from `'allow'` to `'deny'`. Export `setDefaultPolicy` from `packages/pyric/src/database/sandbox-controls.ts`.
2. **R5 Storage Fix**: Replace lines 73–79 in `packages/pyric/src/storage/enforce.ts` with fail-closed deny throwing `unauthorized(...)`.
3. **Regression Tests**:
   - Add `packages/pyric/test/database/unconfigured-sandbox-fail-closed.test.ts` for RTDB.
   - Add `packages/pyric/test/storage/unconfigured-sandbox-fail-closed.test.ts` for Storage.
   - Add regression tests for R1 (`rules/simulator/unary-strict-boolean.test.ts` and `storage/sandbox/rules-unary-strictness.test.ts`), R2 (`rules/rtdb/grammar/datasnapshot-virtual-path.test.ts`), R3 (`rules/rtdb/simulation/multipath-deletion-validation.test.ts`), and R4 (`rules/simulator/document-path-canonicalization.test.ts`).

---

## 5. Verification Method

1. **Run RTDB policy and Storage enforcement suites**:
   ```bash
   bun test packages/pyric/test/database/default-policy.test.ts packages/pyric/test/storage/enforce.test.ts packages/pyric/test/storage/list-rules.test.ts
   ```
2. **Run newly added dedicated regression test suites**:
   ```bash
   bun test packages/pyric/test/database/unconfigured-sandbox-fail-closed.test.ts packages/pyric/test/storage/unconfigured-sandbox-fail-closed.test.ts
   ```
3. **Run monorepo test suites**:
   ```bash
   bun test --cwd packages/pyric
   bun test --cwd packages/pyric-admin
   bun test --cwd packages/cli
   ```
4. **Invalidation Conditions**:
   - If an unconfigured RTDB sandbox allows `set()` or `get()` without an explicit rule or policy change.
   - If an unconfigured Storage sandbox allows `uploadBytes()` or `getBlob()` without explicit rules.
   - If `/.info/` system metadata in RTDB is blocked when unconfigured.
   - If `getAdminDatabase()` or `getAdminStorageSandbox()` fails on unconfigured sandboxes.
