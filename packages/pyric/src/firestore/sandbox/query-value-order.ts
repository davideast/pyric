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
  return scalar === undefined ? TypeRank.Map : SCALAR_RANK[scalar.kind];
}

function compareOrder<T>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

function compareStrings(a: string, b: string): number {
  // Firestore compares strings by UTF-8 byte order. For the BMP-only
  // corpus the sandbox exercises, JS's `<`/`>` (UTF-16 code-unit order)
  // agrees with UTF-8 byte order; surrogate-pair edge cases are an
  // accepted approximation (documented divergence).
  return compareOrder(a, b);
}

function compareSequences<T>(
  a: readonly T[],
  b: readonly T[],
  compare: (x: T, y: T) => number,
): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const cmp = compare(a[i]!, b[i]!);
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
    return compareOrder(a.seconds, b.seconds) || compareOrder(a.nanoseconds, b.nanoseconds);
  }
  if (a.kind === 'bytes' && b.kind === 'bytes') {
    return compareSequences(a.values, b.values, compareOrder);
  }
  if (a.kind === 'reference' && b.kind === 'reference') {
    return compareDocumentPaths(a.path, b.path);
  }
  if (a.kind === 'geo-point' && b.kind === 'geo-point') {
    return compareNumbers(a.latitude, b.latitude) || compareNumbers(a.longitude, b.longitude);
  }
  if (a.kind === 'vector' && b.kind === 'vector') {
    // Upstream `compareVectors`: dimension first, then components.
    return compareOrder(a.values.length, b.values.length)
      || compareSequences(a.values, b.values, compareNumbers);
  }
  return 0;
}

function compareMaps(am: Record<string, unknown>, bm: Record<string, unknown>): number {
  // Maps compare by sorted key, then value, then length — matching
  // upstream `compareMaps`.
  const aKeys = Object.keys(am).sort();
  const bKeys = Object.keys(bm).sort();
  const n = Math.min(aKeys.length, bKeys.length);
  for (let i = 0; i < n; i++) {
    const keyCmp = compareStrings(aKeys[i]!, bKeys[i]!);
    if (keyCmp !== 0) return keyCmp;
    const cmp = compareValues(am[aKeys[i]!], bm[bKeys[i]!]);
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
  if (ra !== rb) return ra < rb ? -1 : 1;

  switch (ra) {
    case TypeRank.Null:
      return 0;
    case TypeRank.Boolean:
      return (a === b) ? 0 : (a ? 1 : -1);
    case TypeRank.Number:
      return compareNumbers(Number(a), Number(b));
    case TypeRank.String:
      return compareStrings(a as string, b as string);
    case TypeRank.Array:
      return compareSequences(a as unknown[], b as unknown[], compareValues);
    case TypeRank.Map:
      return compareMaps(a as Record<string, unknown>, b as Record<string, unknown>);
    default:
      return compareScalars(firestoreScalar(a)!, firestoreScalar(b)!);
  }
}
