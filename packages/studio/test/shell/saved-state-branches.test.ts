/**
 * Branching from a saved state, which is the only form of the sandbox Studio
 * holds.
 *
 * The contract under test: a branch forked from a saved state reads what that
 * state held, writes on the branch never reach the state it came from, a
 * candidate ruleset governs the branch, and the comparison Studio draws is over
 * documents alone.
 */
import { describe, it, expect } from 'bun:test';

import {
  documentDivergences,
  forkFromSavedState,
  savedStateOf,
} from '../../src/shell/saved-state-branches.js';
import { discard, initializeSandbox, type SandboxSnapshot } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';

const PERMISSIVE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const CLOSED = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read: if true; allow write: if false; }
  }
}`;

/** A saved state holding the given documents under permissive rules. */
function savedState(documents: Record<string, Record<string, unknown>>): SandboxSnapshot {
  const sandbox = initializeSandbox();
  getInternalEnv(sandbox).seed({ rules: PERMISSIVE, documents });
  const saved = sandbox.snapshot();
  sandbox.dispose();
  return saved;
}

describe('savedStateOf', () => {
  it('carries the documents and leaves every other service empty', () => {
    const lifted = savedStateOf(savedState({ 'things/a': { v: 1 } }));
    expect(lifted.firestore).toEqual({ 'things/a': { v: 1 } });
    expect(lifted.database).toBeNull();
    expect(lifted.storage).toEqual([]);
    expect(lifted.auth).toEqual({ users: [], providers: {} });
    expect(lifted.rules).toEqual({ firestore: '', database: null, storage: null });
  });
});

describe('forkFromSavedState', () => {
  it('stands the branch on the documents the saved state carried', async () => {
    const saved = savedState({ 'things/a': { v: 1 } });
    const branch = await forkFromSavedState(saved);
    try {
      expect(getInternalEnv(branch.sandbox).snapshot()['things/a']).toEqual({ v: 1 });
    } finally {
      discard(branch);
    }
  });

  it('keeps the branch off the state it was forked from', async () => {
    const saved = savedState({ 'things/a': { v: 1 } });
    const branch = await forkFromSavedState(saved);
    try {
      branch.sandbox.admin.setDocument('things/a', { v: 2 });
      expect(saved.firestore['things/a']).toEqual({ v: 1 });
    } finally {
      discard(branch);
    }
  });

  it('installs a candidate ruleset over the one the saved state carried', async () => {
    const branch = await forkFromSavedState(savedState({}), CLOSED);
    try {
      expect(getInternalEnv(branch.sandbox).getRules()).toBe(CLOSED);
    } finally {
      discard(branch);
    }
  });

  it('leaves the rules the saved state loads in place for the empty candidate', async () => {
    const saved = savedState({});
    const loaded = initializeSandbox();
    loaded.loadSnapshot(saved);
    const branch = await forkFromSavedState(saved);
    try {
      expect(getInternalEnv(branch.sandbox).getRules()).toBe(getInternalEnv(loaded).getRules());
      expect(getInternalEnv(branch.sandbox).getRules()).not.toBe(CLOSED);
    } finally {
      discard(branch);
      loaded.dispose();
    }
  });
});

describe('documentDivergences', () => {
  it('reports nothing when the branch has not been written to', async () => {
    const saved = savedState({ 'things/a': { v: 1 } });
    const branch = await forkFromSavedState(saved);
    try {
      expect(documentDivergences(branch, saved)).toEqual([]);
    } finally {
      discard(branch);
    }
  });

  it('reports the field a write on the branch changed', async () => {
    const saved = savedState({ 'things/a': { v: 1 } });
    const branch = await forkFromSavedState(saved);
    try {
      branch.sandbox.admin.setDocument('things/a', { v: 2 });
      expect(documentDivergences(branch, saved)).toEqual([
        {
          kind: 'real-divergence',
          service: 'firestore',
          path: 'things/a',
          field: 'v',
          before: 1,
          after: 2,
        },
      ]);
    } finally {
      discard(branch);
    }
  });

  it('reports a document the branch added, at its path', async () => {
    const saved = savedState({});
    const branch = await forkFromSavedState(saved);
    try {
      branch.sandbox.admin.setDocument('things/new', { v: 1 });
      expect(documentDivergences(branch, saved)).toMatchObject([
        { service: 'firestore', path: 'things/new', after: { v: 1 } },
      ]);
    } finally {
      discard(branch);
    }
  });

  it('reports no rules difference, because both sides are lifted the same way', async () => {
    const saved = savedState({});
    const branch = await forkFromSavedState(saved, CLOSED);
    try {
      expect(documentDivergences(branch, saved)).toEqual([]);
    } finally {
      discard(branch);
    }
  });
});
