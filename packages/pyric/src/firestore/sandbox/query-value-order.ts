/**
 * Canonical Firestore query value comparator (FS-B3, #1364).
 *
 * Firestore orders heterogeneous field values by a fixed *type order*
 * first, then within a type. This module mirrors
 * `clones/firebase-js-sdk/packages/firestore/src/model/type_order.ts` +
 * `model/values.ts` (`valueCompare`) for the JS value shapes the sandbox
 * stores and receives as query operands.
 *
 * Type order (ascending):
 *   null < boolean < number < timestamp < string < bytes < reference
 *   < geopoint < array < vector < map
 *
 * A value's type comes from its tag, never its shape: a wrapper class
 * (rules, modular, or admin-compat) or a value Pyric registered, as
 * classified by {@link firestoreScalar}. A plain object is always a map,
 * whatever its keys (FL-3), and the rules `LatLng` and `Vector` wrappers
 * the store holds rank as geopoint and vector (FL-1, FL-2).
 */
import { compareUtf8Strings } from './utf8-order.js';
import { firestoreScalar, type FirestoreScalar } from './value-equality.js';

export const enum TypeRank {
  Null = 0,
  Boolean = 1,
  Number = 2,
  Timestamp = 3,
  String = 4,
  Bytes = 5,
  Reference = 6,
  GeoPoint = 7,
  Array = 8,
  Vector = 9,
  Map = 10,
}

const SCALAR_RANK: Readonly<Record<FirestoreScalar['kind'], TypeRank>> = {
  'timestamp': TypeRank.Timestamp,
  'bytes': TypeRank.Bytes,
  'reference': TypeRank.Reference,
  'geo-point': TypeRank.GeoPoint,
  'vector': TypeRank.Vector,
};

function primitiveRank(v: unknown): TypeRank | undefined {
  if (v === null || v === undefined) return TypeRank.Null;
  const t = typeof v;
  if (t === 'boolean') return TypeRank.Boolean;
  if (t === 'number' || t === 'bigint') return TypeRank.Number;
  if (t === 'string') return TypeRank.String;
  if (Array.isArray(v)) return TypeRank.Array;
  return undefined;
}

/** Rank a value into the canonical Firestore type order. */
export function typeOrderRank(v: unknown): TypeRank {
  const primitive = primitiveRank(v);
  if (primitive !== undefined) return primitive;
  const scalar = firestoreScalar(v);
  // Plain maps, and anything that is not a Firestore value (symbol,
  // function), rank as maps so they sort last and never throw.
  if (scalar === undefined) return TypeRank.Map;
  return SCALAR_RANK[scalar.kind];
}

function compareOrder<T>(a: T, b: T): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareNumbers(a: number, b: number): number {
  // NaN sorts as the smallest number (matches `compareNumbers` in
  // values.ts: NaN < any non-NaN, NaN === NaN). -0 and 0 compare equal.
  const aNaN = Number.isNaN(a);
  const bNaN = Number.isNaN(b);
  if (aNaN && bNaN) return 0;
  if (aNaN) return -1;
  if (bNaN) return 1;
  return compareOrder(a, b);
}

function compareBigIntToNumber(intVal: bigint, numVal: number): number {
  if (Number.isNaN(numVal)) return 1;
  if (numVal === Number.NEGATIVE_INFINITY) return 1;
  if (numVal === Number.POSITIVE_INFINITY) return -1;
  if (Number.isInteger(numVal)) {
    return compareOrder(intVal, BigInt(numVal));
  }
  const floor = BigInt(Math.floor(numVal));
  if (intVal <= floor) return -1;
  return 1;
}

export function compareNumericValues(a: number | bigint, b: number | bigint): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    return compareOrder(a, b);
  }
  if (typeof a === 'bigint') {
    return compareBigIntToNumber(a, b as number);
  }
  if (typeof b === 'bigint') {
    return -compareBigIntToNumber(b, a);
  }
  return compareNumbers(a, b);
}

function compareStrings(a: string, b: string): number {
  return compareUtf8Strings(a, b);
}

function compareSequences<T>(
  a: readonly T[],
  b: readonly T[],
  compare: (x: T, y: T) => number,
): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) continue;
    const cmp = compare(left, right);
    if (cmp !== 0) return cmp;
  }
  return compareOrder(a.length, b.length);
}

function pathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** Document keys compare segment by segment (`DocumentKey.comparator`), so
 * `users/u/g/1` sorts before `users-x/u/g/2` (FL-6). */
export function compareDocumentPaths(a: string, b: string): number {
  return compareSequences(pathSegments(a), pathSegments(b), compareStrings);
}

function compareScalars(a: FirestoreScalar, b: FirestoreScalar): number {
  if (a.kind === 'timestamp' && b.kind === 'timestamp') {
    const secCmp = compareOrder(a.seconds, b.seconds);
    if (secCmp !== 0) return secCmp;
    return compareOrder(a.nanoseconds, b.nanoseconds);
  }
  if (a.kind === 'bytes' && b.kind === 'bytes') {
    return compareSequences(a.values, b.values, compareOrder);
  }
  if (a.kind === 'reference' && b.kind === 'reference') {
    return compareDocumentPaths(a.path, b.path);
  }
  if (a.kind === 'geo-point' && b.kind === 'geo-point') {
    const latCmp = compareNumbers(a.latitude, b.latitude);
    if (latCmp !== 0) return latCmp;
    return compareNumbers(a.longitude, b.longitude);
  }
  if (a.kind === 'vector' && b.kind === 'vector') {
    // Upstream `compareVectors`: dimension first, then components.
    const lenCmp = compareOrder(a.values.length, b.values.length);
    if (lenCmp !== 0) return lenCmp;
    return compareSequences(a.values, b.values, compareNumbers);
  }
  return 0;
}

function compareMaps(am: Record<string, unknown>, bm: Record<string, unknown>): number {
  // Maps compare by UTF-8 sorted key, then value, then length -- matching
  // upstream `compareMaps`.
  const aKeys = Object.keys(am).sort(compareStrings);
  const bKeys = Object.keys(bm).sort(compareStrings);
  const n = Math.min(aKeys.length, bKeys.length);
  for (let i = 0; i < n; i++) {
    const aKey = aKeys[i];
    const bKey = bKeys[i];
    if (aKey === undefined || bKey === undefined) continue;
    const keyCmp = compareStrings(aKey, bKey);
    if (keyCmp !== 0) return keyCmp;
    const cmp = compareValues(am[aKey], bm[bKey]);
    if (cmp !== 0) return cmp;
  }
  return compareOrder(aKeys.length, bKeys.length);
}

/**
 * Compare two Firestore field values by canonical type order, then
 * within-type. Returns <0, 0, >0. Mirrors upstream `valueCompare`.
 */
export function compareValues(a: unknown, b: unknown): number {
  const ra = typeOrderRank(a);
  const rb = typeOrderRank(b);
  if (ra !== rb) {
    if (ra < rb) return -1;
    return 1;
  }

  switch (ra) {
    case TypeRank.Null:
      return 0;
    case TypeRank.Boolean: {
      if (a === b) return 0;
      if (a) return 1;
      return -1;
    }
    case TypeRank.Number:
      return compareNumericValues(a as number | bigint, b as number | bigint);
    case TypeRank.String:
      return compareStrings(a as string, b as string);
    case TypeRank.Array:
      return compareSequences(a as unknown[], b as unknown[], compareValues);
    case TypeRank.Map:
      return compareMaps(a as Record<string, unknown>, b as Record<string, unknown>);
    default: {
      const sa = firestoreScalar(a);
      const sb = firestoreScalar(b);
      if (sa === undefined || sb === undefined) return 0;
      return compareScalars(sa, sb);
    }
  }
}
