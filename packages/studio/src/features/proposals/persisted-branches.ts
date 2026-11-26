/**
 * The branches the project holds on disk, as the proposals panel lists them.
 *
 * A proposal staged in this tab is an open branch held in memory. A branch the
 * agent forked through the sandbox tool is a directory the branch store owns,
 * so it outlives the tab and the server both. What that directory holds, and
 * what a file in it is called, is the store's business and is read there, on
 * the server side of the workspace port. This module receives each branch
 * already rebuilt (Firestore documents plus SHA-256 Storage object references),
 * and asks the engine's own `diff` how far it has drifted from live without
 * copying Storage bytes inline.
 */
import { useEffect, useState } from 'react';
import { diffFullStates, type SandboxSnapshot } from 'pyric/sandbox';

import {
  comparableStorageReferenceOf,
  hasSavedStorage,
  savedStateOf,
} from '../../shell/saved-state-branches.js';

import type { WorkspaceBranch, WorkspaceStore } from '../../ports.js';
import { useEnvironment } from '../../shell/environment.js';
import { useStudioSnapshot } from '../../shell/studio-saved-states.js';

/** One branch as the panel renders it. */
export interface PersistedBranch {
  name: string;
  /** When the branch was forked, as an ISO 8601 instant. */
  created: string;
  /** `live`, or the name of the checkpoint the fork was taken from. */
  base: string;
  eventCount: number;
  /** How many entries the branch and the live sandbox disagree on. */
  divergences: number;
}

/**
 * How far one branch has drifted from the live snapshot. When `live` describes
 * Cloud Storage references, both sides compare SHA-256 Storage references
 * alongside Firestore documents; when `live` omits Storage, Storage stays empty
 * on both sides so an undescribed service never reads as drift.
 */
function divergencesFrom(branch: WorkspaceBranch, live: SandboxSnapshot): number {
  const liveState = savedStateOf(live);
  let branchStorage = liveState.storage;
  if (hasSavedStorage(live)) {
    branchStorage = (branch.storage ?? []).map(comparableStorageReferenceOf);
  } else {
    liveState.storage = [];
    branchStorage = [];
  }
  const held = {
    ...liveState,
    firestore: branch.documents,
    storage: branchStorage,
  };
  return diffFullStates(liveState, held).length;
}

/** Every branch the project holds, ordered by name. */
export async function readPersistedBranches(
  workspace: WorkspaceStore,
  live: SandboxSnapshot | null,
): Promise<PersistedBranch[]> {
  const branches = await workspace.branches();
  return branches.map((branch) => {
    let divergences = 0;
    if (live !== null) {
      divergences = divergencesFrom(branch, live);
    }
    return {
      name: branch.name,
      created: branch.created,
      base: branch.base,
      eventCount: branch.eventCount,
      divergences,
    };
  });
}

/**
 * The persisted branches, read once per mount. Empty when the environment has
 * no workspace port, which is every mode with no server behind it (review, the
 * static build), and empty is the honest answer there: the branch store is a
 * directory only a served project has.
 */
export function usePersistedBranches(): PersistedBranch[] {
  const env = useEnvironment();
  const snapshot = useStudioSnapshot();
  let workspace: WorkspaceStore | undefined;
  if (env.status === 'ready') {
    workspace = env.env.workspace;
  }
  const [branches, setBranches] = useState<PersistedBranch[]>([]);
  useEffect(() => {
    if (!workspace) {
      setBranches([]);
      return;
    }
    let live = true;
    void (async () => {
      const read = await readPersistedBranches(workspace, await snapshot());
      if (live) setBranches(read);
    })();
    return () => {
      live = false;
    };
  }, [workspace, snapshot]);
  return branches;
}
