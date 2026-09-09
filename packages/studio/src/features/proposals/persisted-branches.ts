/**
 * The branches the project holds on disk, as the proposals panel lists them.
 *
 * A proposal staged in this tab is an open branch held in memory. A branch the
 * agent forked through the sandbox tool is a directory under
 * `.pyric/state/branches/<name>/`, so it outlives the tab and the server both,
 * and Studio has to read it rather than remember it. The directory holds a
 * manifest, the forked base snapshot in the v3 record bundle, the applied
 * event log, and the candidate rules when the fork carried any; this module
 * reads it through the workspace port and rebuilds each branch with the same
 * `fork` and `apply` the engine runs, so the drift it reports is the engine's
 * own `diff` and not a second opinion about it.
 */
import { useEffect, useState } from 'react';
import {
  apply,
  deserializeFromBuckets,
  diff,
  fork,
  parseBundle,
  type SandboxEvent,
  type SandboxSnapshot,
} from 'pyric/sandbox';

import type { WorkspaceStore } from '../../ports.js';
import { useEnvironment } from '../../shell/environment.js';
import { useStudioSnapshot } from '../../shell/studio-data.js';

/** Where the branch store lives, as a project-relative POSIX path. */
export const BRANCH_STORE_PATH = '.pyric/state/branches';

/** The tag a manifest this reader accepts carries. */
export const BRANCH_FORMAT = 'pyric-branch-v1';

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

/** The manifest fields this reader needs, checked before they are trusted. */
interface Manifest {
  format: string;
  created: string;
  base: string;
  eventCount: number;
}

/** Parse one manifest body, or report that it is not one this reader accepts. */
function parseManifest(body: string | null): Manifest | null {
  if (body === null) return null;
  let parsed: Partial<Manifest>;
  try {
    parsed = JSON.parse(body) as Partial<Manifest>;
  } catch {
    return null;
  }
  if (parsed.format !== BRANCH_FORMAT) return null;
  if (typeof parsed.created !== 'string') return null;
  if (typeof parsed.base !== 'string') return null;
  if (typeof parsed.eventCount !== 'number') return null;
  return {
    format: parsed.format,
    created: parsed.created,
    base: parsed.base,
    eventCount: parsed.eventCount,
  };
}

/** The snapshot one stored base bundle carries. */
function snapshotFrom(bundle: string): SandboxSnapshot {
  const { firestore, services } = deserializeFromBuckets(parseBundle(bundle));
  return { firestore, services };
}

/** The events one stored event log carries. */
function eventsFrom(body: string | null): SandboxEvent[] {
  if (body === null) return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    return Array.isArray(parsed) ? (parsed as SandboxEvent[]) : [];
  } catch {
    return [];
  }
}

/**
 * How far one stored branch has drifted from the live snapshot. Returns zero
 * when the branch's base bundle cannot be read, which is the honest count for
 * a comparison that never happened.
 */
async function divergencesFrom(
  workspace: WorkspaceStore,
  name: string,
  live: SandboxSnapshot,
): Promise<number> {
  const bundle = await workspace.read(`${BRANCH_STORE_PATH}/${name}/base.bundle.json`);
  if (bundle === null) return 0;
  const rules = await workspace.read(`${BRANCH_STORE_PATH}/${name}/rules.firestore`);
  const branch = fork(snapshotFrom(bundle), rules ?? '');
  const events = eventsFrom(await workspace.read(`${BRANCH_STORE_PATH}/${name}/events.json`));
  if (events.length > 0) apply(branch, events);
  const count = diff(branch, live).length;
  branch.sandbox.dispose();
  return count;
}

/**
 * Every branch the project holds, ordered by name. A directory whose manifest
 * this reader does not accept is skipped rather than failing the listing, so
 * one unreadable branch does not empty the panel.
 */
export async function readPersistedBranches(
  workspace: WorkspaceStore,
  live: SandboxSnapshot | null,
): Promise<PersistedBranch[]> {
  const entries = await workspace.list(BRANCH_STORE_PATH);
  const listed: PersistedBranch[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue;
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    const manifest = parseManifest(await workspace.read(`${entry.path}/manifest.json`));
    if (manifest === null) continue;
    const divergences = live === null ? 0 : await divergencesFrom(workspace, name, live);
    listed.push({
      name,
      created: manifest.created,
      base: manifest.base,
      eventCount: manifest.eventCount,
      divergences,
    });
  }
  return listed.sort((a, b) => a.name.localeCompare(b.name));
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
