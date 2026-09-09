/**
 * What a checkpoint is, and what a place to keep one has to do.
 *
 * A checkpoint is a named {@link FullSandboxState} with the counts a listing
 * reports beside it. The state is the whole sandbox, so restoring a checkpoint
 * puts every service back to the instant it was taken: Firestore documents,
 * the Realtime Database tree, Storage objects with their bytes and metadata,
 * auth accounts, and the three rule sources.
 *
 * {@link CheckpointBackend} is the seam between the checkpoint and where it is
 * kept. The Node process keeps checkpoints as files under the project
 * directory; a page keeps them as records in its own IndexedDB. Both answer
 * the same four questions, so the capture, restore, listing, and naming rules
 * are written once and neither host reimplements them.
 */

import type { FullSandboxState } from '../full-state.js';

/** The tag every checkpoint carries, so an unrelated record is not read as one. */
export const CHECKPOINT_FORMAT = 'pyric-checkpoint-v1';

/**
 * The names a checkpoint may take. One filename segment and one record id, so
 * a name can never reach outside the place its backend keeps checkpoints.
 */
export const CHECKPOINT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A checkpoint name a backend refuses. Thrown rather than returned: it is a caller mistake. */
export class CheckpointNameError extends Error {
  constructor(name: string) {
    super(
      `'${name}' is not a checkpoint name. A checkpoint name is 1 to 64 characters of letters, digits, dash, or underscore.`,
    );
    this.name = 'CheckpointNameError';
  }
}

/** How much each service held when the checkpoint was taken. */
export interface CheckpointCounts {
  /** Firestore documents. */
  firestore: number;
  /** Top-level keys of the Realtime Database tree. */
  database: number;
  /** Storage objects. */
  storage: number;
  /** Auth accounts. */
  auth: number;
}

/** One checkpoint: the whole sandbox at an instant, with the counts over it. */
export interface Checkpoint {
  format: typeof CHECKPOINT_FORMAT;
  /** When the checkpoint was taken, in milliseconds since the epoch. */
  at: number;
  /** How much each service held. Read by a listing so it needs no state. */
  counts: CheckpointCounts;
  /** The whole sandbox, as one plain JSON value. */
  state: FullSandboxState;
}

/** One entry of a checkpoint listing: the name plus what a caller reads without loading state. */
export interface CheckpointListing {
  name: string;
  at: number;
  counts: CheckpointCounts;
}

/**
 * Where checkpoints are kept.
 *
 * A backend stores and returns whole {@link Checkpoint} values and decides
 * nothing about them. It rejects a name that does not match
 * {@link CHECKPOINT_NAME_PATTERN} by throwing {@link CheckpointNameError},
 * because a name that could reach outside its keeping place is a caller
 * mistake rather than a missing checkpoint.
 */
export interface CheckpointBackend {
  /** Write one checkpoint under `name`, replacing whatever that name held. */
  write(name: string, checkpoint: Checkpoint): Promise<void>;
  /** The checkpoint stored under `name`, or null when the backend holds none. */
  read(name: string): Promise<Checkpoint | null>;
  /** Every checkpoint the backend holds, ordered by name. */
  list(): Promise<CheckpointListing[]>;
  /** Remove one checkpoint. Reports whether there was one to remove. */
  remove(name: string): Promise<boolean>;
}

/** Reject a name that is not one segment of a backend's keyspace. */
export function assertCheckpointName(name: string): void {
  if (!CHECKPOINT_NAME_PATTERN.test(name)) throw new CheckpointNameError(name);
}
