/**
 * Reading the persisted branches through the workspace port: the fields the
 * panel renders and the drift count against live.
 *
 * The port hands this reader branches the branch store has already rebuilt, so
 * what this pins is the drift computation and the shape the panel gets. The
 * on-disk format is the store's, and it is read and tested there.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, type SandboxSnapshot } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';

import { readPersistedBranches } from './persisted-branches.js';
import type {
  WorkspaceBranch,
  WorkspaceChange,
  WorkspaceStore,
} from '../../ports.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

/** A workspace port that answers with one branch listing and nothing else. */
function workspaceOver(branches: WorkspaceBranch[]): WorkspaceStore {
  return {
    async read() {
      throw new Error('this reader never reads a file');
    },
    async write() {
      throw new Error('this reader never writes');
    },
    async list() {
      throw new Error('this reader never lists a directory');
    },
    async remove() {
      throw new Error('this reader never removes');
    },
    async branches() {
      return branches;
    },
    watch(_cb: (change: WorkspaceChange) => void) {
      return () => undefined;
    },
  };
}

/** A live sandbox holding one document, and its snapshot. */
function liveSnapshot(): SandboxSnapshot {
  const sandbox = initializeSandbox();
  getInternalEnv(sandbox).seed({ rules: RULES, documents: { 'notes/n1': { body: 'live' } } });
  return sandbox.snapshot();
}

/** One branch as the port reports it: the manifest fields plus its documents. */
function branch(
  name: string,
  documents: Record<string, Record<string, unknown>>,
  eventCount = 0,
): WorkspaceBranch {
  return {
    name,
    created: '2026-09-09T12:00:00.000Z',
    base: 'live',
    eventCount,
    documents,
  };
}

describe('readPersistedBranches', () => {
  it('reports nothing when the project holds no branches', async () => {
    expect(await readPersistedBranches(workspaceOver([]), null)).toEqual([]);
  });

  it('reports the fields the panel renders', async () => {
    const live = liveSnapshot();
    const listed = await readPersistedBranches(
      workspaceOver([branch('draft', live.firestore)]),
      live,
    );
    expect(listed[0]).toEqual({
      name: 'draft',
      created: '2026-09-09T12:00:00.000Z',
      base: 'live',
      eventCount: 0,
      divergences: 0,
    });
  });

  it('counts the documents a branch and live disagree on', async () => {
    // The branch holds the document; live no longer does, which is one
    // divergence and the reason the panel shows a count.
    const live = liveSnapshot();
    const empty: SandboxSnapshot = { firestore: {}, services: {} };
    const listed = await readPersistedBranches(
      workspaceOver([branch('draft', live.firestore)]),
      empty,
    );
    expect(listed[0]!.divergences).toBe(1);
  });

  it('counts a write staged on the branch as drift', async () => {
    const live = liveSnapshot();
    const staged = { ...live.firestore, 'notes/staged': { body: 'planned' } };
    const listed = await readPersistedBranches(
      workspaceOver([branch('draft', staged, 1)]),
      live,
    );
    expect(listed[0]!.eventCount).toBe(1);
    expect(listed[0]!.divergences).toBe(1);
  });

  it('reports no drift when there is no live snapshot to compare against', async () => {
    const live = liveSnapshot();
    const listed = await readPersistedBranches(
      workspaceOver([branch('draft', live.firestore)]),
      null,
    );
    expect(listed[0]!.divergences).toBe(0);
  });
});
