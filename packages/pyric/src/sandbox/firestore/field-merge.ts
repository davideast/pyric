/**
 * Field-path merge engine (FS-B5 + FS-B6).
 *
 * Firestore's `updateDoc` and `setDoc(..., {merge})` are not shallow
 * object spreads. They build a *field mask* of leaf paths and set each
 * leaf into the existing document, creating intermediate maps as needed
 * and preserving sibling fields. This mirrors
 * `clones/firebase-js-sdk/packages/firestore/src/model/object_value.ts`
 * (`ObjectValue.set` / `getFieldsMap`) and `lite-api/user_data_reader.ts`
 * (`parseUpdateData` — every top-level `updateDoc` key is parsed as a
 * dot-separated FieldPath; `parseSetData` with `merge` extracts the mask
 * from the data's nested maps).
 *
 * Two entry points feed the same leaf-set engine:
 *
 *   - {@link applyUpdate} — `updateDoc(data)`. Each TOP-LEVEL key is a
 *     dot-separated FieldPath, so `{'a.b': 2}` sets leaf `a.b` (preserving
 *     `a.c`). A nested *map value* (`{a: {b: 2}}`) is a single-segment
 *     path `a` whose value is the whole map — it REPLACES `a` wholesale,
 *     matching prod (`updateDoc` does not deep-merge map values; only
 *     dot-paths reach into a map). `DELETE_MARKER` leaves delete the leaf.
 *
 *   - {@link applyMerge} — `setDoc(data, {merge:true})` /
 *     `{mergeFields}`. The mask is every leaf path reachable by walking
 *     the data's nested plain maps, so `{a:{b:2}}` sets leaf `a.b`
 *     (preserving `a.c`) — i.e. maps DEEP-merge. `mergeFields` restricts
 *     the mask to the listed (dot-separated) field paths.
 *
 * Both operate on a freshly cloned copy of `existing` and never mutate
 * the input. The resolved write tree is expected to have already run
 * through the value-resolver (sentinels resolved, deleteField → marker).
 */
import {
  DELETE_MARKER,
  isPlainObject,
  stripMarkers,
  type DocumentData,
} from './value-resolver.js';

/** Split a dot-separated FieldPath string into segments. */
function splitPath(key: string): string[] {
  return key.split('.');
}

/** Field-path segments that must never be walked or written. The merge
 *  engine sets leaves into plain JS objects, and `isPlainObject` treats
 *  `Object.prototype` (its `proto === null` branch) as plain — so a
 *  segment named `__proto__` (or, defence-in-depth, `constructor`/
 *  `prototype`) would let a rule-permitted `updateDoc`/`setDoc(merge)`
 *  walk into and pollute the shared prototype process-wide. Field names
 *  arrive via JSON transports that preserve `__proto__` as a genuine own
 *  key, so this is reachable with ordinary data. These are not valid
 *  Firestore field-path segments, so rejecting them is sandbox-only
 *  safety, not a parity regression. */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafeSegment(seg: string): void {
  if (UNSAFE_SEGMENTS.has(seg)) {
    throw new Error(
      `Invalid field-path segment '${seg}': the keys __proto__, prototype, ` +
        'and constructor are reserved and cannot appear in a field path.',
    );
  }
}

/** Deep clone a plain document tree, leaving class instances by reference
 *  (Timestamp, Bytes, etc. are immutable wrappers — safe to share). */
function cloneDoc(data: DocumentData): DocumentData {
  const out: DocumentData = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = cloneValue(v);
  }
  return out;
}

function cloneValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isPlainObject(v)) return cloneDoc(v);
  return v;
}

/**
 * Navigate to the parent map of `segments`, creating (or replacing
 * non-map intermediates with) plain maps along the way, then set or
 * delete the leaf. Mirrors `ObjectValue.getFieldsMap` + `applyChanges`.
 */
function setLeaf(root: DocumentData, segments: string[], value: unknown): void {
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    assertSafeSegment(seg);
    // Own-property read only: bare `cursor[seg]` would resolve an
    // unvalidated `__proto__` segment to the shared object prototype
    // (which `isPlainObject` accepts as a walkable map).
    const next = Object.hasOwn(cursor, seg) ? cursor[seg] : undefined;
    if (!isPlainObject(next)) {
      // Intermediate is missing or not a map — prod creates a fresh map
      // (the old value at this path is shadowed by the deeper write).
      cursor[seg] = {};
    }
    cursor = cursor[seg] as DocumentData;
  }
  const leaf = segments[segments.length - 1];
  assertSafeSegment(leaf);
  if (value === DELETE_MARKER) {
    delete cursor[leaf];
  } else {
    cursor[leaf] = stripMarkers(value);
  }
}

/**
 * `updateDoc` semantics — top-level keys are dot-separated FieldPaths.
 * `resolved` is the value-resolved write tree (its keys may contain dots;
 * `DELETE_MARKER` leaves mean deleteField()). Returns the merged doc.
 */
export function applyUpdate(
  existing: DocumentData,
  resolved: DocumentData,
): DocumentData {
  const out = cloneDoc(existing);
  for (const [key, value] of Object.entries(resolved)) {
    // FS-B13 — `deleteField()` may only appear at the top level of an update
    // (as a whole field value or via a dot-path key). Nested inside a map
    // literal it is invalid; prod throws `invalid-argument` rather than
    // silently destroying the sibling data. Mirrors
    // `clones/.../lite-api/user_data_reader.ts:DeleteFieldValueImpl`.
    if (value !== DELETE_MARKER && containsDeleteMarker(value)) {
      throw new DeleteFieldNestedError();
    }
    setLeaf(out, splitPath(key), value);
  }
  return out;
}

/**
 * FS-B13 — thrown when a `deleteField()` sentinel appears below the top
 * level of an `updateDoc` (or anywhere in a non-merge `set`). The write
 * layer maps this to an `invalid-argument` FirestoreError.
 */
export class DeleteFieldNestedError extends Error {
  constructor() {
    super('FieldValue.delete() can only appear at the top level of your update data');
    this.name = 'DeleteFieldNestedError';
  }
}

/** True when `value` contains a {@link DELETE_MARKER} anywhere in its tree. */
function containsDeleteMarker(value: unknown): boolean {
  if (value === DELETE_MARKER) return true;
  if (Array.isArray(value)) return value.some(containsDeleteMarker);
  if (isPlainObject(value)) {
    return Object.values(value).some(containsDeleteMarker);
  }
  return false;
}

/**
 * FS-B13 — validate an `updateDoc` payload: a `deleteField()` (DELETE_MARKER)
 * is legal only as a whole top-level value or via a dot-path key (the
 * top-level entry value === DELETE_MARKER). Nested inside a map literal it
 * throws {@link DeleteFieldNestedError}. Called pre-rules in
 * `LocalEnvironment.execute` so the denial reads like prod's parse-time
 * `invalid-argument`.
 */
export function assertNoNestedDeleteField(resolved: DocumentData): void {
  for (const value of Object.values(resolved)) {
    if (value !== DELETE_MARKER && containsDeleteMarker(value)) {
      throw new DeleteFieldNestedError();
    }
  }
}

/**
 * `setDoc(merge:true)` semantics — recursively extract the leaf-path mask
 * from `resolved` (nested maps deep-merge), then set each leaf. When
 * `mergeFields` is supplied, only those (dot-separated) top-level field
 * paths are written; everything else in `resolved` is ignored.
 */
export function applyMerge(
  existing: DocumentData,
  resolved: DocumentData,
  mergeFields?: readonly string[],
): DocumentData {
  const out = cloneDoc(existing);
  const mask: Array<{ segments: string[]; value: unknown }> = [];

  if (mergeFields !== undefined) {
    // Restrict to the listed field paths. Each is a dot-separated path
    // into `resolved`; read the value at that path (skip absent ones).
    for (const field of mergeFields) {
      const segments = splitPath(field);
      const value = readPath(resolved, segments);
      if (value !== ABSENT) mask.push({ segments, value });
    }
  } else {
    collectLeaves(resolved, [], mask);
  }

  for (const { segments, value } of mask) {
    setLeaf(out, segments, value);
  }
  return out;
}

const ABSENT: unique symbol = Symbol('field-merge:ABSENT');

/** Read the value at a segment path, or ABSENT if any segment is missing. */
function readPath(data: DocumentData, segments: string[]): unknown {
  let cursor: unknown = data;
  for (const seg of segments) {
    // `Object.hasOwn` (not `seg in cursor`) so an unvalidated `__proto__`
    // segment can't follow the inherited chain into `Object.prototype`.
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, seg)) return ABSENT;
    cursor = cursor[seg];
  }
  return cursor;
}

/**
 * Walk `data` collecting every leaf path. A leaf is a non-map value (or
 * an empty map — prod preserves an empty map as a set leaf). `DELETE_MARKER`
 * leaves are collected too so a merge can carry deleteField().
 */
function collectLeaves(
  data: DocumentData,
  prefix: string[],
  out: Array<{ segments: string[]; value: unknown }>,
): void {
  const keys = Object.keys(data);
  if (keys.length === 0 && prefix.length > 0) {
    // Empty map at a nested path — set it as an empty-map leaf.
    out.push({ segments: prefix, value: {} });
    return;
  }
  for (const key of keys) {
    const value = data[key];
    const segments = [...prefix, key];
    if (isPlainObject(value) && value !== (DELETE_MARKER as unknown)) {
      collectLeaves(value, segments, out);
    } else {
      out.push({ segments, value });
    }
  }
}
