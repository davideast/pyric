/**
 * The four operations a host offers over checkpoints, written once.
 *
 * Save, restore, list, delete. Each takes the backend that says where the
 * checkpoints are kept, so the Node process and the page run the same code
 * over a directory of files and over a record store respectively. The
 * host-visible refusals live here too: restoring a name nothing answers to
 * names the ones that do, because a caller who mistyped a checkpoint wants the
 * list rather than an empty sandbox.
 */

import type { LocalSandbox } from '../types/service.js';
import { captureCheckpoint, restoreCheckpoint } from './capture.js';
import type { Checkpoint, CheckpointBackend, CheckpointListing } from './types.js';

/** What a save reports: the checkpoint written, and whether it replaced one. */
export interface SavedCheckpoint {
  name: string;
  overwrote: boolean;
  checkpoint: Checkpoint;
}

/** Capture the sandbox and keep it under `name`, replacing whatever that name held. */
export async function saveCheckpoint(
  backend: CheckpointBackend,
  name: string,
  sandbox: LocalSandbox,
): Promise<SavedCheckpoint> {
  const overwrote = (await backend.read(name)) !== null;
  const checkpoint = await captureCheckpoint(sandbox);
  await backend.write(name, checkpoint);
  return { name, overwrote, checkpoint };
}

/** The checkpoint kept under `name`, or null when the backend holds none. */
export function readCheckpoint(
  backend: CheckpointBackend,
  name: string,
): Promise<Checkpoint | null> {
  return backend.read(name);
}

/** Every checkpoint the backend holds, ordered by name. */
export function listCheckpoints(backend: CheckpointBackend): Promise<CheckpointListing[]> {
  return backend.list();
}

/** The names the backend holds, ordered, for a refusal that has to name them. */
export async function checkpointNames(backend: CheckpointBackend): Promise<string[]> {
  return (await backend.list()).map((entry) => entry.name);
}

/**
 * Put the sandbox back to the checkpoint kept under `name`, and report which
 * one was restored. Resolves null when the backend holds no such checkpoint,
 * and the sandbox is left exactly as it was.
 */
export async function restoreNamedCheckpoint(
  backend: CheckpointBackend,
  name: string,
  sandbox: LocalSandbox,
): Promise<Checkpoint | null> {
  const checkpoint = await backend.read(name);
  if (checkpoint === null) return null;
  await restoreCheckpoint(sandbox, checkpoint);
  return checkpoint;
}

/** Remove one checkpoint. Reports whether there was one to remove. */
export function removeCheckpoint(backend: CheckpointBackend, name: string): Promise<boolean> {
  return backend.remove(name);
}
