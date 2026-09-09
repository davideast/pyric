/**
 * Checkpoints kept as files under a project directory.
 *
 * One file per checkpoint, `<project>/.pyric/state/checkpoints/<name>.json`,
 * named by the checkpoint. The directory is the index: the listing reads it
 * rather than a manifest, so a checkpoint copied into the directory by hand is
 * one the listing finds and a checkpoint deleted from it is one the listing
 * does not.
 *
 * Each write lands through a temporary file and a rename, so a process that
 * dies mid-write leaves the previous checkpoint intact rather than a truncated
 * one. A file that does not parse, or that carries no format tag this module
 * wrote, is skipped by the listing rather than failing it, so one unrelated
 * JSON file in the directory does not take the whole listing down.
 *
 * This module reads and writes files, so it is Node only and is published at
 * the `pyric/sandbox/checkpoints/directory` subpath rather than from the
 * browser barrel `pyric/sandbox`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CHECKPOINT_NAME_PATTERN,
  assertCheckpointName,
  isCheckpointEnvelope,
  type Checkpoint,
  type CheckpointBackend,
  type CheckpointListing,
} from './types.js';

/** Where checkpoints live, relative to the project directory. */
export const CHECKPOINT_STORE_RELATIVE = join('.pyric', 'state', 'checkpoints');

const FILE_SUFFIX = '.json';

/** The directory one project's checkpoints occupy. */
function checkpointsDirectory(projectDir: string): string {
  return join(projectDir, CHECKPOINT_STORE_RELATIVE);
}

/** The file one checkpoint occupies. */
function checkpointPath(projectDir: string, name: string): string {
  assertCheckpointName(name);
  return join(checkpointsDirectory(projectDir), `${name}${FILE_SUFFIX}`);
}

/** One checkpoint read off disk, or null when the file is absent or not one. */
function readCheckpointFile(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isCheckpointEnvelope(parsed)) return null;
  return parsed;
}

/** Every name the directory holds that could be a checkpoint, ordered. */
function storedNames(projectDir: string): string[] {
  const dir = checkpointsDirectory(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(FILE_SUFFIX))
    .map((file) => file.slice(0, -FILE_SUFFIX.length))
    .filter((name) => CHECKPOINT_NAME_PATTERN.test(name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Keep checkpoints as files under `projectDir`.
 *
 * @param projectDir The project the checkpoints belong to. The directory is
 *                   created on the first write and is not required to exist.
 */
export function directoryCheckpointBackend(projectDir: string): CheckpointBackend {
  return {
    async write(name, checkpoint) {
      const path = checkpointPath(projectDir, name);
      mkdirSync(checkpointsDirectory(projectDir), { recursive: true });
      const pending = `${path}.pending-${process.pid}`;
      writeFileSync(pending, `${JSON.stringify(checkpoint)}\n`, 'utf8');
      renameSync(pending, path);
    },

    async read(name) {
      return readCheckpointFile(checkpointPath(projectDir, name));
    },

    async list() {
      const listed: CheckpointListing[] = [];
      for (const name of storedNames(projectDir)) {
        const checkpoint = readCheckpointFile(checkpointPath(projectDir, name));
        if (checkpoint === null) continue;
        listed.push({ name, at: checkpoint.at, counts: checkpoint.counts });
      }
      return listed;
    },

    async remove(name) {
      const path = checkpointPath(projectDir, name);
      if (!existsSync(path)) return false;
      rmSync(path, { force: true });
      return true;
    },
  };
}
