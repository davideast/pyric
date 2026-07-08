import { Timestamp, GeoPoint, Bytes } from 'pyric/firestore';

/**
 * The set of value types `@pyric/ui` knows how to display + edit.
 * Maps 1:1 to Firestore's serializable value shapes; consumers can
 * extend the registry but the built-in editors cover these.
 */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'timestamp'
  | 'geopoint'
  | 'reference'
  | 'bytes'
  | 'map'
  | 'array'
  | 'vector';

/**
 * Runtime-classify a value into one of the {@link FieldType}s.
 *
 * The discrimination order matters:
 *   - `null` checked before `typeof === 'object'` (null is an object)
 *   - vector (a typed embedding wrapper) checked before `Array.isArray`
 *     and before generic objects — its wire-sentinel shape is a plain
 *     object, and a bare `number[]` must stay `array`, not `vector`
 *   - `Array.isArray` checked before generic objects
 *   - Firestore special types (Timestamp/GeoPoint/Bytes/DocumentRef)
 *     checked before falling through to `map`
 *
 * `undefined` values aren't legal Firestore field values; we coerce
 * them to `'null'` rather than throw — the caller can decide whether
 * to display or filter.
 */
export function inferType(value: unknown): FieldType {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';

  // Vector (embedding) before array + map: a vector arrives as one of
  // several typed shapes (see {@link asVectorView}), one of which is a
  // plain `{__type__:'__vector__', value}` object. A bare numeric array
  // is deliberately NOT a vector — only the typed VectorValue / wrapper
  // / sentinel shapes classify here, so ordinary `number[]` data stays
  // `array`.
  if (typeof value === 'object' && asVectorView(value) !== null) return 'vector';

  if (Array.isArray(value)) return 'array';

  // Firestore SDK value types — these are class instances at runtime.
  // `instanceof` works against the same import pyric/firestore
  // re-exports (Bytes / GeoPoint from firebase/firestore directly;
  // Timestamp from either backend's compatible class).
  if (value instanceof Timestamp) return 'timestamp';
  if (value instanceof GeoPoint) return 'geopoint';
  if (value instanceof Bytes) return 'bytes';

  // Serialized Timestamp / GeoPoint: crossing a worker / postMessage boundary
  // strips the class, leaving plain `{ seconds, nanoseconds }` /
  // `{ latitude, longitude }`. Detect them structurally (same rationale as
  // references below) rather than rendering them as maps of internal fields.
  if (typeof value === 'object' && isTimestampShape(value)) return 'timestamp';
  if (typeof value === 'object' && isGeoPointShape(value)) return 'geopoint';

  // DocumentReference has no shared class identity across the two
  // backends (sandbox-chainable vs. firebase/firestore). Use a
  // structural check on the brand-bearing fields. Any object that
  // looks reference-shaped (path + firestore handle + id) is
  // classified as a reference; the alternative is rendering it as
  // a map of those three fields, which is strictly worse.
  if (typeof value === 'object' && isDocumentReferenceShape(value)) {
    return 'reference';
  }

  if (typeof value === 'object') return 'map';

  // Unreachable for Firestore-shaped data, but TS wants exhaustivity.
  return 'null';
}

/**
 * A serialized Timestamp: exactly `{ seconds, nanoseconds }` (or the firebase
 * `{ _seconds, _nanoseconds }` variant), both numbers, no other keys. The
 * "exactly two keys" guard keeps a genuine map that merely contains those
 * fields from being misclassified.
 */
export function isTimestampShape(v: object): boolean {
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2) return false;
  return (
    (typeof obj.seconds === 'number' && typeof obj.nanoseconds === 'number') ||
    (typeof obj._seconds === 'number' && typeof obj._nanoseconds === 'number')
  );
}

/** A serialized GeoPoint: exactly `{ latitude, longitude }`, both numbers. The
 *  GeoPoint display reads `.latitude` / `.longitude`, so the plain shape renders
 *  unchanged. */
export function isGeoPointShape(v: object): boolean {
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  return keys.length === 2 && typeof obj.latitude === 'number' && typeof obj.longitude === 'number';
}

function isDocumentReferenceShape(v: object): boolean {
  const obj = v as Record<string, unknown>;
  if (typeof obj.path !== 'string' || typeof obj.id !== 'string') return false;
  // The Web SDK ref exposes a `.firestore` handle; the chainable
  // (sandbox) ref exposes `.env` instead. Either signals "this is a
  // ref, not a plain map that happens to have `path` + `id` fields."
  // Also accept `.type === 'document'` which both backends set on
  // their ref class instances.
  const hasFirestore = typeof obj.firestore === 'object' && obj.firestore !== null;
  const hasEnv = typeof obj.env === 'object' && obj.env !== null;
  const hasDocBrand = obj.type === 'document';
  return hasFirestore || hasEnv || hasDocBrand;
}

/**
 * Normalized read-side view of a Firestore vector (embedding) value.
 * Editors and the renderer work against this rather than the raw shape
 * so they don't have to care which backend produced the value.
 */
export interface VectorView {
  /** The embedding components. Defensive copy — safe to read freely. */
  readonly values: number[];
  /** Number of components. Equivalent to `values.length`; surfaced
   *  separately because that's what the UI labels (`vector · <dims>`). */
  readonly dimension: number;
}

/**
 * Detect + normalize a Firestore vector value, or return `null` if the
 * value isn't a vector. Vectors reach `@pyric/ui` in several runtime
 * shapes depending on the backend the snapshot came from — there is no
 * single `VectorValue` class `pyric/firestore` re-exports, so we match
 * structurally (the same strategy {@link isDocumentReferenceShape} uses
 * for refs):
 *
 *   1. **pyric `Vector` wrapper** — frozen `.value: number[]` array plus
 *      a `.dimension` getter (sandbox / rules-side reads).
 *   2. **firebase/firestore (web) `VectorValue`** — exposes `.toArray()`
 *      and nothing else publicly.
 *   3. **firebase-admin `VectorValue`** — internal `._values: number[]`
 *      (also a `.toArray()`).
 *   4. **wire sentinel** — `{ __type__: '__vector__', value: number[] }`,
 *      the plain-object encoded form a discover crawler / seed emits.
 *
 * A bare `number[]` is intentionally NOT a vector — those stay `array`.
 * Only the typed/branded shapes above match.
 */
export function asVectorView(value: unknown): VectorView | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  // (1) pyric Vector wrapper: branded by `typeName === 'vector'` with a
  // numeric `.value` array. `.dimension` is a getter on the class.
  if (obj.typeName === 'vector' && isNumberArray(obj.value)) {
    return freezeView(obj.value as number[]);
  }

  // (4) wire sentinel: `{ __type__: '__vector__', value: number[] }`.
  if (obj.__type__ === '__vector__' && isNumberArray(obj.value)) {
    return freezeView(obj.value as number[]);
  }

  // (3) firebase-admin VectorValue: internal `_values` array.
  if (isNumberArray(obj._values)) {
    return freezeView(obj._values as number[]);
  }

  // (2) firebase/firestore (web) VectorValue: only a `.toArray()`. Guard
  // the call so a plain object with an unrelated `toArray` can't throw —
  // a non-numeric result fails the `isNumberArray` gate below.
  if (typeof obj.toArray === 'function') {
    try {
      const arr = (obj.toArray as () => unknown)();
      if (isNumberArray(arr)) return freezeView(arr as number[]);
    } catch {
      // Not a vector — fall through.
    }
  }

  return null;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number');
}

function freezeView(values: number[]): VectorView {
  const copy = values.slice();
  return { values: copy, dimension: copy.length };
}

/** How many leading components to show in a truncated vector preview. */
const VECTOR_PREVIEW_COUNT = 4;

/** Compact, display-safe rendering of a vector: `vector · <dim> [a, b, c, …]`.
 *  So a real embedding never dumps its full array into a diff, a rules trace, or
 *  a debugger panel. */
export function vectorPreview(view: VectorView): string {
  const head = view.values.slice(0, VECTOR_PREVIEW_COUNT).join(', ');
  const tail = view.values.length > VECTOR_PREVIEW_COUNT ? ', …' : '';
  return `vector · ${view.dimension} [${head}${tail}]`;
}

/** Deep-replace any vector-shaped value with a compact preview STRING, so the
 *  result can be `JSON.stringify`'d / formatted without dumping full embeddings.
 *  Recurses plain objects + arrays; class instances (Timestamp/GeoPoint) and
 *  scalars pass through untouched. Vector instances/sentinels are caught first. */
export function truncateVectorsForDisplay(value: unknown): unknown {
  const view = asVectorView(value);
  if (view) return vectorPreview(view);
  if (Array.isArray(value)) return value.map(truncateVectorsForDisplay);
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = truncateVectorsForDisplay(v);
      }
      return out;
    }
  }
  return value;
}
