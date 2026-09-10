/**
 * Capture and restore: what a checkpoint holds, and where restoring one leaves
 * the sandbox. A checkpoint that silently dropped a service would show up here
 * as a service that survives a restore it should not have.
 */
import { describe, it, expect } from 'bun:test';

import { getAuth } from '../../../src/auth/instances.js';
import { getOrCreateBackend } from '../../../src/database/sandbox/backend-for.js';
import {
  captureCheckpoint,
  countsOf,
  restoreCheckpoint,
} from '../../../src/sandbox/checkpoints/index.js';
import { captureFullState } from '../../../src/sandbox/index.js';
import { getInternalEnv } from '../../../src/sandbox/internal/sandbox-impl.js';
import { ref as storageRef, uploadBytes } from '../../../src/storage/index.js';
import { getAdminStorageSandbox } from '../../../src/storage/internal.js';
import { populatedSandbox } from '../branches/fixtures.js';

describe('captureCheckpoint', () => {
  it('carries the whole sandbox and the counts over it', async () => {
    const sandbox = await populatedSandbox();
    const checkpoint = await captureCheckpoint(sandbox);

    expect(checkpoint.format).toBe('pyric-checkpoint-v1');
    expect(typeof checkpoint.at).toBe('number');
    expect(checkpoint.state).toEqual(await captureFullState(sandbox));
    expect(checkpoint.counts).toEqual({ firestore: 2, database: 1, storage: 1, auth: 1 });
  });

  it('changes nothing in the sandbox it reads', async () => {
    const sandbox = await populatedSandbox();
    const before = await captureFullState(sandbox);
    await captureCheckpoint(sandbox);
    expect(await captureFullState(sandbox)).toEqual(before);
  });
});

describe('countsOf', () => {
  it('reports nothing for an empty sandbox', async () => {
    const state = await captureFullState(await populatedSandbox());
    const emptied = { ...state, firestore: {}, storage: [], auth: { users: [], providers: {} } };
    expect(countsOf(emptied).firestore).toBe(0);
    expect(countsOf(emptied).storage).toBe(0);
    expect(countsOf(emptied).auth).toBe(0);
  });
});

describe('restoreCheckpoint', () => {
  it('puts back every service and removes what the checkpoint never held', async () => {
    const sandbox = await populatedSandbox();
    const checkpoint = await captureCheckpoint(sandbox);

    getInternalEnv(sandbox).execute({
      method: 'set',
      path: 'things/after',
      data: { v: 2 },
      auth: null,
    });
    getOrCreateBackend(sandbox).adminSet('rooms/after', { title: 'after' });
    await uploadBytes(
      storageRef(getAdminStorageSandbox(sandbox), 'docs/after.txt'),
      new Uint8Array([7]),
      { contentType: 'text/plain' },
    );

    await restoreCheckpoint(sandbox, checkpoint);

    const state = await captureFullState(sandbox);
    expect(Object.keys(state.firestore)).not.toContain('things/after');
    expect(state.storage.map((object) => object.path)).toEqual(['docs/hello.txt']);
    expect(state).toEqual(checkpoint.state);
  });

  it('restores the accounts a sandbox held when the checkpoint was taken', async () => {
    const sandbox = await populatedSandbox();
    const checkpoint = await captureCheckpoint(sandbox);
    expect(getAuth(sandbox)).toBeDefined();

    await restoreCheckpoint(sandbox, checkpoint);
    const state = await captureFullState(sandbox);
    expect(state.auth.users.map((user) => user.uid)).toEqual(['alice']);
  });
});
