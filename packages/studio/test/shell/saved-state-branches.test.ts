/**
 * Branching from a saved state, which is the only form of the sandbox Studio
 * holds.
 *
 * The contract under test: a branch forked from a saved state reads what that
 * state held, Storage entries carried on a saved state fork by SHA-256 byte
 * reference rather than copying inline base64 payloads, writes on the branch
 * never reach the state it came from, a candidate ruleset governs the branch,
 * and `documentDivergences` compares Firestore documents alone.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, it, expect } from 'bun:test';

import {
  documentDivergences,
  forkFromSavedState,
  hasSavedStorage,
  savedStateOf,
  type SavedNamedFirestoreSnapshot,
} from '../../src/shell/saved-state-branches.js';
import {
  captureFullState,
  discard,
  holdsBytesInline,
  initializeSandbox,
  type SandboxSnapshot,
  type StorageObjectState,
} from 'pyric/sandbox';
import { getInternalEnv, setInlineStorageLimitForTesting } from 'pyric/sandbox/internal';
import { getMetadata, ref as storageRef } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';

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

let restoreLimit: (() => void) | undefined;
afterEach(() => {
  restoreLimit?.();
  restoreLimit = undefined;
});

/** A saved state holding the given documents under permissive rules. */
function savedState(documents: Record<string, Record<string, unknown>>): SandboxSnapshot {
  const sandbox = initializeSandbox();
  getInternalEnv(sandbox).seed({ rules: PERMISSIVE, documents });
  const saved = sandbox.snapshot();
  sandbox.dispose();
  return saved;
}

describe('savedStateOf', () => {
  it('carries the documents and leaves every other service empty when omitted', () => {
    const saved = savedState({ 'things/a': { v: 1 } });
    expect(hasSavedStorage(saved)).toBe(false);
    const lifted = savedStateOf(saved);
    expect(lifted.firestore).toEqual({ 'things/a': { v: 1 } });
    expect(lifted.database).toBeNull();
    expect(lifted.storage).toEqual([]);
    expect(lifted.auth).toEqual({ users: [], providers: {} });
    expect(lifted.rules).toEqual({ firestore: '', database: null, storage: null });
  });

  it('lifts SHA-256 Storage object references when present on the saved state', () => {
    const sha256 = 'd'.repeat(64);
    const withStorage: SavedNamedFirestoreSnapshot = {
      ...savedState({ 'things/a': { v: 1 } }),
      storage: [
        {
          path: 'videos/demo.mp4',
          sha256,
          size: 524_288_000,
          contentType: 'video/mp4',
          customMetadata: { tag: 'hero' },
          blobType: 'video/mp4',
        },
      ],
    };
    expect(hasSavedStorage(withStorage)).toBe(true);
    const lifted = savedStateOf(withStorage);
    expect(lifted.storage).toEqual([
      {
        path: 'videos/demo.mp4',
        sha256,
        size: 524_288_000,
        contentType: 'video/mp4',
        customMetadata: { tag: 'hero' },
        blobType: 'video/mp4',
      },
    ]);
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

  it('forks saved Storage entries by SHA-256 reference with zero inline bytes past inlineStorageLimit', async () => {
    restoreLimit = setInlineStorageLimitForTesting(8);
    const largeSha = 'e'.repeat(64);
    const inlineSmall: StorageObjectState = {
      path: 'docs/guide.txt',
      contentBase64: btoa('0123456789abcdef'), // 16 bytes (> 8 byte inline limit)
      contentType: 'text/plain',
      customMetadata: { section: 'intro' },
      blobType: 'text/plain',
    };
    const largeRef: StorageObjectState = {
      path: 'videos/archive.mp4',
      sha256: largeSha,
      size: 524_288_000,
      contentType: 'video/mp4',
      customMetadata: { codec: 'av1' },
      blobType: 'video/mp4',
    };
    const saved: SavedNamedFirestoreSnapshot = {
      ...savedState({ 'things/a': { v: 1 } }),
      storage: [inlineSmall, largeRef],
    };

    const branch = await forkFromSavedState(saved);
    try {
      expect(branch.base.storage).toHaveLength(2);
      for (const entry of branch.base.storage) {
        expect(holdsBytesInline(entry)).toBe(false);
      }

      const storage = getAdminStorageSandbox(branch.sandbox);
      const archiveMeta = await getMetadata(storageRef(storage, 'videos/archive.mp4'));
      expect(archiveMeta.size).toBe(524_288_000);
      expect(archiveMeta.customMetadata).toEqual({ codec: 'av1' });

      const guideMeta = await getMetadata(storageRef(storage, 'docs/guide.txt'));
      expect(guideMeta.size).toBe(16);

      const captured = await captureFullState(branch.sandbox);
      expect(captured.storage).toHaveLength(2);
      for (const entry of captured.storage) {
        expect(holdsBytesInline(entry)).toBe(false);
      }
      expect(documentDivergences(branch, saved)).toEqual([]);
    } finally {
      discard(branch);
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
