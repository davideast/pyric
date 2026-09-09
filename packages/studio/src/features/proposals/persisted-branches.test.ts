/**
 * Reading the persisted branch store through the workspace port: the listing,
 * the manifest fields the panel renders, the drift count against live, and the
 * directory that is skipped rather than failing the listing.
 *
 * The store's files are written here by the same codec the engine writes them
 * with, so what this pins is the reader and not a second copy of the format.
 */
import { describe, expect, it } from 'bun:test';
import {
  bundleRecords,
  fork,
  initializeSandbox,
  serializeToBuckets,
  type SandboxSnapshot,
} from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';

import {
  BRANCH_FORMAT,
  BRANCH_STORE_PATH,
  readPersistedBranches,
} from './persisted-branches.js';
import type { WorkspaceChange, WorkspaceEntry, WorkspaceStore } from '../../ports.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

/** A workspace port over a plain path-to-body map, which is all this reader uses. */
function workspaceOver(files: Record<string, string>): WorkspaceStore {
  return {
    async read(path) {
      return files[path] ?? null;
    },
    async write() {
      throw new Error('this reader never writes');
    },
    async list(dir) {
      const prefix = `${dir ?? ''}/`;
      const names = new Set<string>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        names.add(path.slice(prefix.length).split('/')[0]!);
      }
      const entries: WorkspaceEntry[] = [...names]
        .sort()
        .map((name) => ({ path: `${prefix}${name}`, kind: 'dir' as const }));
      return entries;
    },
    async remove() {
      throw new Error('this reader never removes');
    },
    watch(_cb: (change: WorkspaceChange) => void) {
      return () => undefined;
    },
  };
}

/** The bundle text one snapshot is stored as. */
function bundle(snapshot: SandboxSnapshot): string {
  return bundleRecords(serializeToBuckets(snapshot.firestore, snapshot.services, 0));
}

/** A live sandbox holding one document, and its snapshot. */
function liveSnapshot(): SandboxSnapshot {
  const sandbox = initializeSandbox();
  getInternalEnv(sandbox).seed({ rules: RULES, documents: { 'notes/n1': { body: 'live' } } });
  return sandbox.snapshot();
}

/** The four files one stored branch holds, keyed as the workspace port sees them. */
function branchFiles(
  name: string,
  base: SandboxSnapshot,
  events: unknown[],
  eventCount: number,
): Record<string, string> {
  const dir = `${BRANCH_STORE_PATH}/${name}`;
  return {
    [`${dir}/manifest.json`]: JSON.stringify({
      format: BRANCH_FORMAT,
      created: '2026-09-09T12:00:00.000Z',
      base: 'live',
      eventCount,
    }),
    [`${dir}/base.bundle.json`]: bundle(base),
    [`${dir}/events.json`]: JSON.stringify(events),
    [`${dir}/rules.firestore`]: RULES,
  };
}

describe('readPersistedBranches', () => {
  it('reports nothing when the project holds no branch store', async () => {
    expect(await readPersistedBranches(workspaceOver({}), null)).toEqual([]);
  });

  it('reports the manifest fields the panel renders', async () => {
    const live = liveSnapshot();
    const files = branchFiles('draft', live, [], 0);
    const [branch] = await readPersistedBranches(workspaceOver(files), live);
    expect(branch).toEqual({
      name: 'draft',
      created: '2026-09-09T12:00:00.000Z',
      base: 'live',
      eventCount: 0,
      divergences: 0,
    });
  });

  it('counts the documents a branch and live disagree on', async () => {
    // The branch is forked from a base that has the document; live no longer
    // does, which is one divergence and the reason the panel shows a count.
    const base = liveSnapshot();
    const files = branchFiles('draft', base, [], 0);
    const empty: SandboxSnapshot = { firestore: {}, services: {} };
    const [branch] = await readPersistedBranches(workspaceOver(files), empty);
    expect(branch!.divergences).toBe(1);
  });

  it('orders branches by name and skips a directory with no manifest this reader accepts', async () => {
    const live = liveSnapshot();
    const files = {
      ...branchFiles('beta', live, [], 0),
      ...branchFiles('alpha', live, [], 0),
      [`${BRANCH_STORE_PATH}/rubble/other.txt`]: 'x',
      [`${BRANCH_STORE_PATH}/foreign/manifest.json`]: JSON.stringify({ format: 'something-else' }),
    };
    const listed = await readPersistedBranches(workspaceOver(files), live);
    expect(listed.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
  });

  it('reports no drift when there is no live snapshot to compare against', async () => {
    const base = liveSnapshot();
    const files = branchFiles('draft', base, [], 0);
    const [branch] = await readPersistedBranches(workspaceOver(files), null);
    expect(branch!.divergences).toBe(0);
  });

  it('replays the stored events before comparing, so a staged write shows as drift', async () => {
    const live = liveSnapshot();
    const staged = [
      {
        kind: 'write',
        method: 'set',
        path: 'notes/staged',
        data: { body: 'planned' },
        auth: null,
        requestTime: { seconds: 1_700_000_000, nanoseconds: 0 },
      },
    ];
    const files = branchFiles('draft', live, staged, 1);
    const [branch] = await readPersistedBranches(workspaceOver(files), live);
    expect(branch!.eventCount).toBe(1);
    expect(branch!.divergences).toBe(1);
  });
});

describe('the branch store path', () => {
  it('is the directory the sandbox tool forks into', () => {
    expect(BRANCH_STORE_PATH).toBe('.pyric/state/branches');
    // A round trip through `fork` proves the reader and the engine agree on the
    // shape a stored base is rebuilt into.
    const branch = fork(liveSnapshot(), RULES);
    expect(branch.base.firestore['notes/n1']).toEqual({ body: 'live' });
    branch.sandbox.dispose();
  });
});
