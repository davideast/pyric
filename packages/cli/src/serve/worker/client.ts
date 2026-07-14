/**
 * Worker client SDK — mirrors `pyric/firestore` (+ `pyric/auth`, `pyric/storage`,
 * and the RTDB modular subset) for the SharedWorker data plane. App code can
 * swap its `pyric/firestore` import for this module (via an import-map) and have
 * every operation route to the single worker-hosted sandbox instead of an
 * in-page one — same function names, same argument shapes, same return types.
 *
 * This module is a re-export barrel over the per-family modules under `client/`:
 *   - `core`            transport singleton (RPC correlation, subscriber maps,
 *                       port wiring, the Studio auth-lens + op-issuer stamp)
 *   - `handles`         opaque port-carrying handle types + `Unsubscribe`
 *   - `snapshots`       firestore snapshot rehydration + snapshot types
 *   - `connection`      connect, worker version/instance, state/branches, relay
 *   - `firestore-refs`  ref / query / sentinel descriptor factories (no RPC)
 *   - `firestore-reads` read + aggregate execution + `onSnapshot`
 *   - `firestore-writes` writes + `writeBatch` + `runTransaction`
 *   - `rules`           Firestore/RTDB rules deploy + status
 *   - `admin-firestore` admin-lens document ops
 *   - `rtdb`            RTDB modular subset
 *   - `studio`          event stream, confirm-policy, sandbox snapshot
 *   - `auth`            per-port auth surface
 *   - `storage`         worker-backed storage mirror
 *   - `messaging`       token lifecycle + foreground/background subscriptions
 *
 * The barrel is part of the worker's PUBLIC shape: `serve/worker/index.ts`
 * re-exports from here for the `@pyric/cli/serve/worker` package subpath.
 */

// Shared core: lens/issuer controls + the handle and snapshot types.
export { setLens, getLens, setOpIssuer } from './client/core.js';
export type {
  ClientDb,
  ClientRtdb,
  RtdbRefHandle,
  RtdbDataSnapshot,
  DocRefHandle,
  CollRefHandle,
  QueryHandle,
  AnyHandle,
  Unsubscribe,
} from './client/handles.js';
export type { ClientDocSnapshot, ClientQuerySnapshot } from './client/snapshots.js';

// API families. Each module exports only its public surface; internal helpers
// stay unexported, so `export *` re-exports exactly the published symbols.
export * from './client/connection.js';
export * from './client/firestore-refs.js';
export * from './client/firestore-reads.js';
export * from './client/firestore-writes.js';
export * from './client/rules.js';
export * from './client/admin-firestore.js';
export * from './client/rtdb.js';
export * from './client/studio.js';
export * from './client/presence.js';
export * from './client/auth.js';
export * from './client/storage.js';
export * from './client/ai.js';
