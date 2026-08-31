# Handoff Report: RTDB Rules Simulator Soundness (R2 & R3)

**Agent:** Explorer 2 (`explorer_survey_2`)  
**Task:** Read-only investigation of requirements R2 (Non-Truncating DataSnapshot Path Resolution) and R3 (Exhaustive Multi-Path RTDB Validation on Deletions)  
**Target Path:** `/Users/deast/repos/davideast/pyric/.agents/explorer_survey_2/handoff.md`  
**Reference Detailed Report:** `/Users/deast/repos/davideast/pyric/.agents/explorer_survey_2/report.md`  

---

## 1. Observation

### Observation 1.1: DataSnapshot Implementation in RTDB Simulator
In `packages/pyric/src/rules/rtdb/grammar/simulator.ts:116-151`:
```typescript
  child(path: string): DataSnapshot {
    const parts = path.split('/').filter(p => p.length > 0);
    let current: unknown = this._value;
    let currentPath = this._path;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        current = null;
        currentPath = `${currentPath}/${part}`.replace(/\/+/g, '/');
        break;
      }
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
    return rootSnap.child(parts.join('/'));
  }
```

Direct execution via `bun -e` confirmed:
```bash
$ bun -e "
import { DataSnapshot } from './packages/pyric/src/rules/rtdb/grammar/simulator.js';
const d = new DataSnapshot(null, '/', { rootItem: 1 });
console.log('child path:', d.child('a/b/c')._path);
console.log('parent path:', d.child('a/b/c').parent()._path);
console.log('parent exists:', d.child('a/b/c').parent().exists());
"
```
**Tool Result:**
```
child path: /a
parent path: /
parent exists: true
```

### Observation 1.2: Validation Traversal in Simulation Handler
In `packages/pyric/src/rules/rtdb/simulation/handler.ts:61-144`:
```typescript
function findFailingValidate(
  node: RtdbNode,
  data: DataSnapshot,
  newData: DataSnapshot,
  bindings: Record<string, string>,
  buildContext: ContextBuilder,
  pathToWrite: string[],
): ValidateFailure | null {
  ...
  function walk(
    node: RtdbNode,
    data: DataSnapshot,
    newData: DataSnapshot,
    bindings: Record<string, string>,
    remainingPath: string[],
  ): ValidateFailure | null {
    if (!newData.exists()) return null; // Line 79: aborts on delete
    ...
    for (const child of node.children) {
      ...
      if (remainingPath.length > 0) {
        if (!isPathVar && remainingPath[0] !== lastSegment) continue; // Line 104: skips siblings
        return walk(
          child,
          data.child(remainingPath[0]),
          newData.child(remainingPath[0]),
          isPathVar ? { ...bindings, [lastSegment]: remainingPath[0] } : bindings,
          remainingPath.slice(1),
        );
      }

      if (isPathVar) {
        for (const key of snapshotChildKeys(newData)) { // Line 117: ignores pre-write deleted keys
          const failure = walk(child, data.child(key), newData.child(key), ...);
          if (failure) return failure;
        }
      } else {
        const failure = walk(child, data.child(lastSegment), newData.child(lastSegment), ...);
        if (failure) return failure;
      }
    }
    return null;
  }
}
```
In `handler.ts:339`:
```typescript
const failure = findFailingValidate(
  rootNode,
  rootData,
  mergedRootData,
  {},
  buildContext,
  pathSegments,
);
```

### Observation 1.3: Update Dispatch in WritePlane
In `packages/pyric/src/database/sandbox/write-plane.ts:241-256`:
```typescript
  update(auth: AuthState, path: string, patch: Record<string, JsonValue>): void {
    const now = Date.now();
    const expanded = this.resolvePatch(path, patch, now);
    const multiPath = Object.keys(patch).some((key) => key.includes('/')); // Line 244
    const mockData = this.state.tree.snapshot() as Record<string, unknown>;
    const updates = Object.entries(expanded).map(([writePath, value]) => ({ path: writePath, value }));
    ...
    for (const update of updates) {
      ...
      const evaluation = this.state.rules.evaluate('write', update.path, {
        auth, mockData, newData: update.value, ...(multiPath ? { updates } : {}), // Line 255
      });
```

Direct execution via `bun -e` confirmed sibling bypass on deletion:
```bash
$ bun -e "
import { SimulateHandler } from './packages/pyric/src/rules/rtdb/simulation/handler.js';
const handler = new SimulateHandler();
const expr = (raw) => ({ raw, parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] } });
const rules = {
  path: '/', pathVariables: [],
  children: [{
    path: '/parent', pathVariables: [], write: expr('true'),
    children: [
      { path: '/parent/childA', pathVariables: [], validate: expr(\"newData.parent().child('childB').exists()\"), children: [] },
      { path: '/parent/childB', pathVariables: [], children: [] }
    ]
  }]
};
const mockData = { parent: { childA: 'A', childB: 'B' } };
const result = handler.execute(rules, {
  operation: 'write', path: '/parent/childB', auth: { uid: 'u1', token: {} },
  mockData, newData: null, updates: [{ path: '/parent/childB', value: null }]
});
console.log('Allowed:', result.data.allowed);
"
```
**Tool Result:**
```
Allowed: true
```

---

## 2. Logic Chain

1. **R2 Root Cause & Vulnerability:**
   - From Observation 1.1 (`simulator.ts:125`), when navigating down a path where intermediate nodes do not exist or are primitives (`typeof current !== 'object'`), the loop appends a single segment to `currentPath` and executes `break;`.
   - Any remaining segments are dropped: `data.child('a/b/c')` produces a snapshot whose `_path` is `'/a'` rather than `'/a/b/c'`.
   - On this truncated snapshot, calling `.parent()` pops the single segment `'a'`, resulting in `parentPath = '/'`.
   - Line 144 returns `rootSnap` (`new DataSnapshot(this._root, '/')`).
   - Because `this._root` holds the active mock database state, `rootSnap.exists()` evaluates to `true`.
   - This directly causes `data.child('a/b/c').parent().exists()` to evaluate to `true` (false allow) when `a` does not exist.

2. **R3 Root Cause & Vulnerability:**
   - From Observation 1.2 (`handler.ts:104`), while `remainingPath.length > 0`, `findFailingValidate` skips all sibling nodes (`continue`).
   - From Observation 1.2 (`handler.ts:79`), once the write target is reached, if `!newData.exists()` (a deletion), `walk` returns `null` immediately.
   - From Observation 1.2 (`handler.ts:117`), path variable iteration only evaluates keys in `snapshotChildKeys(newData)`, skipping pre-write keys that were deleted.
   - From Observation 1.3 (`write-plane.ts:244, 255`), shallow updates without `/` in keys do not pass `updates`, evaluating each leaf independently.
   - When an update deletes a subtree (e.g. `/parent/childB = null`), `findFailingValidate` only checks `/parent/childB`, aborts at `newData = null`, and never visits surviving sibling `/parent/childA`.
   - If `/parent/childA` enforces a schema invariant (e.g., `newData.parent().child('childB').exists()`), that invariant is violated in `mergedRootData`, but because `/parent/childA` is never evaluated, the write is permitted (`allowed: true`).

---

## 3. Caveats

- **No caveats.** The exact root causes were reproduced and verified via targeted script execution directly against the compiled source modules. Both requirements R2 and R3 have been completely mapped with exact file locations, line numbers, and actionable remediation designs.

---

## 4. Conclusion

1. **R2:** `DataSnapshot.child()` in `packages/pyric/src/rules/rtdb/grammar/simulator.ts` must remove the `break;` statement and iterate through all path segments, constructing the full virtual path `${prefix}/${parts.join('/')}` so that missing and primitive child snapshots maintain path fidelity and chained `.parent()` calls navigate back through their actual virtual ancestors.
2. **R3:** `findFailingValidate` in `packages/pyric/src/rules/rtdb/simulation/handler.ts` must be refactored to evaluate rules across all write paths from `updates`. When deletions or writes occur under an ancestor, all surviving sibling nodes present in `mergedRootData` (both static and under `$var`) must be recursively validated against `mergedRootData`. In `packages/pyric/src/database/sandbox/write-plane.ts`, `WritePlane.update` must always provide `updates` to `rules.evaluate`.

---

## 5. Verification Method

1. **Unit Test Execution:**
   Run existing test suites with bun:
   ```bash
   bun test packages/pyric/test/rules/rtdb/grammar/simulator.test.ts packages/pyric/test/rules/rtdb/simulation/handler.test.ts
   ```
2. **R2 Soundness Check:**
   Verify in bun that:
   ```typescript
   const d = new DataSnapshot(null, '/', { rootItem: 1 });
   expect(d.child('a/b/c')._path).toBe('/a/b/c');
   expect(d.child('a/b/c').parent()._path).toBe('/a/b');
   expect(d.child('a/b/c').parent().exists()).toBe(false);
   ```
3. **R3 Soundness Check:**
   Verify in bun that:
   - Deleting a node via multi-path update triggers validation on surviving siblings.
   - If a surviving sibling has a `.validate` rule that fails against `mergedRootData`, `allowed` is `false`.
