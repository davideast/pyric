/**
 * A database instance's whole tree, read for a host's own bookkeeping.
 *
 * A host that records its starting state (a repro log's base) reads every
 * instance's tree. Reading it through `get()` would record an RTDB read in
 * the sandbox's history and the page's activity, as if the app had made it;
 * this reads the backend's current state directly and records nothing.
 */
import type { JsonValue } from '../sandbox/data-tree.js';
import { targetOf } from '../routing.js';
import { buildSandboxRef } from '../references.js';
import { buildSandboxSnap } from '../snapshots.js';
import type { Database } from '../types.js';

/** The instance's root tree in `DataSnapshot.exportVal()` form (priorities kept), emitting no event. */
export function exportDatabaseVal(db: Database): JsonValue {
  const target = targetOf(db);
  const rootRef = buildSandboxRef(target, '/');
  return buildSandboxSnap(target, rootRef, target.backend.snapshotState()).exportVal();
}
