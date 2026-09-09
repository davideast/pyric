/**
 * The four host-facing operations, over a backend. What these pin is that the
 * operations do the same thing whichever backend they are given, which is the
 * whole reason the seam exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getOrCreateBackend } from '../../../src/database/sandbox/backend-for.js';
import {
  checkpointNames,
  listCheckpoints,
  readCheckpoint,
  removeCheckpoint,
  restoreNamedCheckpoint,
  saveCheckpoint,
} from '../../../src/sandbox/checkpoints/index.js';
import { directoryCheckpointBackend } from '../../../src/sandbox/checkpoints/directory-backend.js';
import { captureFullState } from '../../../src/sandbox/index.js';
import { populatedSandbox } from '../branches/fixtures.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pyric-saved-states-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('saveCheckpoint', () => {
  it('reports the counts it saved and that it replaced nothing', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    const saved = await saveCheckpoint(backend, 'nightly', await populatedSandbox());

    expect(saved.name).toBe('nightly');
    expect(saved.overwrote).toBe(false);
    expect(saved.checkpoint.counts).toEqual({
      firestore: 2,
      database: 1,
      storage: 1,
      auth: 1,
    });
  });

  it('reports that it replaced a checkpoint the backend already held', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    await saveCheckpoint(backend, 'nightly', await populatedSandbox());
    const again = await saveCheckpoint(backend, 'nightly', await populatedSandbox());
    expect(again.overwrote).toBe(true);
  });
});

describe('restoreNamedCheckpoint', () => {
  it('puts the sandbox back and reports which checkpoint it restored', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    const sandbox = await populatedSandbox();
    await saveCheckpoint(backend, 'nightly', sandbox);
    getOrCreateBackend(sandbox).adminSet('rooms/after', { title: 'after' });

    const restored = await restoreNamedCheckpoint(backend, 'nightly', sandbox);
    expect(restored).not.toBeNull();
    expect(await captureFullState(sandbox)).toEqual(restored!.state);
  });

  it('reports nothing and leaves the sandbox alone for a name it does not hold', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    const sandbox = await populatedSandbox();
    const before = await captureFullState(sandbox);

    expect(await restoreNamedCheckpoint(backend, 'absent', sandbox)).toBeNull();
    expect(await captureFullState(sandbox)).toEqual(before);
  });
});

describe('the listing operations', () => {
  it('name every checkpoint the backend holds, ordered', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    await saveCheckpoint(backend, 'nightly', await populatedSandbox());
    await saveCheckpoint(backend, 'before', await populatedSandbox());

    expect(await checkpointNames(backend)).toEqual(['before', 'nightly']);
    expect((await listCheckpoints(backend)).map((entry) => entry.name)).toEqual([
      'before',
      'nightly',
    ]);
  });

  it('read one checkpoint by name, or nothing', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    const saved = await saveCheckpoint(backend, 'nightly', await populatedSandbox());
    expect(await readCheckpoint(backend, 'nightly')).toEqual(saved.checkpoint);
    expect(await readCheckpoint(backend, 'absent')).toBeNull();
  });
});

describe('removeCheckpoint', () => {
  it('removes one checkpoint and reports whether there was one', async () => {
    const backend = directoryCheckpointBackend(projectDir);
    await saveCheckpoint(backend, 'nightly', await populatedSandbox());
    expect(await removeCheckpoint(backend, 'nightly')).toBe(true);
    expect(await checkpointNames(backend)).toEqual([]);
    expect(await removeCheckpoint(backend, 'nightly')).toBe(false);
  });
});
