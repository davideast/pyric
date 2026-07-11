/**
 * `@pyric/rtdb` — Firebase Realtime Database toolkit. Public surface:
 *
 *   - `RtdbHost` + `fetchDatabase` — the host contract
 *   - `getRtdbTools(host)` — programmatic API (used by direct consumers)
 *   - `createRtdbAdminTools({ host })` — the agent-tool factory
 *     (consumed by `composeMcpRegistry`)
 *   - data shapes: `RtdbIR`, `RtdbNode`, `RtdbTools`, `UserAuth`, …
 *   - the constraint authoring surface (`atoms`, `policies`,
 *     `compose`, `ruleset`)
 */
export * from './types.js';
export type { RtdbHost } from './host.js';
export { fetchDatabase } from './host.js';
export { getRtdbTools } from './resolver.js';
export {
  createRtdbAdminTools,
  createRtdbDataTools,
  createRtdbRulesTools,
} from './tools.js';
export type {
  RtdbAdminToolDeps,
  RtdbDataToolDeps,
  RtdbRulesToolDeps,
} from './tools.js';
export * from './mapper.js';
export { GenerateIRInputSchema, RtdbIRErrorCode } from './ir/spec.js';
export type { GenerateIRInput, GenerateIRSpec } from './ir/spec.js';
export { SimulationInputSchema, SimulateErrorCode, SimulationResultSchema } from './simulation/spec.js';
export { ValidatedWriteInputSchema } from './data/spec.js';
export type { ValidatedWriteInput, ValidatedWriteResult } from './data/spec.js';
// Internal handler exports — exposed for direct-handler integration
// tests; not part of the stable public API.
export { DataHandler } from './data/handler.js';
export { GenerateIRHandler } from './ir/handler.js';
export { WriteRulesHandler } from './write/handler.js';
export { CrawlStructureHandler } from './crawl/handler.js';
export { SimulateHandler } from './simulation/handler.js';
export type { SimulationInput, SimulationResult, SimulateResult } from './simulation/spec.js';
export { WriteRulesErrorCode } from './write/spec.js';
export type { WriteRulesResult, WriteRulesSpec } from './write/spec.js';
export { CrawlErrorCode, CRAWL_DEFAULTS } from './crawl/spec.js';
export type { CrawlOptions, CrawlStructureResult, CrawlStructureSpec, StructureNode } from './crawl/spec.js';

// ─── Modular SDK surface (Phase 3) ──────────────────────────────────
//
// Sandbox-aware re-implementation of `firebase/database`'s tree-shakable
// free-function shape: `getDatabase`, `ref`, `child`, `get`, `set`,
// `update`, `remove`, `push`, `onValue`, `off`, `serverTimestamp`,
// `connectDatabaseEmulator`, plus the `sandbox` lifecycle namespace.
//
// Lives under `./modular.js` so the existing agent-tool surface
// (`createRtdbAdminTools`, IR, simulator, mapper, DataHandler) stays
// in this file's existing exports and the modular surface is an
// ADDITIVE re-export.
export {
  getDatabase,
  getAdminDatabase,
  ref,
  child,
  get,
  set,
  update,
  remove,
  push,
  pushKey,
  onValue,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onChildMoved,
  off,
  runTransaction,
  serverTimestamp,
  increment,
  connectDatabaseEmulator,
  goOffline,
  goOnline,
  forceLongPolling,
  forceWebSockets,
  enableLogging,
  refFromURL,
  sandbox,
  TARGET_SYMBOL,
  // Query builder + constraint factories (Tier 3)
  query,
  orderByChild,
  orderByKey,
  orderByValue,
  startAt,
  startAfter,
  endAt,
  endBefore,
  equalTo,
  limitToFirst,
  limitToLast,
  QUERY_SYMBOL,
} from './modular.js';
export type {
  Database,
  DatabaseReference,
  DataSnapshot,
  TransactionResult,
  ThenableReference,
  Unsubscribe,
  Query,
  QueryConstraint,
} from './modular.js';

// Build an `RtdbHost` from an `AgentAppLike`-shaped object. Used by
// composeMcpRegistry. Structural typing, no app-package dependency.
export { initializeDatabaseApp } from './initialize-from-app.js';
export type { AgentAppLike } from './initialize-from-app.js';
export { replay } from './replay.js';
export type {
  RtdbReplayDivergence,
  RtdbReplayOptions,
  RtdbReplayResult,
} from './replay.js';
