/**
 * Read-path value translation — internal field shapes → compat shapes.
 *
 * The simulator stores resolved typed values as the rules-internal
 * wrapper classes (`pyric/rules`): `Timestamp` with `(seconds, nanos)` and
 * evaluator hooks, `Bytes`, `LatLng`. Consumers reading a doc back expect
 * the compat / modular SDK shapes — a `Timestamp` with `(seconds,
 * nanoseconds)`, no evaluator internals. This module rewrites the read
 * tree so every read path (single-doc `getDoc`, query `getDocs`, AND the
 * `onSnapshot` listener path — FS-B10) returns the identical shape.
 *
 * It lives apart from `snapshots.ts` so the listener path
 * (`snapshot-listeners.ts`) can reuse it without importing the
 * `DocumentSnapshot` builders (which would pull the admin-compat query
 * surface into the listener module). The only dependencies here are
 * `pyric/rules` and the compat `Timestamp` value class.
 */
import {
  Timestamp as InternalTimestamp,
  Bytes as InternalBytes,
  LatLng as InternalLatLng,
} from 'pyric/rules/internal';
import { Timestamp as CompatTimestamp, type DocumentData } from './types.js';

function translateValue(value: unknown): unknown {
  if (value instanceof InternalTimestamp) {
    return new CompatTimestamp(value.seconds, value.nanos);
  }
  // Bytes + LatLng wrappers (rules-internal) ride through the read path
  // as their instance form. The `pyric/firestore` modular layer does
  // the final conversion to `firebase/firestore`'s `Bytes` / `GeoPoint`
  // for its consumers; the admin-compat read path here leaves them as
  // the wrapper so downstream layers can identify the type via
  // `instanceof` against `pyric/rules`. Without these
  // short-circuits, the generic object walk below would destructure the
  // class instance into a plain `{...}` and erase the type.
  if (value instanceof InternalBytes) return value;
  if (value instanceof InternalLatLng) return value;
  if (Array.isArray(value)) {
    return value.map(translateValue);
  }
  if (value && typeof value === 'object') {
    // Rebuild via `Object.fromEntries` (CreateDataProperty semantics) rather
    // than `out[k] = …`: a stored field literally named `__proto__` would,
    // through bare bracket assignment, invoke the prototype accessor and
    // pollute `Object.prototype` process-wide. `fromEntries` installs the
    // key as a plain own property instead, so `__proto__`/`constructor`/
    // `prototype` field names round-trip as data without touching the
    // shared prototype.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([k, v]) => [k, translateValue(v)] as const,
      ),
    );
  }
  return value;
}

/**
 * Translate the read-path data tree from internal field shapes to compat
 * field shapes. Currently handles Timestamp → CompatTimestamp; future
 * typed-value parity work hooks here too.
 */
export function translateReadData(data: DocumentData): DocumentData {
  return translateValue(data) as DocumentData;
}
