# Comprehensive Technical Report: R1 & R4 Soundness Investigation
**Explorer**: Explorer 1 (`explorer_survey_1`)  
**Date**: 2026-08-31  
**Scope**: 
- **R1: Strict Rules Unary Type Enforcement** (Firestore & Storage rules expression evaluators)
- **R4: Document Path Canonicalization & Root Clamping** (Firestore document lookups & path normalization)

---

## Executive Summary

Pyric aims to mirror production Firebase Security Rules with fail-closed security invariants. In production Firebase, any rule evaluation that encounters a type violation or undefined behavior immediately fails closed (denying the operation). 

Our investigation revealed two critical soundness vulnerabilities in Pyric:
1. **R1 (False Allow via Unary NOT Coercion)**:
   In both Firestore and Storage rules expression evaluators, unary NOT (`!`) uses JavaScript truthiness or loose boolean coercion (`!evaluate(...)` and `!truthy(a)`). Consequently, evaluating `!` on `null`, `undefined`, or non-boolean values (e.g. `!request.auth`, `!request.auth.token.get('admin', null)`, `!resource.data.optionalFlag`) evaluates to `true` instead of throwing a runtime evaluation error. This results in **false allows**, granting unauthorized access where production Firebase denies.
2. **R4 (Path Traversal & Unclamped Document Lookups)**:
   `normalizeDocumentPath` in `packages/pyric/src/rules/simulator/document-lookups.ts` performs only naive string regex replacements, completely ignoring relative path segments (`..` and `.`) and collection boundaries. Document lookups via `get()`, `exists()`, `getAfter()`, and `existsAfter()` neither canonicalize paths nor clamp traversal to the collection root or document root. Unclamped traversal allows paths like `users/../secrets/123` to attempt collection boundary escapes, and missing segment parity checks allow lookups against invalid non-document paths.

---

## 1. Requirement R1: Strict Rules Unary Type Enforcement

### 1.1 Architecture & Evaluation Sites

Pyric evaluates Security Rules across two distinct engine implementations for Firestore and Storage:
1. **Firestore Rules Simulator**:
   - Primary AST evaluator: `packages/pyric/src/rules/simulator/evaluator.ts`
   - Evaluation entry point: `evaluateExpr(expr: Expression, ctx: SimulationContext, scope: Record<string, unknown>)`
   - Unary NOT evaluation site: **Lines 73–83** of `evaluator.ts`:
     ```typescript
     case 'unaryOp': {
       if (expr.op === '!') return !evaluate(expr.operand, ctx, scope);
       if (expr.op === '-') {
         const v = evaluate(expr.operand, ctx, scope);
         if (v instanceof RulesFloat) return new RulesFloat(-v.value);
         return -(v as number);
       }
       throw new EvalError(`Unknown unary op: ${expr.op}`, expr);
     }
     ```
2. **Cloud Storage Rules Simulator**:
   - Primary AST evaluator: `packages/pyric/src/storage/sandbox/rules-evaluator.ts`
   - Evaluation entry point: `evalExpr(expr: Expr, ctx: EvalCtx): unknown`
   - Unary NOT evaluation site: **Lines 241–252** of `rules-evaluator.ts`:
     ```typescript
     case 'unary': {
       // An error survives negation (production: `!(resource.name == 'x')` with
       // `name` absent DENIES). Propagate rather than flipping it to `true`.
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

---

### 1.2 Error Class Hierarchy & Throw/Catch Mechanics

#### Cloud Storage: `RuleEvalError`
- **Definition**: `packages/pyric/src/storage/sandbox/rules-evaluation-error.ts`:
  ```typescript
  export class RuleEvalError extends Error {}
  ```
- **Companion**: `RuleError` in `packages/pyric/src/storage/sandbox/rules-values.ts:4` (used as an in-band error value that propagates through expressions).
- **Throw Sites**:
  - `rules-evaluator.ts:240`: Path literal used outside `firestore.get()/exists()`
  - `rules-evaluator.ts:386`: Undefined user function
  - `rules-evaluator.ts:394`: Function argument count mismatch
  - `rules-evaluator.ts:400`: Maximum recursion/call depth exceeded
  - `rules-methods.ts:89, 114, 124, 128, 133, 165, 219, 273, 280, etc.`: Method type mismatch, unsupported methods, invalid regex.
- **Allow Boundary Handler**:
  In `packages/pyric/src/storage/sandbox/rules-evaluator.ts:96–107`:
  ```typescript
  } catch (err) {
    if (err instanceof RuleEvalError) {
      reasons.push(
        `match ${formatPath(block.segments)} ${input.request.method}: ${err.message}`,
      );
      continue;
    }
    throw err;
  }
  ```
  Throwing `RuleEvalError` bypasses the `allowed = true` branch and records the failure in `reasons`, resulting in a **fail-closed deny (`allowed: false`)**.

#### Firestore: `EvalError`
- **Definition**: `packages/pyric/src/rules/simulator/eval-error.ts`:
  ```typescript
  import type { Expression } from '../grammar/FirestoreAST.js';

  export class EvalError extends Error {
    constructor(message: string, public expr?: Expression) {
      super(message);
      this.name = 'EvalError';
    }
  }
  ```
- **Throw Sites**:
  - `evaluator.ts:82`: Unknown unary operator
  - `evaluator.ts:101`: Dotted field access on `null` or `undefined`
  - `evaluator.ts:137`: Absent map field accessed via dot notation
  - `evaluator.ts:149`: Bracket index on `null` or `undefined`
  - `evaluator.ts:333`: Undefined variable identifier
  - `evaluator.ts:507`: Modulo by zero
  - `evaluator.ts:514–520`: `requireBoolean` helper:
    ```typescript
    function requireBoolean(value: unknown, expr: Expression): boolean {
      if (typeof value === 'boolean') return value;
      throw new EvalError(
        `Expected a boolean control-flow operand, got ${value === null ? 'null' : typeof value}`,
        expr,
      );
    }
    ```
- **Allow Boundary Handler**:
  In `packages/pyric/src/rules/simulator/handler.ts:141–158`:
  ```typescript
  } catch (e) {
    entry.expressionTrace = recorder.entries;
    const isUnsupported = e instanceof UnsupportedError;
    if (isUnsupported) {
      sawUnsupported = true;
      entry.verdict = 'UNSUPPORTED';
      entry.message = (e as UnsupportedError).message;
    } else {
      entry.verdict = 'ERROR';
      entry.message = e instanceof Error ? e.message : String(e);
    }
    trace.push(entry);
  }
  ```
  Throwing `EvalError` sets `entry.verdict = 'ERROR'`, and `evaluateRules` returns `{ decision: 'DENY' }` (fail closed).

---

### 1.3 Root Cause of Soundness Vulnerabilities (False Allows)

#### Firestore Root Cause
In `packages/pyric/src/rules/simulator/evaluator.ts:74`:
```typescript
if (expr.op === '!') return !evaluate(expr.operand, ctx, scope);
```
JavaScript's `!` converts any value to boolean using JavaScript truthiness:
1. `!null` → `true`
2. `!undefined` → `true`
3. `!0` → `true`
4. `!""` → `true`
5. `!"admin"` → `false`
6. `!{}` → `false`

**Historical Context**:
In commit history (`firestore#138a`), boolean operand enforcement was added to binary `&&`, binary `||`, and ternary `condition ? consequent : alternate` via `requireBoolean(...)` (lines 86, 365, 374, 382, 389 of `evaluator.ts`). However, **unary `!` was omitted** from that change!

**False-Allow Attack Scenarios**:
1. **Unauthenticated Access**:
   Rule: `allow read: if !request.auth;`
   When unauthenticated, `request.auth` is `null`. In Pyric: `!null === true` → **ALLOW** (critical security bypass). In production Firebase rules: runtime evaluation error → **DENY**.
2. **Missing Token Claim / Flag**:
   Rule: `allow write: if !request.auth.token.get('banned', null);`
   The `.get()` method returns fallback `null`. In Pyric: `!null === true` → **ALLOW**. In production Firebase: runtime type error → **DENY**.
3. **Null Field Bypass**:
   Rule: `allow delete: if !resource.data.protected;`
   If `protected` is explicitly stored as `null`, Pyric evaluates `!null === true` → **ALLOW**. In production Firebase: runtime type error → **DENY**.

#### Storage Root Cause
In `packages/pyric/src/storage/sandbox/rules-evaluator.ts:251`:
```typescript
return !truthy(a);
```
Where `truthy(v)` (`rules-evaluator.ts:143–148`) is:
```typescript
function truthy(v: unknown): boolean {
  if (isErr(v)) return false;
  return v !== false && v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v));
}
```
1. If `a` is `null`, `truthy(null)` is `false`, so `!truthy(null)` returns `true`!
2. If `a` is `undefined` (e.g. from an unbound identifier at line 214: `return undefined;`), `!truthy(undefined)` returns `true`!
3. If `a` is a string (e.g. `"role"`), `truthy("role")` is `true`, so `!truthy("role")` returns `false` instead of throwing `RuleEvalError`.
4. If `a` is `0`, `truthy(0)` is `true`, so `!truthy(0)` returns `false` instead of throwing `RuleEvalError`.

---

### 1.4 Remediation Plan for R1

#### Firestore
1. In `packages/pyric/src/rules/simulator/evaluator.ts:74`, enforce `requireBoolean`:
   ```typescript
   // BEFORE:
   case 'unaryOp': {
     if (expr.op === '!') return !evaluate(expr.operand, ctx, scope);

   // AFTER:
   case 'unaryOp': {
     if (expr.op === '!') {
       return !requireBoolean(evaluate(expr.operand, ctx, scope), expr.operand);
     }
   ```
2. In `packages/pyric/src/rules/simulator/eval-error.ts`:
   Export alias for domain parity:
   ```typescript
   export { EvalError as RuleEvalError };
   ```
   And re-export in `packages/pyric/src/rules/simulator/evaluator.ts`.

#### Storage
1. In `packages/pyric/src/storage/sandbox/rules-evaluator.ts:241–252`, enforce strict boolean operand checking:
   ```typescript
   // BEFORE:
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

   // AFTER:
   case 'unary': {
     const a = evalExpr(expr.arg, ctx);
     if (isErr(a)) return a;
     if (expr.op === '-') {
       if (a instanceof RulesFloat) return new RulesFloat(-a.value);
       if (typeof a !== 'number') return new RuleError(`Unary '-' applied to ${describeType(a)}.`);
       return -a;
     }
     if (typeof a !== 'boolean') {
       throw new RuleEvalError(`Unary '!' expects a boolean, got ${describeType(a)}.`);
     }
     return !a;
   }
   ```
2. In `packages/pyric/src/storage/sandbox/rules-evaluator.ts:214` (`evalIdent`):
   Ensure unbound identifiers return a `RuleError` rather than raw `undefined`, or throw `RuleEvalError`:
   ```typescript
   return new RuleError(`Undefined variable '${expr.name}'.`);
   ```

---

## 2. Requirement R4: Document Path Canonicalization & Root Clamping

### 2.1 Architecture & Current Implementation

#### Definition of `normalizeDocumentPath`
File: `packages/pyric/src/rules/simulator/document-lookups.ts`, lines 5–9:
```typescript
export function normalizeDocumentPath(rawPath: string): string {
  return rawPath
    .replace(/\$\(database\)/g, '(default)')
    .replace(/^\/databases\/\(default\)\/documents\//, '');
}
```

#### Document Lookup Flow
1. **Rule Evaluation Dispatch**:
   In `packages/pyric/src/rules/simulator/evaluation-builtins.ts`:
   - `get()` (lines 54–57):
     ```typescript
     case 'get': {
       const path = String(evaluate(args[0], ctx, scope));
       return resolveGet(path, ctx);
     }
     ```
   - `exists()` (lines 58–61):
     ```typescript
     case 'exists': {
       const path = String(evaluate(args[0], ctx, scope));
       return resolveExists(path, ctx);
     }
     ```
   - `getAfter()` (lines 80–82):
     ```typescript
     return makeGetResource(normalizeDocumentPath(pathStr), ctx.afterState);
     const normalized = normalizeDocumentPath(pathStr);
     ```
   - `existsAfter()` (line 102):
     ```typescript
     const normalized = normalizeDocumentPath(pathStr);
     ```

2. **Lookup Resolution**:
   In `packages/pyric/src/rules/simulator/document-lookups.ts`:
   - `resolveGet(rawPath: string, context: SimulationContext): SimResource` (lines 21–37):
     ```typescript
     export function resolveGet(rawPath: string, context: SimulationContext): SimResource {
       const path = normalizeDocumentPath(rawPath);
       let document = context.mockDocuments.get(path);
       if (!document && context.getDoc) {
         const loaded = context.getDoc(path);
         if (loaded) {
           context.mockDocuments.set(path, loaded);
           document = loaded;
         }
       }
       if (document) {
         return context.identitylessFunctionMocks?.has(path)
           ? { data: document }
           : makeGetResource(path, document);
       }
       throw new EvalError(`get() of non-existent document '${path}' (guard with exists() first)`);
     }
     ```
   - `resolveExists(rawPath: string, context: SimulationContext): boolean` (lines 39–50):
     ```typescript
     export function resolveExists(rawPath: string, context: SimulationContext): boolean {
       const path = normalizeDocumentPath(rawPath);
       if (context.mockDocuments.has(path)) return true;
       if (context.getDoc) {
         const loaded = context.getDoc(path);
         if (loaded) {
           context.mockDocuments.set(path, loaded);
           return true;
         }
       }
       return false;
     }
     ```

---

### 2.2 Current Handling of Relative Path Segments (`..` and `.`)

`normalizeDocumentPath` performs **zero** segment-level processing:
1. It replaces `$(database)` with `(default)`.
2. It strips a leading `/databases/(default)/documents/` prefix if present.
3. If `rawPath` is `/databases/$(database)/documents/users/../secrets/123`, the output is `"users/../secrets/123"`.
4. If `rawPath` is `/databases/$(database)/documents/../../secrets/123`, the output is `"../../secrets/123"`.
5. Redundant slashes (e.g. `users//alice`) and current-directory dots (e.g. `users/./alice`) are preserved verbatim.

---

### 2.3 Root Cause of Path Traversal Soundness Risks

1. **Escaping Collection Boundaries**:
   In security rules, developers commonly write scoped document lookups, such as:
   ```rules
   match /users/{userId} {
     allow read: if get(/databases/$(database)/documents/users/$(userId)).data.public == true;
   }
   ```
   If `userId` is supplied by an untrusted source or request (e.g. `../secrets/123`), the evaluated path becomes:
   `/databases/$(database)/documents/users/../secrets/123`
   If path canonicalization is applied naively (e.g. standard POSIX `path.normalize`):
   `users/..` pops `users`, leaving `secrets/123`.
   Then the lookup targets `secrets/123`, successfully escaping the `users` collection!
2. **Missing Document Boundary Validation**:
   In Firestore, documents exist strictly at **even-segment** paths (`collection/doc`, `collection/doc/subcollection/subdoc`). An odd number of segments designates a collection, not a document.
   Currently, `document-lookups.ts` performs no segment parity check:
   - Calling `get(/databases/$(database)/documents/users)` does not throw a path format error; it looks up `"users"` in `mockDocuments`.
   - Contrast this with Cloud Storage's Firestore lookup implementation (`packages/pyric/src/storage/sandbox/rules-methods.ts:182`):
     ```typescript
     if (docSegments.length === 0 || docSegments.length % 2 !== 0) {
       throw new RuleEvalError(
         `Firestore path does not point at a document (needs an even segment count): ${docSegments.join('/')}`,
       );
     }
     ```
     Firestore rules simulator lacks this fundamental invariant check!

---

### 2.4 Mechanics of Root Clamping & Canonicalization

To satisfy R4 and prevent collection escaping:
1. **Document Root Containment**:
   All paths must resolve within the document root `/databases/(default)/documents`. Relative `..` segments at the root cannot traverse above the document root (i.e. into `/databases`).
2. **Collection Root Clamping**:
   When a document path begins within a top-level collection (e.g. `users/...`), the top-level collection segment acts as a clamping boundary for relative traversal:
   - Traversal via `..` inside that collection cannot pop above the collection root segment.
   - For example:
     - `users/alice/../bob` → pops `alice`, pushes `bob` → `users/bob` (allowed: stays within `users`).
     - `users/../secrets/123` → `..` attempts to pop `users`. Clamping prevents popping `users`, so `users` remains. Then `secrets/123` is appended → `users/secrets/123`.
     - `users/secrets/123` has 3 segments (odd segment count, and under `users`), which **cannot** access `secrets/123`!
3. **Segment Validation (Even Non-Zero Parity)**:
   In `resolveGet`, enforce that the normalized relative path has an even, non-zero segment count (`segs.length > 0 && segs.length % 2 === 0`). If not, throw `EvalError`. In `resolveExists`, return `false`.

---

### 2.5 Remediation Plan for R4

#### File 1: `packages/pyric/src/rules/simulator/document-lookups.ts`
Implement robust path canonicalization with collection root clamping and document root containment in `normalizeDocumentPath`:

```typescript
export function normalizeDocumentPath(rawPath: string): string {
  let cleaned = rawPath.replace(/\$\(database\)/g, '(default)');
  const dbPrefix = '/databases/(default)/documents/';
  if (cleaned.startsWith(dbPrefix)) {
    cleaned = cleaned.slice(dbPrefix.length);
  } else if (cleaned.startsWith('/databases/(default)/documents')) {
    cleaned = cleaned.slice('/databases/(default)/documents'.length);
  }
  if (cleaned.startsWith('/')) {
    cleaned = cleaned.slice(1);
  }

  const rawSegments = cleaned.split('/').filter((s) => s.length > 0 && s !== '.');
  const stack: string[] = [];

  for (const seg of rawSegments) {
    if (seg === '..') {
      // Root clamping:
      // If stack has at least 2 segments, we can pop a document/subcollection segment.
      // If stack has exactly 1 segment (the collection root), clamping prevents popping
      // above the collection root!
      // If stack is empty (document root), clamping prevents popping above document root.
      if (stack.length > 1) {
        stack.pop();
      }
      // When stack.length === 1 or 0, '..' is clamped (ignored)
    } else {
      stack.push(seg);
    }
  }

  return stack.join('/');
}
```

In `resolveGet` (`document-lookups.ts:21–37`):
```typescript
export function resolveGet(rawPath: string, context: SimulationContext): SimResource {
  const path = normalizeDocumentPath(rawPath);
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0 || segments.length % 2 !== 0) {
    throw new EvalError(
      `get() requires a path pointing to a document (even segment count), got '${path}'`,
    );
  }
  let document = context.mockDocuments.get(path);
  if (!document && context.getDoc) {
    const loaded = context.getDoc(path);
    if (loaded) {
      context.mockDocuments.set(path, loaded);
      document = loaded;
    }
  }
  if (document) {
    return context.identitylessFunctionMocks?.has(path)
      ? { data: document }
      : makeGetResource(path, document);
  }
  throw new EvalError(`get() of non-existent document '${path}' (guard with exists() first)`);
}
```

In `resolveExists` (`document-lookups.ts:39–50`):
```typescript
export function resolveExists(rawPath: string, context: SimulationContext): boolean {
  const path = normalizeDocumentPath(rawPath);
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0 || segments.length % 2 !== 0) {
    return false;
  }
  if (context.mockDocuments.has(path)) return true;
  if (context.getDoc) {
    const loaded = context.getDoc(path);
    if (loaded) {
      context.mockDocuments.set(path, loaded);
      return true;
    }
  }
  return false;
}
```

---

## 3. Comparative Summary Table

| Feature / Invariant | Current Pyric Behavior | Production Firebase Parity Requirement | Files Requiring Changes |
|---|---|---|---|
| **Firestore Unary NOT on `null`/`undefined`** | Coerces via JS `!`: returns `true` (FALSE ALLOW) | Throws `EvalError` / runtime type error (FAILS CLOSED) | `packages/pyric/src/rules/simulator/evaluator.ts:74`<br>`packages/pyric/src/rules/simulator/eval-error.ts:3` |
| **Firestore Unary NOT on non-boolean types** | Coerces strings, numbers, objects to boolean (FALSE ALLOW / invalid evaluation) | Throws `EvalError` (`requireBoolean`) | `packages/pyric/src/rules/simulator/evaluator.ts:74` |
| **Storage Unary NOT on `null`/`undefined`** | Coerces via `!truthy(a)`: returns `true` (FALSE ALLOW) | Throws `RuleEvalError` (FAILS CLOSED) | `packages/pyric/src/storage/sandbox/rules-evaluator.ts:251` |
| **Storage Unary NOT on non-boolean types** | Coerces via `truthy(a)`: non-booleans evaluate without type errors | Throws `RuleEvalError` (FAILS CLOSED) | `packages/pyric/src/storage/sandbox/rules-evaluator.ts:251` |
| **Firestore Path Canonicalization (`..`)** | Raw `..` left in path string | Resolved with root containment & collection clamping | `packages/pyric/src/rules/simulator/document-lookups.ts:5–9` |
| **Firestore Path Collection Escape** | Unclamped; relative traversal escapes collection if normalized naively | Clamped to collection root: cannot escape collection | `packages/pyric/src/rules/simulator/document-lookups.ts:5–9` |
| **Firestore Document Lookups Parity Shape** | Allows odd segment count paths without checking document boundary | Enforces even non-zero segment count (collection/doc) | `packages/pyric/src/rules/simulator/document-lookups.ts:21–50` |

---

## 4. Verification and Regression Plan

1. **Unit Tests for R1**:
   - `packages/pyric/test/rules/simulator/evaluator.test.ts`:
     - Test `!lit(null)`, `!lit(undefined)` throw `EvalError` with message matching `/boolean/`.
     - Test `!lit("string")`, `!lit(0)`, `!lit(1)`, `!lit(1.5)` throw `EvalError`.
     - Test `!ident("request.auth")` when auth is null throws `EvalError`.
   - `packages/pyric/test/storage/sandbox/rules-evaluator.test.ts`:
     - Test Storage rules evaluating `allow read: if !request.auth.token.get('admin', null);` denies with reason indicating `RuleEvalError`.
     - Test evaluating `!resource.metadata.field` when field is null, undefined, string, or number denies.
2. **Unit Tests for R4**:
   - `packages/pyric/test/rules/simulator/document-lookups.test.ts`:
     - Test `normalizeDocumentPath('/databases/$(database)/documents/users/alice/../bob') === 'users/bob'`.
     - Test `normalizeDocumentPath('/databases/$(database)/documents/users/../secrets/123') === 'users/secrets/123'` (clamped collection root).
     - Test `normalizeDocumentPath('/databases/$(database)/documents/../../secrets/123') === 'secrets/123'` (clamped document root).
     - Test `resolveGet('/databases/$(database)/documents/users/../secrets/123', ctx)` with `mockDocuments` having `secrets/123`:
       Assert it throws `EvalError` and CANNOT access `secrets/123`.
     - Test `resolveExists('/databases/$(database)/documents/users/../secrets/123', ctx)` returns `false`.
3. **Full Suite Execution**:
   - Run `bun test` across all packages to verify zero regressions.
