/**
 * `pyric/sandbox/checkpoints` is the saved-state primitive's public surface.
 *
 * Re-exports only. The capture and restore live in `capture.ts`, the four
 * host-facing operations in `saved-states.ts`, the shapes and the backend seam
 * in `types.ts`, and the record-store backend in `record-backend.ts`. The
 * directory backend is published from its own subpath because it reads files.
 */
export { captureCheckpoint, countsOf, restoreCheckpoint } from './capture.js';
export { recordCheckpointBackend } from './record-backend.js';
export {
  checkpointNames,
  listCheckpoints,
  readCheckpoint,
  removeCheckpoint,
  restoreNamedCheckpoint,
  saveCheckpoint,
} from './saved-states.js';
export type { SavedCheckpoint } from './saved-states.js';
export {
  CHECKPOINT_FORMAT,
  CHECKPOINT_NAME_PATTERN,
  CheckpointNameError,
  assertCheckpointName,
  isCheckpointEnvelope,
} from './types.js';
export type {
  Checkpoint,
  CheckpointBackend,
  CheckpointCounts,
  CheckpointListing,
} from './types.js';
