/**
 * Taking a checkpoint and putting one back.
 *
 * Both are one call onto the full-state seam, so a checkpoint holds exactly
 * what {@link captureFullState} reads and restoring one leaves the sandbox
 * exactly where {@link applyFullState} puts it. There is no second definition
 * of what "the whole sandbox" means, which is what keeps a checkpoint from
 * quietly dropping a service the sandbox grew.
 *
 * The counts are derived from the state rather than read from the services a
 * second time, so a listing can never disagree with the state beside it.
 */

import { applyFullState, captureFullState, type FullSandboxState } from '../full-state.js';
import type { LocalSandbox } from '../types/service.js';
import { CHECKPOINT_FORMAT, type Checkpoint, type CheckpointCounts } from './types.js';

/** True when a JSON value is a plain object with keys to count. */
function isCountableTree(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * How many top-level keys the Realtime Database tree holds. The state carries
 * the backend's persistence envelope, whose `data` key is the tree itself, so
 * the count is taken there rather than over the envelope's own keys.
 */
function databaseEntryCount(database: FullSandboxState['database']): number {
  if (!isCountableTree(database)) return 0;
  const tree = isCountableTree(database.data) ? database.data : database;
  return Object.keys(tree).length;
}

/** How much each service holds in one state. */
export function countsOf(state: FullSandboxState): CheckpointCounts {
  return {
    firestore: Object.keys(state.firestore).length,
    database: databaseEntryCount(state.database),
    storage: state.storage.length,
    auth: state.auth.users.length,
  };
}

/**
 * Read the whole sandbox into a checkpoint.
 *
 * A pure read: nothing in the sandbox changes, and two captures with no
 * intervening write are the same value apart from `at`.
 */
export async function captureCheckpoint(sandbox: LocalSandbox): Promise<Checkpoint> {
  const state = await captureFullState(sandbox);
  return { format: CHECKPOINT_FORMAT, at: Date.now(), counts: countsOf(state), state };
}

/**
 * Replace the whole sandbox with what a checkpoint holds.
 *
 * A total replace, not a merge: state the sandbox holds that the checkpoint
 * does not is gone when this returns.
 *
 * The operation log is reset first, and this is the difference between
 * restoring a checkpoint and promoting a branch. Both write a full state, but
 * a promotion continues the sandbox's history and a restore declares that the
 * history since the checkpoint did not happen. A cursor a reader holds from
 * before the restore names an event in a log that is gone, and the reset is
 * what lets the log say so rather than reading like a continuation.
 */
export async function restoreCheckpoint(
  sandbox: LocalSandbox,
  checkpoint: Checkpoint,
): Promise<void> {
  sandbox.reset();
  await applyFullState(sandbox, checkpoint.state);
}
