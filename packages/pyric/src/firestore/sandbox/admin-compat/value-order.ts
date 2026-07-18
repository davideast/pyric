/**
 * Canonical Firestore value comparator (FS-B3).
 *
 * Firestore orders heterogeneous field values by a fixed *type order*
 * first, then within a type. The old query comparator ignored this and
 * fell back to `String(a).localeCompare(String(b))`, which mis-ordered
 * everything that wasn't same-typed scalars and mishandled NaN. This
 * module mirrors `clones/firebase-js-sdk/packages/firestore/src/model/
 * type_order.ts` + `model/values.ts` (`valueCompare`) for the plain-JS
 * value shapes the sandbox stores.
 *
 * Type order (ascending):
 *   null < boolean < number < timestamp < string < bytes < reference
 *   < geopoint < array < map
 *
 * The sandbox stores values as plain JS rather than the wire `Value`
 * proto, so each type is detected structurally:
 *   - number: `typeof === 'number'` or `'bigint'` (NaN sorts smallest
 *     among numbers, matching `compareNumbers`).
 *   - timestamp: an object with numeric `seconds` + (`nanos` |
 *     `nanoseconds`) — covers both the rules `Timestamp` ({seconds,nanos})
 *     and the admin-compat `Timestamp` ({seconds,nanoseconds}).
 *   - bytes: an object with a `Uint8Array` `data` field (rules `Bytes`).
 *   - geopoint: an object with numeric `latitude` + `longitude`.
 *   - reference: an object with a string `path` (a doc ref) — but NOT a
 *     timestamp/geopoint/bytes (checked first).
 *   - array: `Array.isArray`.
 *   - map: any other plain object.
 */

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
  Map = 9,
}

interface TimestampLike {
  seconds: number;
  nanos?: number;
  nanoseconds?: number;
}

function isTimestampLike(v: Record<string, unknown>): boolean {
  return (
    typeof v.seconds === 'number' &&
    (typeof v.nanos === 'number' || typeof v.nanoseconds === 'number')
  );
}

function isGeoPointLike(v: Record<string, unknown>): boolean {
  return typeof v.latitude === 'number' && typeof v.longitude === 'number';
}

function isBytesLike(v: Record<string, unknown>): boolean {
  return v.data instanceof Uint8Array;
}

function isReferenceLike(v: Record<string, unknown>): boolean {
  return typeof v.path === 'string';
}

/** Rank a value into the canonical Firestore type order. */
export function typeOrderRank(v: unknown): TypeRank {
  if (v === null || v === undefined) return TypeRank.Null;
  const t = typeof v;
  if (t === 'boolean') return TypeRank.Boolean;
  if (t === 'number' || t === 'bigint') return TypeRank.Number;
  if (t === 'string') return TypeRank.String;
  if (Array.isArray(v)) return TypeRank.Array;
  if (t === 'object') {
    const o = v as Record<string, unknown>;
    if (isTimestampLike(o)) return TypeRank.Timestamp;
    if (isBytesLike(o)) return TypeRank.Bytes;
    if (isGeoPointLike(o)) return TypeRank.GeoPoint;
    if (isReferenceLike(o)) return TypeRank.Reference;
    return TypeRank.Map;
  }
  // Unknown (symbol/function) — treat as map-rank so it sorts last and
  // never throws. Should not occur for stored Firestore data.
  return TypeRank.Map;
}

function timestampMillisParts(v: TimestampLike): [number, number] {
  const nanos = typeof v.nanos === 'number' ? v.nanos : (v.nanoseconds ?? 0);
  return [v.seconds, nanos];
}

function compareNumbers(a: number, b: number): number {
  // NaN sorts as the smallest number (matches `compareNumbers` in
  // values.ts: NaN < any non-NaN, NaN === NaN).
  const aNaN = Number.isNaN(a);
  const bNaN = Number.isNaN(b);
  if (aNaN && bNaN) return 0;
  if (aNaN) return -1;
  if (bNaN) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStrings(a: string, b: string): number {
  // Firestore compares strings by UTF-8 byte order. For the BMP-only
  // corpus the sandbox exercises, JS's `<`/`>` (UTF-16 code-unit order)
  // agrees with UTF-8 byte order; surrogate-pair edge cases are an
  // accepted approximation (documented divergence).
  return a < b ? -1 : a > b ? 1 : 0;
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
    case TypeRank.Timestamp: {
      const [as, an] = timestampMillisParts(a as TimestampLike);
      const [bs, bn] = timestampMillisParts(b as TimestampLike);
      if (as !== bs) return as < bs ? -1 : 1;
      return an < bn ? -1 : an > bn ? 1 : 0;
    }
    case TypeRank.String:
      return compareStrings(a as string, b as string);
    case TypeRank.Bytes: {
      const ab = (a as { data: Uint8Array }).data;
      const bb = (b as { data: Uint8Array }).data;
      const n = Math.min(ab.length, bb.length);
      for (let i = 0; i < n; i++) {
        if (ab[i] !== bb[i]) return ab[i] < bb[i] ? -1 : 1;
      }
      return ab.length < bb.length ? -1 : ab.length > bb.length ? 1 : 0;
    }
    case TypeRank.Reference:
      return compareStrings(
        (a as { path: string }).path,
        (b as { path: string }).path,
      );
    case TypeRank.GeoPoint: {
      const ag = a as { latitude: number; longitude: number };
      const bg = b as { latitude: number; longitude: number };
      if (ag.latitude !== bg.latitude) return ag.latitude < bg.latitude ? -1 : 1;
      return ag.longitude < bg.longitude ? -1 : ag.longitude > bg.longitude ? 1 : 0;
    }
    case TypeRank.Array: {
      const aa = a as unknown[];
      const ba = b as unknown[];
      const n = Math.min(aa.length, ba.length);
      for (let i = 0; i < n; i++) {
        const cmp = compareValues(aa[i], ba[i]);
        if (cmp !== 0) return cmp;
      }
      return aa.length < ba.length ? -1 : aa.length > ba.length ? 1 : 0;
    }
    case TypeRank.Map: {
      // Maps compare by sorted key, then value, then length — matching
      // upstream `compareMaps`.
      const am = a as Record<string, unknown>;
      const bm = b as Record<string, unknown>;
      const aKeys = Object.keys(am).sort();
      const bKeys = Object.keys(bm).sort();
      const n = Math.min(aKeys.length, bKeys.length);
      for (let i = 0; i < n; i++) {
        if (aKeys[i] !== bKeys[i]) return aKeys[i] < bKeys[i] ? -1 : 1;
        const cmp = compareValues(am[aKeys[i]], bm[bKeys[i]]);
        if (cmp !== 0) return cmp;
      }
      return aKeys.length < bKeys.length ? -1 : aKeys.length > bKeys.length ? 1 : 0;
    }
    default:
      return 0;
  }
}
