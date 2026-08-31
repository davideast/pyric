# Comprehensive Investigation Report: RTDB Rules Simulator Soundness (R2 & R3)

**Author:** Explorer 2 (`explorer_survey_2`)  
**Date:** 2026-08-31  
**Scope:** Requirements R2 (Non-Truncating DataSnapshot Path Resolution) & R3 (Exhaustive Multi-Path RTDB Validation on Deletions)  
**Target Repository:** `/Users/deast/repos/davideast/pyric`  
**Mode:** Read-Only Investigation & Remediation Architecture Specification  

---

## 1. Executive Summary

This investigation analyzed critical soundness vulnerabilities (false allows) in Pyric's Realtime Database (RTDB) security rules simulator.

1. **R2 (Non-Truncating DataSnapshot Path Resolution):**
   In `packages/pyric/src/rules/rtdb/grammar/simulator.ts`, `DataSnapshot.child()` contains a premature `break;` statement (line 125) that executes when encountering a `null`, `undefined`, or primitive node. This drops all subsequent path segments, truncating virtual paths (e.g., `data.child('a/b/c')` on missing `data` truncates to `/a`). Chained `.parent()` calls then operate on this truncated path and immediately collapse to the root node (`/`), returning `rootSnap`. Because the database root typically contains mock data, `rootSnap.exists()` evaluates to `true`, causing rules checking parent existence (e.g. `data.child('a/b/c').parent().exists()`) to falsely allow unauthorized operations.

2. **R3 (Exhaustive Multi-Path RTDB Validation on Deletions):**
   In `packages/pyric/src/rules/rtdb/simulation/handler.ts` and `packages/pyric/src/database/sandbox/write-plane.ts`, `.validate` schema enforcement is path-restricted and fails to account for deletions. When a write or multi-location update deletes a subtree (setting a value to `null`):
   - `findFailingValidate` only descends along the target write path (`pathToWrite`), skipping all sibling branches (`continue` on line 104).
   - Upon reaching the deleted node, `findFailingValidate` encounters `if (!newData.exists()) return null;` (line 79) and immediately halts traversal without validating any surviving siblings.
   - Under path variable nodes (`$var`), line 117 only iterates `snapshotChildKeys(newData)`, completely ignoring pre-write keys deleted during the write.
   - In `WritePlane.update`, shallow updates (`update(ref, { childB: null })`) omit `updates` projection when keys lack `/` (line 244/255), evaluating each leaf in isolation.
   Consequently, when an update deletes a node, sibling nodes in the database that enforce relational schema invariants (e.g., `newData.parent().child('deletedNode').exists()`) are never evaluated, resulting in severe false allows.

---

## 2. Requirement R2: Non-Truncating DataSnapshot Path Resolution

### 2.1 Location of DataSnapshot
The rules evaluation `DataSnapshot` is located at:
- **File Path:** `/Users/deast/repos/davideast/pyric/packages/pyric/src/rules/rtdb/grammar/simulator.ts`
- **Lines:** 67–151

*(Note: The client SDK snapshot in `packages/pyric/src/database/data-snapshot.ts` is the public Firebase JS SDK wrapper; the rules engine uses the Ohm-based simulator's internal `DataSnapshot` class defined in `grammar/simulator.ts`.)*

### 2.2 Current Implementation of `child()` and `parent()`

```typescript
// packages/pyric/src/rules/rtdb/grammar/simulator.ts:116-151

  child(path: string): DataSnapshot {
    const parts = path.split('/').filter(p => p.length > 0);
    let current: unknown = this._value;
    let currentPath = this._path;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        current = null;
        currentPath = `${currentPath}/${part}`.replace(/\/+/g, '/');
        break; // <--- CRITICAL DEFECT: early exit truncates remaining segments!
      }
      // Own-property access only: a `__proto__`/`constructor` child must
      // not resolve to the JS prototype chain.
      current = Object.hasOwn(current as object, part)
        ? ((current as Record<string, unknown>)[part] ?? null)
        : null;
      currentPath = `${currentPath === '/' ? '' : currentPath}/${part}`;
    }

    return new DataSnapshot(current, currentPath, this._root);
  }

  parent(): DataSnapshot | null {
    if (this._path === '/') return null;
    const parts = this._path.split('/').filter(p => p.length > 0);
    parts.pop();
    const parentPath = '/' + parts.join('/');
    const rootSnap = new DataSnapshot(this._root, '/');
    if (parentPath === '/') return rootSnap;
    return rootSnap.child(parts.join('/')); // <--- Re-invokes buggy child() on root
  }
```

### 2.3 Why Chained `.parent()` Calls Collapse Prematurely to Root (`/`)

1. **Premature Loop Termination in `child()`:**
   - Consider `data = new DataSnapshot(null, '/', mockData)` where `mockData = { rootItem: 1 }`.
   - When `data.child('a/b/c')` is called:
     - `parts = ['a', 'b', 'c']`.
     - Iteration 1 (`part = 'a'`): `current` is `null`.
     - Condition `if (current === null ...)` at line 122 matches.
     - Line 124 updates `currentPath = '/a'`.
     - Line 125 executes `break;`.
     - Segments `'b'` and `'c'` are never processed!
     - The returned snapshot has `_path = '/a'`, rather than `'/a/b/c'`.
2. **Immediate Collapse in `.parent()`:**
   - On the returned snapshot (path `'/a'`), `.parent()` is called.
   - `parts = ['a']`.
   - `parts.pop()` removes `'a'`, leaving `parts = []`.
   - Line 142 computes `parentPath = '/'`.
   - Line 144 matches: `if (parentPath === '/') return rootSnap;`.
   - It returns `rootSnap` (`new DataSnapshot(mockData, '/')`).
3. **Catastrophic False Allow via Root Existence:**
   - Since `mockData` contains existing database data, `rootSnap.exists()` evaluates to `true`.
   - Therefore, `data.child('a/b/c').parent().exists()` evaluates to `true` instead of `false`.
4. **Behavior on Partial Objects:**
   - If `data` is `{ existing: 1 }` and `data.child('missing/child/leaf')` is called:
     - Iteration 1 (`'missing'`): `missing` is absent from `{ existing: 1 }`. Line 130 sets `current = null` and `currentPath = '/missing'`.
     - Iteration 2 (`'child'`): Line 122 matches (`current === null`). Line 124 sets `currentPath = '/missing/child'`. Line 125 executes `break;`.
     - Segment `'leaf'` is discarded. The snapshot path is `'/missing/child'`.
     - A single `.parent()` call pops `'child'`, invoking `rootSnap.child('missing')` which resolves to `/missing`. A second `.parent()` call collapses directly to root `/`.
5. **Double Truncation in `parent()`:**
   - Line 145 calls `rootSnap.child(parts.join('/'))`. Because `child()` itself is defective, re-running `child()` on a non-existent path truncates again during navigation upward.

### 2.4 Empirical Proof of Vulnerability

Executing `bun -e` against `packages/pyric/src/rules/rtdb/grammar/simulator.ts`:
```bash
$ bun -e "
import { DataSnapshot } from './packages/pyric/src/rules/rtdb/grammar/simulator.js';
const d = new DataSnapshot(null, '/', { rootItem: 1 });
console.log('child path:', d.child('a/b/c')._path);
console.log('parent path:', d.child('a/b/c').parent()._path);
console.log('parent exists:', d.child('a/b/c').parent().exists());
"
```
**Observed Output:**
```
child path: /a
parent path: /
parent exists: true
```
**Expected Parity Output:**
```
child path: /a/b/c
parent path: /a/b
parent exists: false
```

### 2.5 Remediation Specification for R2

To preserve the full virtual path hierarchy across chained `.child().parent()` calls:

1. **Remove `break;` in `DataSnapshot.child()`:**
   Iterate through all segments in `parts`. If `current` is `null` or a non-object primitive, retain `current = null` for subsequent iterations while continuing to append all path segments.
2. **Canonical Virtual Path Construction:**
   Construct the child path deterministically by concatenating the parent path and the requested segments:
   ```typescript
   const prefix = this._path === '/' ? '' : this._path;
   const childPath = `${prefix}/${parts.join('/')}`;
   ```
3. **Safe Value Lookup Loop:**
   ```typescript
   child(path: string): DataSnapshot {
     const parts = path.split('/').filter(p => p.length > 0);
     if (parts.length === 0) return this;

     let current: unknown = this._value;
     for (const part of parts) {
       if (current !== null && current !== undefined && typeof current === 'object') {
         current = Object.hasOwn(current as object, part)
           ? ((current as Record<string, unknown>)[part] ?? null)
           : null;
       } else {
         current = null;
       }
     }

     const prefix = this._path === '/' ? '' : this._path;
     const currentPath = `${prefix}/${parts.join('/')}`;
     return new DataSnapshot(current, currentPath, this._root);
   }
   ```
4. **Reliable `parent()` Navigation:**
   With non-truncating `child()`, `parent()` correctly computes:
   ```typescript
   parent(): DataSnapshot | null {
     if (this._path === '/') return null;
     const parts = this._path.split('/').filter(p => p.length > 0);
     parts.pop();
     if (parts.length === 0) {
       return new DataSnapshot(this._root, '/');
     }
     const rootSnap = new DataSnapshot(this._root, '/');
     return rootSnap.child(parts.join('/'));
   }
   ```
   Now:
   - `data.child('a/b/c')` has path `'/a/b/c'` and `val() === null`.
   - `data.child('a/b/c').parent()` resolves `rootSnap.child('a/b')`, having path `'/a/b'` and `val() === null`.
   - `.exists()` evaluates to `false` (correct fail-closed parity).

---

## 3. Requirement R3: Exhaustive Multi-Path RTDB Validation on Deletions

### 3.1 Pipeline Architecture of RTDB Multi-Location Writes

The multi-location write and update flow spans four key files:

```
┌────────────────────────────────────────────────────────────────┐
│ packages/pyric/src/database/operations.ts                      │
│ - update(ref, values)                                          │
└───────────────────────────────┬────────────────────────────────┘
                                │ Calls target.backend.update(...)
┌───────────────────────────────▼────────────────────────────────┐
│ packages/pyric/src/database/sandbox/write-plane.ts             │
│ - WritePlane.update(auth, path, patch)                         │
│ - Resolves patch to expanded absolute paths                    │
│ - Iterates over updates: rules.evaluate('write', update.path)  │
└───────────────────────────────┬────────────────────────────────┘
                                │ Calls simulateRtdbRules(...)
┌───────────────────────────────▼────────────────────────────────┐
│ packages/pyric/src/database/sandbox/rules-eval.ts              │
│ - RulesEvaluator.evaluate('write', path, ctx)                  │
└───────────────────────────────┬────────────────────────────────┘
                                │ Invokes SimulateHandler.execute(...)
┌───────────────────────────────▼────────────────────────────────┐
│ packages/pyric/src/rules/rtdb/simulation/handler.ts            │
│ - projectPostWriteTree(base, targetSegments, newData, updates) │
│ - SimulateHandler.execute(compiled, rawInput)                  │
│ - findFailingValidate(rootNode, rootData, mergedRootData, ...) │
└────────────────────────────────────────────────────────────────┘
```

### 3.2 Current Mechanism for `.validate` Collection and Evaluation

In `packages/pyric/src/rules/rtdb/simulation/handler.ts`:
1. `SimulateHandler.execute` checks `.write` rules from root down to the target path.
2. If granted, line 339 invokes `findFailingValidate`:
   ```typescript
   const failure = findFailingValidate(
     rootNode,
     rootData,
     mergedRootData,
     {},
     buildContext,
     pathSegments, // <--- Only evaluates a single path!
   );
   ```
3. Inside `findFailingValidate` (lines 61–144):
   - **Line 79:**
     ```typescript
     // A null proposed value is a delete — RTDB does not validate deletes.
     if (!newData.exists()) return null;
     ```
   - **Lines 103–112:** Above the write location, traversal strictly filters to the single target path:
     ```typescript
     if (remainingPath.length > 0) {
       if (!isPathVar && remainingPath[0] !== lastSegment) continue;
       return walk(
         child,
         data.child(remainingPath[0]),
         newData.child(remainingPath[0]),
         isPathVar ? { ...bindings, [lastSegment]: remainingPath[0] } : bindings,
         remainingPath.slice(1),
       );
     }
     ```
   - **Lines 114–126:** At the write location, path variable fan-out only queries post-write keys:
     ```typescript
     for (const key of snapshotChildKeys(newData)) {
       const failure = walk(child, data.child(key), newData.child(key), ...);
       if (failure) return failure;
     }
     ```

### 3.3 Root Causes: Why Subtree Deletions Bypass Sibling `.validate` Rules

There are four interlocking flaws causing false allows on deletions:

#### Flaw 1: Early Exit on Deleted Nodes in `walk()` (`handler.ts:79`)
When a node is deleted (`newData = null`), `newData.exists()` is `false`. Line 79 immediately aborts:
```typescript
if (!newData.exists()) return null;
```
This halts the walk immediately at the deleted leaf, preventing any further traversal or verification of sibling constraints.

#### Flaw 2: Sibling Branch Pruning (`handler.ts:104`)
While descending from the root to the write location (`remainingPath.length > 0`), line 104 explicitly skips all sibling nodes:
```typescript
if (!isPathVar && remainingPath[0] !== lastSegment) continue;
```
If a write deletes `/parent/childB`, `remainingPath` is `['parent', 'childB']`. When at `/parent`, the algorithm skips `/parent/childA` because `childA !== 'childB'`. Sibling `childA` is completely bypassed even though `childA` remains in the database and may have rules dependent on `childB`.

#### Flaw 3: `snapshotChildKeys(newData)` Ignores Deleted Pre-Write Keys (`handler.ts:117`)
When fanning out under dynamic `$var` nodes, line 117 iterates only `snapshotChildKeys(newData)`. Any key that existed in `data` (pre-write) but was deleted in `newData` (post-write) is absent from this list. Thus, dynamic sibling rules under `$var` are never validated against deleted keys.

#### Flaw 4: Single-Path Evaluation in `WritePlane.update` (`write-plane.ts:244, 251-255`)
In `write-plane.ts`:
- Line 244 defines:
  `const multiPath = Object.keys(patch).some((key) => key.includes('/'));`
- Line 255 passes `updates` only if `multiPath` is true:
  `...(multiPath ? { updates } : {})`
When a caller performs a shallow multi-key update on a reference (e.g., `update(ref, { childA: 'val', childB: null })`), `multiPath` evaluates to `false` because keys lack `/`. Therefore, `updates` is omitted from `rules.evaluate`.
Furthermore, lines 251–272 loop exclusively over paths explicitly listed in `patch`. Any existing sibling node in the database not explicitly mentioned in `patch` is never subjected to rule evaluation.

### 3.4 Empirical Proof of Vulnerability

Executing `bun -e` against `packages/pyric/src/rules/rtdb/simulation/handler.ts`:
```bash
$ bun -e "
import { SimulateHandler } from './packages/pyric/src/rules/rtdb/simulation/handler.js';
const handler = new SimulateHandler();
const expr = (raw) => ({ raw, parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] } });
const rules = {
  path: '/',
  pathVariables: [],
  children: [{
    path: '/parent',
    pathVariables: [],
    write: expr('true'),
    children: [
      {
        path: '/parent/childA',
        pathVariables: [],
        validate: expr(\"newData.parent().child('childB').exists()\"),
        children: []
      },
      {
        path: '/parent/childB',
        pathVariables: [],
        children: []
      }
    ]
  }]
};

// Initial state: childA and childB exist.
const mockData = { parent: { childA: 'A', childB: 'B' } };

// Delete childB via multi-path update. childA's invariant is now violated.
const result = handler.execute(rules, {
  operation: 'write',
  path: '/parent/childB',
  auth: { uid: 'u1', token: {} },
  mockData,
  newData: null,
  updates: [{ path: '/parent/childB', value: null }]
});

console.log('Allowed:', result.data.allowed);
"
```
**Observed Output:**
```
Allowed: true
```
**Expected Parity Output:**
```
Allowed: false (Validation rule at '/parent/childA' evaluated to false)
```

The write deleting `childB` was falsely allowed, completely bypassing `childA`'s validation rule!

### 3.5 Remediation Specification for R3

To guarantee that `.validate` schema rules are evaluated across the union of pre-write and post-write paths:

#### 1. Pass Full Updates Set in `WritePlane.update`
In `packages/pyric/src/database/sandbox/write-plane.ts`:
- Change line 255 to always pass `updates` if `updates.length > 0` (or `updates.length > 1`), matching `validateUpdate` line 236:
  ```typescript
  const evaluation = this.state.rules.evaluate('write', update.path, {
    auth,
    mockData,
    newData: update.value,
    ...(updates.length > 1 ? { updates } : {}),
  });
  ```

#### 2. Exhaustive Validation Algorithm Across Union of Paths in `handler.ts`
In `packages/pyric/src/rules/rtdb/simulation/handler.ts`, refactor `findFailingValidate` to accept the set of all modified write paths (`allWritePaths: string[][]`).

**Algorithm Structure:**
1. **Identify Target Subtrees:**
   Derive all write paths from `updates` (if provided) or `pathSegments`:
   ```typescript
   const allWritePaths = updates && updates.length > 0
     ? updates.map(u => u.path.split('/').filter(Boolean))
     : [pathSegments];
   ```
2. **Evaluate Current Node Validation:**
   If `node.validate` exists and `newData.exists()`:
   Evaluate `node.validate`. If false, immediately return validation failure. (Do not evaluate `.validate` on deleted nodes where `!newData.exists()`).
3. **Determine Union of Pre-Write and Post-Write Children:**
   At `node`, determine the union of keys:
   ```typescript
   const preKeys = snapshotChildKeys(data);
   const postKeys = snapshotChildKeys(newData);
   const unionKeys = new Set([...preKeys, ...postKeys]);
   ```
4. **Detect Local Modifications and Deletions:**
   Determine whether any write path terminates at or below `node`, or if `preKeys` contains any key absent in `postKeys` (a deletion under `node`).
5. **Fan-Out Rule:**
   - For child nodes in `node.children`:
     - If `child` matches a write path (it is on the path to a write target):
       Recurse into `child`.
     - If a deletion or write occurred under `node`:
       Recurse into **every surviving sibling child** present in `postKeys` (and all static sibling nodes in `node.children` that exist in `newData`).
     - If below the write target:
       Fan out through all keys in `postKeys`.
6. **Fail-Closed Result:**
   If any validation rule in the affected subtrees evaluates to `false`, return the failure details (`{ node, rule, bindings }`).

---

## 4. Summary Table of Files, Lines, and Defect Impacts

| Requirement | Target File Path | Line Numbers | Current Defect | Impact / Vulnerability | Recommended Fix |
|---|---|---|---|---|---|
| **R2** | `packages/pyric/src/rules/rtdb/grammar/simulator.ts` | 121–126 | `break;` on line 125 terminates loop on missing or primitive nodes. | Truncates multi-segment paths (e.g. `/a/b/c` → `/a`), causing chained `.parent()` to prematurely collapse to `/` and evaluate `exists()` as `true`. | Remove `break;`; iterate all segments; set `current = null` while building full virtual path. |
| **R2** | `packages/pyric/src/rules/rtdb/grammar/simulator.ts` | 138–146 | `parent()` re-invokes `rootSnap.child(parts.join('/'))` on root. | Re-triggers truncation in `child()`. | Ensure clean virtual path slicing; return `rootSnap` only when path is `/`. |
| **R3** | `packages/pyric/src/rules/rtdb/simulation/handler.ts` | 78–79 | `if (!newData.exists()) return null;` immediately aborts walk. | Subtree deletions immediately return `null`, ignoring sibling validation rules. | Skip `.validate` on null node itself, but continue validating surviving sibling subtrees. |
| **R3** | `packages/pyric/src/rules/rtdb/simulation/handler.ts` | 103–112 | `if (!isPathVar && remainingPath[0] !== lastSegment) continue;` | Prunes all sibling branches above the write location. | Fan out to all surviving sibling nodes when a deletion or write occurs under the common ancestor. |
| **R3** | `packages/pyric/src/rules/rtdb/simulation/handler.ts` | 114–126 | `snapshotChildKeys(newData)` | Only enumerates post-write keys under `$var`, ignoring pre-write deleted keys. | Use union of `snapshotChildKeys(data)` and `snapshotChildKeys(newData)` to detect deletions and validate surviving siblings. |
| **R3** | `packages/pyric/src/rules/rtdb/simulation/handler.ts` | 338–346 | `findFailingValidate(..., pathSegments)` | Passes only a single path, ignoring sibling updates in atomic batch. | Pass `allWritePaths` from `updates` to `findFailingValidate`. |
| **R3** | `packages/pyric/src/database/sandbox/write-plane.ts` | 244, 255 | `...(multiPath ? { updates } : {})` | Shallow multi-key updates (no `/`) omit `updates` projection. | Always pass `updates` if `updates.length > 0`. |

---

## 5. Verification and Regression Test Plan

### Test Set 1: DataSnapshot Path Hierarchy (R2)
Add to `packages/pyric/test/rules/rtdb/grammar/simulator.test.ts`:
1. `data.child('a/b/c').parent().exists()` on null `data` returns `false`.
2. `data.child('a/b/c')._path` on null `data` resolves to `'/a/b/c'`.
3. `data.child('a/b/c').parent()._path` resolves to `'/a/b'`.
4. `data.child('a/b/c').parent().parent()._path` resolves to `'/a'`.
5. `data.child('a/b/c').parent().parent().parent()._path` resolves to `'/'`.
6. Navigating through primitive values (e.g. `snap = new DataSnapshot(42, '/score')`):
   - `snap.child('x/y').exists()` is `false`.
   - `snap.child('x/y').parent().parent().val()` is `42`.

### Test Set 2: Multi-Path Update Validation on Deletions (R3)
Add to `packages/pyric/test/rules/rtdb/simulation/handler.test.ts`:
1. **Sibling Invariant on Static Paths:**
   - Schema: `/parent/childA` requires `newData.parent().child('childB').exists()`.
   - Pre-write: `/parent` contains `childA` and `childB`.
   - Update: Delete `/parent/childB` via `updates: [{ path: '/parent/childB', value: null }]`.
   - Expected: `allowed: false`, `matchedPath: '/parent/childA'`.
2. **Sibling Invariant on Path Variables (`$var`):**
   - Schema: `/items/$itemId` requires `newData.parent().child('summary').exists()`.
   - Pre-write: `/items/i1` exists and `/items/summary` exists.
   - Update: Delete `/items/summary` via `updates: [{ path: '/items/summary', value: null }]`.
   - Expected: `allowed: false`, `matchedPath: '/items/i1'`.
3. **Subtree Deletion with Cross-Branch Validation:**
   - Schema: `/rooms/$roomId/messages` requires `newData.parent().child('meta/count').exists()`.
   - Pre-write: `/rooms/r1` contains `messages` and `meta/count`.
   - Update: Delete `/rooms/r1/meta/count` (or delete `/rooms/r1/meta`).
   - Expected: `allowed: false`, `matchedPath: '/rooms/$roomId/messages'`.
4. **Legitimate Multi-Path Update Allowed:**
   - Verify that updates satisfying all sibling invariants continue to be allowed without regression.
