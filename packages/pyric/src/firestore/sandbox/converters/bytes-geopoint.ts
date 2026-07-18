/**
 * Bytes + GeoPoint write-boundary converters.
 *
 * Wraps `firebase/firestore` `Bytes` and `GeoPoint` instances into our
 * {@link Bytes} / {@link LatLng} wrappers at the write boundary.
 *
 * Without these converters, a `Bytes` / `GeoPoint` instance passed via
 * `setDoc({ b: Bytes.fromBase64String(...), g: new GeoPoint(...) })`
 * would land in `LocalState` as the `firebase/firestore` class instance.
 * Two problems with that:
 *
 *   1. Rules evaluator detects these types via `instanceof
 *      `pyric/rules`.Bytes` / `instanceof LatLng` — a
 *      `fb.Bytes` instance fails both checks, so `data.b is bytes`
 *      returns false.
 *   2. The admin-compat read-path walker in `snapshots.ts` walks any
 *      `typeof === 'object'` value via `Object.entries`, which on a
 *      `fb.Bytes` instance enumerates private fields like `_byteString`
 *      and emits a plain object. Round-trip is lost — consumer code
 *      that wrote a `Bytes` reads back `{ _byteString: '...' }` instead
 *      of a `Bytes` instance.
 *
 * Detection strategy — duck typing on the firebase/firestore SDK shape:
 *
 *   `Bytes`:
 *     - method `toBase64()` returning string
 *     - method `toUint8Array()` returning Uint8Array
 *     - method `isEqual` (function)
 *
 *   `GeoPoint`:
 *     - `latitude` and `longitude` getters returning number
 *     - method `isEqual` (function)
 *
 * We deliberately don't `instanceof fb.Bytes` / `instanceof fb.GeoPoint`
 * because:
 *   1. The simulator package shouldn't take a hard dependency on
 *      `firebase/firestore` (it's a consumer concern), and
 *   2. Multiple `firebase` copies in a workspace would defeat
 *      `instanceof`.
 *
 * Idempotency: each converter rejects its own output (our
 * `pyric/rules` wrapper) by `instanceof` check, so a second
 * resolver pass is a no-op.
 */
import { KEEP, type ValueConverter } from '../value-resolver.js';
import { Bytes as RulesBytes, LatLng } from 'pyric/rules/internal';

/** Minimal duck-type for `firebase/firestore` `Bytes`. */
interface FbBytesLike {
  toBase64(): string;
  toUint8Array(): Uint8Array;
  isEqual(other: unknown): boolean;
}

function isFbBytes(v: unknown): v is FbBytesLike {
  if (v === null || typeof v !== 'object') return false;
  // Must NOT be our own wrapper — already converted.
  if (v instanceof RulesBytes) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.toBase64 === 'function' &&
    typeof o.toUint8Array === 'function' &&
    typeof o.isEqual === 'function'
  );
}

/** Minimal duck-type for `firebase/firestore` `GeoPoint`. */
interface FbGeoPointLike {
  readonly latitude: number;
  readonly longitude: number;
  isEqual(other: unknown): boolean;
}

function isFbGeoPoint(v: unknown): v is FbGeoPointLike {
  if (v === null || typeof v !== 'object') return false;
  // Must NOT be our own wrapper — already converted.
  if (v instanceof LatLng) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.latitude === 'number' &&
    typeof o.longitude === 'number' &&
    typeof o.isEqual === 'function'
  );
}

export const bytesConverter: ValueConverter = {
  name: 'fb-bytes-to-rules-bytes',
  convert(value) {
    if (!isFbBytes(value)) return KEEP;
    return new RulesBytes(value.toUint8Array());
  },
};

export const geoPointConverter: ValueConverter = {
  name: 'fb-geopoint-to-rules-latlng',
  convert(value) {
    if (!isFbGeoPoint(value)) return KEEP;
    return new LatLng(value.latitude, value.longitude);
  },
};
