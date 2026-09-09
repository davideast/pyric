/**
 * The branches the project holds on disk, as the proposals panel lists them.
 *
 * A proposal staged in this tab is an open branch held in memory. A branch the
 * agent forked through the sandbox tool is a directory the branch store owns,
 * so it outlives the tab and the server both. What that directory holds, and
 * what a file in it is called, is the store's business and is read there, on
 * the server side of the workspace port. This module receives each branch
 * already rebuilt, and asks the engine's own `diff` how far its documents have
 * drifted from live, so the drift it reports is the engine's answer and not a
 * second opinion about it.
 */
import { useEffect, useState } from 'react';
import { diffFullStates, type SandboxSnapshot } from 'pyric/sandbox';

import { snapshotState } from '../../shell/snapshot-branches.js';

import type { WorkspaceBranch, WorkspaceStore } from '../../ports.js';
import { useEnvironment } from '../../shell/environment.js';
import { useStudioSnapshot } from '../../shell/studio-data.js';

/** One branch as the panel renders it. */
export interface PersistedBranch {
  name: string;
  /** When the branch was forked, as an ISO 8601 instant. */
  created: string;
  /** `live`, or the name of the checkpoint the fork was taken from. */
  base: string;
  eventCount: number;
  /** How many documents the branch and the live sandbox disagree on. */
  divergences: number;
}

/**
 * How far one branch's documents have drifted from the live snapshot. The
 * comparison runs through the engine's own walk over two states, each holding
 * the documents of one side, so the drift reported is the engine's answer and
 * not a second opinion about it.
 */
function divergencesFrom(branch: WorkspaceBranch, live: SandboxSnapshot): number {
  const held = { ...snapshotState(live), firestore: branch.documents };
  return diffFullStates(snapshotState(live), held).length;
}

/** Every branch the project holds, ordered by name. */
export async function readPersistedBranches(
  workspace: WorkspaceStore,
  live: SandboxSnapshot | null,
): Promise<PersistedBranch[]> {
  const branches = await workspace.branches();
  return branches.map((branch) => ({
    name: branch.name,
    created: branch.created,
    base: branch.base,
    eventCount: branch.eventCount,
    divergences: live === null ? 0 : divergencesFrom(branch, live),
  }));
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
  const workspace = env.status === 'ready' ? env.env.workspace : undefined;
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
