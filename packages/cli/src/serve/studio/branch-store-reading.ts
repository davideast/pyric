/**
 * The branch store, read for the workspace port.
 *
 * The on-disk shape of a branch is stated once, in
 * `pyric/sandbox/branches/store`, and read there: the manifest and its format
 * tag, the forked base and the branch's current state one file per service,
 * the event log, the candidate
 * rules file. This module is the one place the serve process asks that store
 * what the project holds,
 * and it hands the port a branch that is already rebuilt: what the manifest
 * recorded, plus the Firestore documents the branch holds once its events have
 * been applied. Nothing downstream of here, Studio included, opens a branch
 * file or knows what one is called.
 */
import { listBranches, loadBranch } from 'pyric/sandbox/branches/store';

import type { WorkspaceBranch } from './store-types.js';

/** Every branch the project holds, ordered by name, each one rebuilt. */
export async function readBranches(projectDir: string): Promise<WorkspaceBranch[]> {
  const rebuilt: WorkspaceBranch[] = [];
  for (const entry of listBranches(projectDir)) {
    rebuilt.push({
      name: entry.name,
      created: entry.created,
      base: entry.base,
      eventCount: entry.eventCount,
      documents: await documentsOf(projectDir, entry.name),
    });
  }
  return rebuilt;
}

/**
 * The Firestore documents one branch holds. A branch that will not rebuild
 * reports no documents rather than failing the listing, so one unreadable
 * branch does not take the whole panel down.
 */
async function documentsOf(
  projectDir: string,
  name: string,
): Promise<Record<string, Record<string, unknown>>> {
  const loaded = await loadBranch(projectDir, name);
  if (loaded === null) return {};
  const documents = loaded.branch.sandbox.snapshot().firestore;
  loaded.branch.sandbox.dispose();
  return documents;
}
