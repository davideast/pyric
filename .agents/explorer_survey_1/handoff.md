# Handoff Report: R1 & R4 Soundness Investigation

## 1. Observation

### R1: Strict Rules Unary Type Enforcement
1. **Firestore Unary NOT Evaluation Site**:
   - File: `packages/pyric/src/rules/simulator/evaluator.ts`, line 74:
     ```typescript
     case 'unaryOp': {
       if (expr.op === '!') return !evaluate(expr.operand, ctx, scope);
     ```
   - Observed behavior: Native JavaScript `!` negation is applied directly to the result of `evaluate(expr.operand, ctx, scope)`. Evaluating `!null` or `!undefined` returns boolean `true`. Non-boolean types (e.g. `0`, `""`, strings, objects) are loosely coerced.
2. **Firestore Boolean Helper Disparity**:
   - In `packages/pyric/src/rules/simulator/evaluator.ts:514–520`, `requireBoolean` is defined:
     ```typescript
     function requireBoolean(value: unknown, expr: Expression): boolean {
       if (typeof value === 'boolean') return value;
       throw new EvalError(
         `Expected a boolean control-flow operand, got ${value === null ? 'null' : typeof value}`,
         expr,
       );
     }
     ```
   - `requireBoolean` is invoked for binary `&&` (lines 365, 374), binary `||` (lines 382, 389), and ternary `? :` (line 86), but is omitted from unary `!` (line 74).
3. **Firestore Error Class**:
   - Defined in `packages/pyric/src/rules/simulator/eval-error.ts`, line 3:
     ```typescript
     export class EvalError extends Error {
       constructor(message: string, public expr?: Expression) {
         super(message);
         this.name = 'EvalError';
       }
     }
     ```
   - In `packages/pyric/src/rules/simulator/handler.ts:141–156`, any non-`UnsupportedError` caught during rule condition evaluation is marked as `entry.verdict = 'ERROR'`, failing closed with `{ decision: 'DENY' }`.
4. **Storage Unary NOT Evaluation Site**:
   - File: `packages/pyric/src/storage/sandbox/rules-evaluator.ts`, lines 241–252:
     ```typescript
     case 'unary': {
       const a = evalExpr(expr.arg, ctx);
       if (isErr(a)) return a;
       if (expr.op === '-') {
         if (a instanceof RulesFloat) return new RulesFloat(-a.value);
         if (typeof a !== 'number') return new RuleError(`Unary '-' applied to ${describeType(a)}.`);
         return -a;
       }
       return !truthy(a);
     }
     ```
   - Lines 143–148 define `truthy(v)`:
     ```typescript
     function truthy(v: unknown): boolean {
       if (isErr(v)) return false;
       return v !== false && v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v));
     }
     ```
   - Evaluating `!null` or `!undefined` yields `!false === true`. Non-boolean types like strings and numbers evaluate to `!true === false` without throwing.
5. **Storage Error Class**:
   - Defined in `packages/pyric/src/storage/sandbox/rules-evaluation-error.ts`, line 2:
     ```typescript
     export class RuleEvalError extends Error {}
     ```
   - Caught in `packages/pyric/src/storage/sandbox/rules-evaluator.ts:96–107`:
     ```typescript
     if (err instanceof RuleEvalError) {
       reasons.push(`match ${formatPath(block.segments)} ${input.request.method}: ${err.message}`);
       continue;
     }
     ```
     Bypasses allow and fails closed.

### R4: Document Path Canonicalization & Root Clamping
1. **Firestore `normalizeDocumentPath` Location & Implementation**:
   - File: `packages/pyric/src/rules/simulator/document-lookups.ts`, lines 5–9:
     ```typescript
     export function normalizeDocumentPath(rawPath: string): string {
       return rawPath
         .replace(/\$\(database\)/g, '(default)')
         .replace(/^\/databases\/\(default\)\/documents\//, '');
     }
     ```
2. **Current Processing of `..`**:
   - `normalizeDocumentPath` performs no segment parsing or relative traversal resolution.
   - `normalizeDocumentPath('/databases/$(database)/documents/users/../secrets/123')` returns `"users/../secrets/123"`.
3. **Lookup Handling Sites**:
   - `packages/pyric/src/rules/simulator/evaluation-builtins.ts`:
     - Line 55 in `get`: `resolveGet(String(evaluate(args[0], ctx, scope)), ctx)`
     - Line 59 in `exists`: `resolveExists(String(evaluate(args[0], ctx, scope)), ctx)`
     - Line 80 & 82 in `getAfter`: `makeGetResource(normalizeDocumentPath(pathStr), ctx.afterState)`
     - Line 102 in `existsAfter`: `normalizeDocumentPath(pathStr)`
   - `packages/pyric/src/rules/simulator/document-lookups.ts`:
     - Lines 21–37 (`resolveGet`) and lines 39–50 (`resolveExists`).
     - Lookups query `context.mockDocuments` and `context.getDoc(path)`.
     - Neither `resolveGet` nor `resolveExists` checks segment count parity or collection containment.
4. **Contrast with Storage Rules Firestore Path Validation**:
   - In `packages/pyric/src/storage/sandbox/rules-methods.ts:181–185`:
     ```typescript
     const docSegments = parts.slice(3);
     if (docSegments.length === 0 || docSegments.length % 2 !== 0) {
       throw new RuleEvalError(
         `Firestore path does not point at a document (needs an even segment count): ${docSegments.join('/')}`,
       );
     }
     ```
     Firestore's rules simulator lacks this check.

---

## 2. Logic Chain

1. **R1 Soundness Gap**:
   - Observation: When `expr.op === '!'`, Firestore calls `!evaluate(expr.operand)` and Storage calls `!truthy(a)`.
   - Inference: In JavaScript, `!null` and `!undefined` evaluate to `true`.
   - Consequence: A rule like `allow read: if !request.auth;` or `allow read: if !request.auth.token.get('admin', null);` evaluates to `true` on unauthenticated or missing-claim requests. In production Firebase, negation on non-boolean values triggers an evaluation error that fails closed. This creates a critical false allow in Pyric.
   - Deduction: Both evaluators must enforce that the operand is strictly of type `boolean`. If not, Firestore must throw `EvalError` (via `requireBoolean`) and Storage must throw `RuleEvalError`.

2. **R4 Soundness Gap**:
   - Observation: `normalizeDocumentPath` strips only `/databases/(default)/documents/` and leaves relative segments (`..`, `.`) intact.
   - Inference:
     - If path canonicalization is performed naively (e.g. POSIX `path.normalize`), `users/../secrets/123` resolves to `secrets/123`.
     - An untrusted wildcard or input (e.g. `request.auth.uid = '../secrets/123'` evaluated in `/databases/$(database)/documents/users/$(userId)`) could escape the `users` collection boundary into `secrets/123`.
   - Deduction: Path canonicalization in `normalizeDocumentPath` must enforce:
     1. Document root containment: `..` cannot traverse above `/databases/(default)/documents`.
     2. Collection root clamping: when a collection segment is present (e.g. `users`), `..` is clamped to that collection root so it cannot escape into sibling collections.
     3. Document path parity: document lookups must strictly require an even segment count (`collection/doc[/sub/doc]*`).

---

## 3. Caveats

1. **Other Requirements (R2, R3, R5)**:
   - This investigation focused exclusively on R1 and R4 per the task prompt. Requirements R2 (RTDB DataSnapshot path resolution), R3 (RTDB multi-path deletion validation), and R5 (closed-by-default unconfigured sandboxes) are investigated separately.
2. **Path Literal Interpolation**:
   - In `packages/pyric/src/rules/simulator/evaluator.ts:287–302`, `pathLiteral` stringifies interpolated expressions and joins them with `/`. Clamping in `normalizeDocumentPath` cleanly mitigates any traversal introduced via interpolation when passed to `get()` / `exists()`.
3. **Naming Parity**:
   - In Firestore, the class is named `EvalError`, while in Storage it is `RuleEvalError`. Aliasing `export { EvalError as RuleEvalError }` in `eval-error.ts` provides uniform naming.

---

## 4. Conclusion

- **R1 is fully mapped**: Unary `!` is evaluated at `packages/pyric/src/rules/simulator/evaluator.ts:74` (Firestore) and `packages/pyric/src/storage/sandbox/rules-evaluator.ts:251` (Storage). Both fail to enforce boolean operands, causing critical false allows for `null` and `undefined`. Remediating requires calling `requireBoolean` in Firestore and checking `typeof a === 'boolean'` / throwing `RuleEvalError` in Storage.
- **R4 is fully mapped**: `normalizeDocumentPath` in `packages/pyric/src/rules/simulator/document-lookups.ts:5–9` does not canonicalize relative segments or clamp to root/collection boundaries. Remediating requires implementing segment-based canonicalization with collection root clamping and document root containment, plus even-segment validation in `resolveGet` / `resolveExists`.

---

## 5. Verification Method

### Independent Verification Commands
1. Run existing test suites:
   ```bash
   bun test packages/pyric/test/rules/simulator/evaluator.test.ts
   bun test packages/pyric/test/storage/sandbox/rules-evaluator.test.ts
   bun test packages/pyric/test/rules/simulator/document-lookups.test.ts
   ```
2. Verify R1 reproduction (demonstrating current false-allow):
   In `evaluator.test.ts`, evaluate:
   ```typescript
   evaluate(unaryOp('!', lit(null)), baseCtx())
   ```
   Currently returns `true`. After fix, must throw `EvalError` with `/boolean/`.
3. Verify R4 reproduction:
   ```typescript
   normalizeDocumentPath('/databases/$(database)/documents/users/../secrets/123')
   ```
   Currently returns `'users/../secrets/123'`. After fix with collection root clamping, must return `'users/secrets/123'`, preventing escape into `'secrets/123'`.
4. Invalidation Condition:
   If any existing tests in `bun test` fail or if valid rules expressions (e.g. `!true`, `!false`, `users/alice/../bob`) fail to evaluate, the implementation proposal must be adjusted.
