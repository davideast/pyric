/**
 * Item 0.D / Item 7 — single source of truth for the post-write document
 * state under each WriteMode.
 *
 * Both `request.resource.data` (the data the rule sees) and
 * `getAfter(path)` (the projected post-write doc) MUST agree. Routing
 * everything through one function is the only way to make sure they
 * never diverge as the merge semantics evolve.
 *
 * Per-mode semantics (matches admin SDK):
 *   create               → after = payload (pre-state irrelevant; create
 *                           fails if doc exists, but that's enforced by
 *                           the test runner, not by this projection)
 *   set { merge: false } → after = payload (full replace)
 *   set { merge: true }  → after = recursive merge of pre and payload
 *   update               → for each top-level key in payload:
 *                           - if key contains '.', treat as field path:
 *                             setNested(result, key.split('.'), value)
 *                           - else: result[key] = value (entire replacement
 *                             at that key, NOT recursive merge — this is
 *                             the trap the 0.D hindsight describes)
 *   delete               → after = null (doc is gone)
 */
import type { WriteMode } from '../test/spec.js';

export type DocState = Record<string, unknown>;

/** Field-path segments that must never be walked or written. Because the
 *  projected doc is a plain JS object, a segment named `__proto__` (or, as
 *  defence-in-depth, `constructor`/`prototype`) would reach the shared
 *  `Object.prototype` and let a rule-permitted `update`/`set` payload
 *  pollute it process-wide (a field name arrives via JSON transports that
 *  preserve `__proto__` as a genuine own key). These are never valid
 *  Firestore-map segments in this projection, so rejecting them is a
 *  sandbox-only safety constraint, not a parity regression. */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafeSegment(seg: string): void {
  if (UNSAFE_SEGMENTS.has(seg)) {
    throw new Error(
      `Invalid field-path segment '${seg}': the keys __proto__, prototype, ` +
        'and constructor are reserved and cannot appear in a field path.',
    );
  }
}

/** Recursive merge for set({merge: true}) — payload wins on leaf collisions. */
function recursiveMerge(existing: DocState, payload: DocState): DocState {
  const out: DocState = { ...existing };
  for (const [k, v] of Object.entries(payload)) {
    assertSafeSegment(k);
    const cur = Object.hasOwn(out, k) ? out[k] : undefined;
    if (
      v !== null && typeof v === 'object' && !Array.isArray(v) &&
      cur !== null && typeof cur === 'object' && !Array.isArray(cur)
    ) {
      out[k] = recursiveMerge(cur as DocState, v as DocState);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Set a value at a nested path (mutates `obj`). Used by update dot-paths.
 *
 *  A field path that traverses a non-map intermediate REPLACES that prefix with
 *  a fresh map — this matches Firestore's updateDoc field-path semantics, where
 *  `updateDoc(ref, {'a.b': 1})` on a string `a` overwrites `a` with `{b:1}`
 *  (last-write-wins on the path prefix). (We intentionally do NOT throw here;
 *  the RULES-B10 fix is the update *merge* in handler.ts, not this projection.) */
function setNested(obj: DocState, path: string[], value: unknown): void {
  let cur: DocState = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    assertSafeSegment(seg);
    // Own-property read only: bare `cur[seg]` would resolve an unvalidated
    // segment to the shared object prototype.
    const next = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[seg] = {};
    }
    cur = cur[seg] as DocState;
  }
  const leaf = path[path.length - 1];
  assertSafeSegment(leaf);
  cur[leaf] = value;
}

/** Update mode: top-level keys replace; dot-paths patch nested maps. */
function updateMerge(existing: DocState, payload: DocState): DocState {
  const out: DocState = { ...existing };
  for (const [k, v] of Object.entries(payload)) {
    if (k.includes('.')) {
      setNested(out, k.split('.'), v);
    } else {
      assertSafeSegment(k);
      out[k] = v;
    }
  }
  return out;
}

/**
 * Project the after-state of a write. Returns null for `delete`.
 *
 * `existing` is the pre-write document state (typically `tc.resource`).
 * `payload` is the write payload (typically `tc.data`).
 */
export function projectAfterState(
  mode: WriteMode,
  existing: DocState | null,
  payload: DocState,
): DocState | null {
  switch (mode.kind) {
    case 'create':
      return payload;
    case 'set':
      return mode.merge ? recursiveMerge(existing ?? {}, payload) : payload;
    case 'update':
      return updateMerge(existing ?? {}, payload);
    case 'delete':
      return null;
  }
}
