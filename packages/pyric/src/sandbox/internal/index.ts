/**
 * `@pyric/sandbox/internal` — adapter-only protocol surface.
 *
 * Service adapter packages (`@pyric/admin`, future `@pyric/firestore`,
 * `@pyric/auth`, etc.) consume this subpath to reach the underlying
 * `LocalEnvironment` and any other primitives that need to flow
 * through the sandbox boundary.
 *
 * **Not part of the public API.** The shape is subject to change
 * without breaking-change semantics across `@pyric/sandbox` versions.
 * External adapter authors shouldn't rely on this — when the protocol
 * stabilizes (post-multi-service architecture) it'll be promoted.
 *
 * Documented in the design rationale §"Migration
 * scope summary".
 */
export { getInternalEnv } from './sandbox-impl.js';

// Pyric Studio event-unification seam: the provenance-stamping emit
// choke-point non-Firestore services (auth/storage/rtdb) call to land
// activity on the unified `onEvent`/`history()` stream. Firestore rides
// the env→sandbox fan-out and doesn't need this. `stampProvenance` is
// exported for callers that need to compute the stamped shape without
// dispatching (e.g. branch/replay tooling). See the design rationale.
// `makeServiceMutationEvent` builds the generic cross-service mutation
// envelope (id/at minted from the shared counter) auth/storage/rtdb emit.
export {
  emitSandboxEvent,
  stampProvenance,
  makeServiceMutationEvent,
} from './sandbox-impl.js';

// LocalEnvironment + its closest siblings moved here in Slice 7.
// Surfacing them through the /internal sub-path keeps the public
// surface narrow (consumers compose via `getFirestore(ctx)`, not by
// constructing LocalEnvironment directly) while letting adapter
// packages reach the runtime.
//
// Star re-exports because admin-compat (in sdk) reaches in for a
// long tail of helper symbols (DELETE_MARKER, KEEP,
// FIRESTORE_ERROR_CODES, etc.). Anyone changing the moved files'
// public exports automatically gets them propagated here.
// local-environment exports BatchResult as its own outer shape;
// local-state has a different (internal) BatchResult — alias the
// local-state one to disambiguate. Same trick for DocumentData
// (one canonical export from local-state; local-environment
// re-exports it).
export * from '../firestore/local-environment.js';
export {
  LocalState,
  type BatchOperation,
  type BatchResult as LocalStateBatchResult,
  type CreateResult,
  type UpdateResult,
  type SetResult,
  type DeleteResult,
} from '../firestore/local-state.js';
export * from '../firestore/event-log.js';
export * from '../firestore/auto-id.js';
export * from '../firestore/transaction.js';
export * from '../firestore/transaction-merge.js';
export * from '../firestore/transaction-types.js';
export * from '../firestore/errors.js';
export * from '../firestore/value-resolver.js';
export * from '../firestore/converters/timestamp.js';
export * from '../firestore/converters/user-timestamp.js';
export * from '../firestore/converters/reference.js';
export * from '../firestore/converters/vector.js';
export * from '../firestore/converters/fieldvalue.js';
export * from '../firestore/converters/bytes-geopoint.js';
export * from '../firestore/snapshot-listeners.js';
// Wire-encoder: produces Firestore JSON wire-format from sandbox
// values. Used by the discover crawler's sandbox adapter (in
// @pyric/firestore/discover) to bridge LocalEnvironment ↔ the wire
// decoder.
export * from '../firestore/wire-encoder.js';

// Pre-mortem H3 — the star re-exports above are NOT auditable by
// reading this file. If two of the re-exported modules introduce a
// same-named symbol, `tsc --noEmit` fails loudly at build time (this
// has happened: BatchResult / DocumentData collisions, both
// disambiguated above). When adding a new symbol to any of the
// listed modules, check for collisions against the other modules in
// this list first. Future-us should consider replacing the stars
// with explicit named re-exports once the admin-compat layer's
// surface stops drifting.
