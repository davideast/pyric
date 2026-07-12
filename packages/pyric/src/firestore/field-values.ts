/**
 * `pyric/firestore` — field-value sentinels + scalar type re-exports.
 *
 * The `serverTimestamp` / `increment` / `arrayUnion` / `arrayRemove` /
 * `deleteField` sentinels (riding `pyric-admin`'s FieldValue), the
 * `FieldValue` / `Timestamp` classes, and the `firebase/firestore` scalar
 * types (`Bytes`, `GeoPoint`, `documentId`, `FieldPath`, `vector`,
 * `VectorValue`) that both targets share.
 */
import {
  FieldValue as ChainFieldValue,
  Timestamp as ChainTimestamp,
  type FieldValueSentinel,
} from 'pyric/sandbox/admin-firestore';

// ─── Tier 1: scalar types + sentinels re-exported from firebase ──────
//
// These types are class shapes (or sentinels) the `firebase/firestore`
// modular SDK exposes. They're shared across both targets in the
// sense that:
//
//   - **Prod target** uses them natively (round-trips through the
//     wire encoder, server stores them as proper Firestore values).
//   - **Sandbox target** rides `Bytes`, `GeoPoint`, and `VectorValue`
//     through their converters at `sandbox/firestore/converters/` on
//     write, then finalizes the read back to `fb.Bytes` / `fb.GeoPoint`
//     / `fb.VectorValue` in {@link finalizeSandboxValue} so consumer
//     code's `instanceof` checks match prod. `vector()` / `VectorValue`
//     are re-exported from `firebase/firestore` like the others.
//
// `documentId()` and `FieldPath` ARE supported on both sides today —
// `documentId()` returns a `FieldPath` sentinel that the chainable
// adapter recognizes as "by document id" when passed to `where()`.

export {
  Bytes,
  GeoPoint,
  documentId,
  FieldPath,
  vector,
  VectorValue,
} from 'firebase/firestore';

// ─── Sentinels + scalar types ─────────────────────────────────────────
//
// Sentinels in pyric ride on `pyric-admin`'s sentinel objects, which
// are structurally identical to `firebase/firestore`'s — the simulator
// recognizes them by `__type` discriminator, and so does production
// Firestore (their wire format normalizes through the same path). One
// `FieldValue.increment(1)` works in both targets.
//
// `Timestamp` is similar — admin-shape `{seconds, nanoseconds}` matches
// the modular SDK's `Timestamp` shape.

export { ChainFieldValue as FieldValue, ChainTimestamp as Timestamp };

export function serverTimestamp(): FieldValueSentinel {
  return ChainFieldValue.serverTimestamp();
}
export function increment(n: number): FieldValueSentinel {
  return ChainFieldValue.increment(n);
}
export function arrayUnion(...values: unknown[]): FieldValueSentinel {
  return ChainFieldValue.arrayUnion(...values);
}
export function arrayRemove(...values: unknown[]): FieldValueSentinel {
  return ChainFieldValue.arrayRemove(...values);
}
export function deleteField(): FieldValueSentinel {
  return ChainFieldValue.delete();
}
