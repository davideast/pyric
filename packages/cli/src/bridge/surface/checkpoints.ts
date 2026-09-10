/**
 * The project's checkpoints: named saved states of the whole sandbox.
 *
 * What a checkpoint is, what it holds, and how it is written and read back is
 * decided once, in `pyric/sandbox/checkpoints`, over the same full-state seam
 * a branch forks from and promotes onto. This module is the serve process's
 * end of that: it names the backend, which for a project is the directory
 * `.pyric/state/checkpoints`, and hands the module's own operations to the
 * `sandbox` tool's methods. It decides nothing about a checkpoint itself, so a
 * checkpoint a page saves and a checkpoint the CLI saves are the same value.
 */
import {
  checkpointNames as namesOf,
  listCheckpoints as listOf,
  readCheckpoint as readOf,
  removeCheckpoint as removeOf,
  restoreNamedCheckpoint as restoreOf,
  saveCheckpoint as saveOf,
  type Checkpoint,
  type CheckpointCounts,
  type CheckpointListing,
  type SavedCheckpoint,
} from 'pyric/sandbox/checkpoints';
import { directoryCheckpointBackend } from 'pyric/sandbox/checkpoints/directory';
import type { LocalSandbox } from 'pyric/sandbox';

export { CHECKPOINT_NAME_PATTERN } from 'pyric/sandbox/checkpoints';
export type { Checkpoint, CheckpointCounts, CheckpointListing };

/** Where one project keeps its checkpoints. */
function backendFor(projectDir: string) {
  return directoryCheckpointBackend(projectDir);
}

/** Capture the sandbox under `name`, replacing whatever that name held. */
export function writeCheckpoint(
  sandbox: LocalSandbox,
  projectDir: string,
  name: string,
): Promise<SavedCheckpoint> {
  return saveOf(backendFor(projectDir), name, sandbox);
}

/** The checkpoint saved under `name`, or null when the project holds none. */
export function readCheckpoint(projectDir: string, name: string): Promise<Checkpoint | null> {
  return readOf(backendFor(projectDir), name);
}

/** Every checkpoint name the project holds, ordered. */
export function checkpointNames(projectDir: string): Promise<string[]> {
  return namesOf(backendFor(projectDir));
}

/** Every checkpoint the project holds, with its save time and counts. */
export function listProjectCheckpoints(projectDir: string): Promise<CheckpointListing[]> {
  return listOf(backendFor(projectDir));
}

/**
 * Replace the sandbox with the checkpoint saved under `name`, and report which
 * one was restored. Resolves null when the project holds no such checkpoint,
 * and the sandbox is left exactly as it was.
 */
export function restoreCheckpoint(
  sandbox: LocalSandbox,
  projectDir: string,
  name: string,
): Promise<Checkpoint | null> {
  return restoreOf(backendFor(projectDir), name, sandbox);
}

/** Remove one checkpoint. Reports whether there was one to remove. */
export function removeCheckpoint(projectDir: string, name: string): Promise<boolean> {
  return removeOf(backendFor(projectDir), name);
}
