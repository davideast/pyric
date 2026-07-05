/**
 * Snapshot adapter — single source of truth for `DocumentSnapshot`
 * shape across `doc-ref.ts` (single-doc reads), `query.ts` (collection
 * scan results), and `transaction.ts` (slice-4 single-doc tx reads).
 *
 * The Admin SDK contract:
 *   `snap.exists === true`   → `snap.data()` returns `DocumentData`
 *   `snap.exists === false`  → `snap.data()` returns `undefined`
 *
 * The wrapper passes `data === undefined` to mean "not exists" and a
 * concrete `DocumentData` to mean "exists". Centralizing the shape
 * here keeps the `null` / `undefined` ternary out of the call sites.
 *
 * ─── Timestamp shape translation ────────────────────────────────────
 *
 * The simulator stores resolved Timestamps as `wrappers/timestamp.ts`
 * `Timestamp` instances — `(seconds, nanos)` field shape, carrying
 * rules-evaluator hooks (binaryOp, callMethod). The Admin SDK exposes
 * `Timestamp` with `(seconds, nanoseconds)` field shape (no evaluator
 * hooks).
 *
 * Without translation, agent code reading a `serverTimestamp`-resolved
 * field via `(await ref.get()).data().createdAt.nanoseconds` would get
 * `undefined` — the field is named `nanos` in the simulator's class.
 * Translate on the read path so the value the user sees matches what
 * a real Admin SDK call would return.
 *
 * Translation is shape-agnostic: walks the data tree, replaces any
 * internal `Timestamp` instance with a compat-shaped `Timestamp`,
 * recurses into arrays + plain objects. Keeps the rest of the value
 * tree unchanged (numbers, strings, booleans, nulls — and any user-
 * stored plain `{ seconds, nanos }` object that is *not* the internal
 * Timestamp class, which we leave alone via the `instanceof` check).
 */

import {
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
} from './types.js';
// The read-path value translation (Timestamp → compat, Bytes/LatLng
// pass-through) lives in its own module so the `onSnapshot` listener path
// can share it without pulling the snapshot builders in (FS-B10).
import { translateReadData } from './read-translation.js';

export { translateReadData };

export function makeDocSnapshot(
  ref: DocumentReference,
  data: DocumentData | undefined,
): DocumentSnapshot {
  const exists = data !== undefined;
  const translated = exists ? translateReadData(data) : undefined;
  return {
    id: ref.id,
    ref,
    exists,
    data: () => (exists ? translated : undefined),
  };
}
