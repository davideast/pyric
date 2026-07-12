/**
 * `pyric/firestore` — modular Web-SDK Firestore adapter for the Pyric
 * sandbox.
 *
 * Mirrors `firebase/firestore`'s tree-shakable free-function shape
 * (`getDoc`, `setDoc`, `addDoc`, `query`, `where`, `orderBy`, `limit`,
 * `onSnapshot`, `runTransaction`, …). Every operation routes to one of two
 * backends picked at init time: a no-network sandbox target (wrapping
 * `pyric-admin`'s chainable adapter over `pyric/sandbox`) or a prod target
 * (wrapping `firebase/firestore` against a real project). Same call surface
 * across both, so agent code written against the sandbox runs unmodified
 * against prod.
 *
 * This module is a re-export barrel over the per-family modules in this
 * directory — it holds no implementation. The families mirror the
 * symmetric `@pyric/cli` worker client split:
 *   - `state`             the TARGET_SYMBOL brand + routing/converter
 *                         WeakMaps + tag/resolve helpers + value finalizers
 *   - `types`             public handle / reference / query / snapshot /
 *                         converter / batch / transaction types
 *   - `snapshots`         sandbox snapshot rehydration (reads + listeners)
 *   - `instances`         getFirestore / getAdminFirestore / actingAs +
 *                         emulator connect
 *   - `equality`          refEqual / queryEqual / snapshotEqual
 *   - `persistence`       offline / persistence / network + cache-init +
 *                         get-from-server/cache + logLevel + snapshots-sync
 *   - `refs`              doc / collection / collectionGroup / withConverter
 *   - `reads`             getDoc / getDocs
 *   - `writes`            setDoc / updateDoc / deleteDoc / addDoc
 *   - `query-constraints` query + where/or/and/orderBy/limit + cursors
 *   - `aggregates`        count / sum / average + getCount/AggregateFromServer
 *   - `listeners`         onSnapshot
 *   - `transactions`      runTransaction / writeBatch
 *   - `field-values`      sentinels + scalar type re-exports
 *   - `sandbox-ops`       the sandbox-only `sandbox` lifecycle object
 *   - `tools`             tool factories
 *
 * The barrel IS the published `pyric/firestore` subpath surface. Each family
 * module exports only its public symbols, so `export *` re-exports exactly
 * the published set; `state`'s package-internal helpers stay off the surface
 * (only its `TARGET_SYMBOL` brand is re-exported).
 */

export { TARGET_SYMBOL } from './state.js';
export * from './types.js';
export * from './instances.js';
export * from './equality.js';
export * from './persistence.js';
export * from './refs.js';
export * from './reads.js';
export * from './writes.js';
export * from './query-constraints.js';
export * from './aggregates.js';
export * from './listeners.js';
export * from './transactions.js';
export * from './field-values.js';
export * from './sandbox-ops.js';

// ─── Tool factories (Slice 10) ────────────────────────────────────────
export { createFirestoreDataTools, createFirestoreInspectTools } from './tools.js';
export type { FirestoreDataToolDeps, UserAuth, As } from './tools.js';
