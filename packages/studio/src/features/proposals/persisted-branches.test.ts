/**
 * Reading the persisted branches through the workspace port: the fields the
 * panel renders and the drift count against live across Firestore documents and
 * SHA-256 Storage object references.
 */
import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initializeSandbox, type SandboxSnapshot } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';

import {
  readPersistedBranches,
  usePersistedBranches,
  type PersistedBranch,
} from './persisted-branches.js';
import { EnvironmentProvider } from '../../shell/environment.js';
import type { SavedNamedFirestoreSnapshot } from '../../shell/saved-state-branches.js';
import type {
  WorkspaceBranch,
  WorkspaceBranchStorageReference,
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
  const snap = sandbox.snapshot();
  sandbox.dispose();
  return snap;
}

/** One branch as the port reports it: the manifest fields, documents, and optional Storage refs. */
function branch(
  name: string,
  documents: Record<string, Record<string, unknown>>,
  eventCount = 0,
  storage?: WorkspaceBranchStorageReference[],
): WorkspaceBranch {
  const out: WorkspaceBranch = {
    name,
    created: '2026-09-09T12:00:00.000Z',
    base: 'live',
    eventCount,
    documents,
  };
  if (storage !== undefined) out.storage = storage;
  return out;
}

function firstBranch(listed: readonly PersistedBranch[]): PersistedBranch {
  const first = listed[0];
  if (first === undefined) throw new Error('expected at least one persisted branch');
  return first;
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
    expect(firstBranch(listed)).toEqual({
      name: 'draft',
      created: '2026-09-09T12:00:00.000Z',
      base: 'live',
      eventCount: 0,
      divergences: 0,
    });
  });

  it('counts the documents a branch and live disagree on', async () => {
    const live = liveSnapshot();
    const empty: SandboxSnapshot = { firestore: {}, services: {} };
    const listed = await readPersistedBranches(
      workspaceOver([branch('draft', live.firestore)]),
      empty,
    );
    expect(firstBranch(listed).divergences).toBe(1);
  });

  it('counts a write staged on the branch as drift', async () => {
    const live = liveSnapshot();
    const staged = { ...live.firestore, 'notes/staged': { body: 'planned' } };
    const listed = await readPersistedBranches(
      workspaceOver([branch('draft', staged, 1)]),
      live,
    );
    expect(firstBranch(listed).eventCount).toBe(1);
    expect(firstBranch(listed).divergences).toBe(1);
  });

  it('reports no drift when there is no live snapshot to compare against', async () => {
    const live = liveSnapshot();
    const listed = await readPersistedBranches(
      workspaceOver([branch('draft', live.firestore)]),
      null,
    );
    expect(firstBranch(listed).divergences).toBe(0);
  });

  it('compares SHA-256 Storage object references when live describes Storage and ignores Storage when live omits it', async () => {
    const baseLive = liveSnapshot();
    const shaA = '1'.repeat(64);
    const shaB = '2'.repeat(64);
    const sharedRef: WorkspaceBranchStorageReference = {
      path: 'videos/keynote.mp4',
      sha256: shaA,
      size: 524_288_000,
      contentType: 'video/mp4',
      customMetadata: { speaker: 'alice' },
      blobType: 'video/mp4',
    };

    // When live does not describe Storage (`services: {}`), branch Storage refs do not read as false drift.
    const againstFirestoreOnly = await readPersistedBranches(
      workspaceOver([branch('draft', baseLive.firestore, 0, [sharedRef])]),
      baseLive,
    );
    expect(firstBranch(againstFirestoreOnly).divergences).toBe(0);

    // When live describes the same SHA-256 Storage reference, drift is 0.
    const liveWithStorage: SavedNamedFirestoreSnapshot = {
      ...baseLive,
      storage: [{ ...sharedRef }],
    };
    const matching = await readPersistedBranches(
      workspaceOver([branch('draft', baseLive.firestore, 0, [sharedRef])]),
      liveWithStorage,
    );
    expect(firstBranch(matching).divergences).toBe(0);

    // When the branch points at a different SHA-256 digest, Storage divergence is counted without reading bytes.
    const divergedRef: WorkspaceBranchStorageReference = {
      ...sharedRef,
      sha256: shaB,
    };
    const changed = await readPersistedBranches(
      workspaceOver([branch('draft', baseLive.firestore, 1, [divergedRef])]),
      liveWithStorage,
    );
    expect(firstBranch(changed).divergences).toBe(1);
  });

  it('usePersistedBranches returns empty list in browser mode before workspace hydration', () => {
    function BranchCountProbe() {
      const branches = usePersistedBranches();
      return createElement('span', { 'data-count': branches.length }, String(branches.length));
    }
    const html = renderToStaticMarkup(
      createElement(EnvironmentProvider, {
        mode: 'browser',
        children: createElement(BranchCountProbe),
      }),
    );
    expect(html).toContain('data-count="0"');
  });
});
