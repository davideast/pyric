/**
 * Item 0.D / Item 7 — single source of truth for the post-write document
 * state under each WriteMode.
 *
 * Both `request.resource.data` (the data the rule sees) and
 * `getAfter(path)` (the projected post-write doc) MUST agree. Routing
 * everything through one function is the only way to make sure they
 * never diverge as the merge semantics evolve.
 */
import type { WriteMode } from '../test/spec.js';
import { isRulesMap } from './rules-type.js';

export type DocState = Record<string, unknown>;

const UNESCAPED_MAP_TAG = Symbol.for('pyric.unescapedMap');
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafeSegment(seg: string): void {
  if (UNSAFE_SEGMENTS.has(seg)) {
    throw new Error(
      `Invalid field-path segment '${seg}': the keys __proto__, prototype, ` +
        'and constructor are reserved and cannot appear in a field path.',
    );
  }
}

function isUnescapedTagged(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[UNESCAPED_MAP_TAG] === true
  );
}

function stampUnescaped(target: DocState): DocState {
  Object.defineProperty(target, UNESCAPED_MAP_TAG, { value: true });
  return target;
}

function defineOwnField(target: DocState, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function cloneMapPreservingTag(source: DocState): DocState {
  const out: DocState = {};
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_SEGMENTS.has(key)) continue;
    defineOwnField(out, key, value);
  }
  if (isUnescapedTagged(source)) {
    stampUnescaped(out);
  }
  return out;
}

/** Recursive merge for set({merge: true}) — payload wins on leaf collisions.
 *  Only plain maps recurse: a value wrapper (timestamp, bytes, latlng,
 *  reference, float, ...) is a Firestore scalar and is replaced as a leaf,
 *  as the sandbox's field merge does (FS-CON-1 / FS-MET-4a). */
function recursiveMerge(existing: DocState, payload: DocState): DocState {
  const out = cloneMapPreservingTag(existing);
  const existingHadKeys = Object.keys(existing).length > 0;
  for (const [k, v] of Object.entries(payload)) {
    assertSafeSegment(k);
    const cur = Object.hasOwn(out, k) ? out[k] : undefined;
    if (isRulesMap(v)) {
      if (Object.keys(v).length === 0) {
        const empty: DocState = {};
        if (isUnescapedTagged(v)) stampUnescaped(empty);
        defineOwnField(out, k, empty);
      } else if (isRulesMap(cur)) {
        defineOwnField(out, k, recursiveMerge(cur as DocState, v as DocState));
      } else {
        defineOwnField(out, k, recursiveMerge({}, v as DocState));
      }
    } else {
      defineOwnField(out, k, v);
    }
  }
  if (isUnescapedTagged(existing) || isUnescapedTagged(payload) || existingHadKeys) {
    stampUnescaped(out);
  }
  return out;
}

/** Set a value at a nested path. Used by update dot-paths. Writes into
 *  `obj`, and replaces each map along the path with a copy before writing
 *  into it, so a map shared with the pre-write document is never mutated. */
function setNested(obj: DocState, path: string[], value: unknown): void {
  let cur: DocState = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    assertSafeSegment(seg);
    const next = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
    let copy: DocState;
    if (isRulesMap(next)) {
      copy = cloneMapPreservingTag(next as DocState);
    } else {
      copy = {};
    }
    stampUnescaped(copy);
    defineOwnField(cur, seg, copy);
    cur = copy;
  }
  const leaf = path[path.length - 1]!;
  assertSafeSegment(leaf);
  defineOwnField(cur, leaf, value);
}

/** Update mode: top-level keys replace; dot-paths patch copies of nested
 *  maps, so `existing` is never mutated. */
function updateMerge(existing: DocState, payload: DocState): DocState {
  const out = cloneMapPreservingTag(existing);
  for (const [k, v] of Object.entries(payload)) {
    if (k.includes('.')) {
      setNested(out, k.split('.'), v);
    } else {
      assertSafeSegment(k);
      defineOwnField(out, k, v);
    }
  }
  stampUnescaped(out);
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
      if (mode.merge) return recursiveMerge(existing ?? {}, payload);
      return payload;
    case 'update':
      return updateMerge(existing ?? {}, payload);
    case 'delete':
      return null;
  }
}
