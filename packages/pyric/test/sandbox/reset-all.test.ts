/**
 * `Sandbox.resetAll()` — the one sandbox-owned "wipe everything" path
 * (issue #359: Studio's reset cleared Firestore docs + auth users but never
 * storage objects, and RTDB coverage rode on nothing).
 *
 * The seam under test is the persistable-service REGISTRY: `resetAll()`
 * iterates every registered service and invokes its optional `reset` hook,
 * so a service is cleared because it REGISTERED, not because a consumer
 * remembered it. The storage assertions here fail against the pre-fix code
 * twice over: storage never registered with the sandbox at all, and no
 * sandbox-owned reset path existed.
 *
 * fake-indexeddb backs the storage service; each test scopes storage to a
 * unique DB name so state can't leak between cases.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getAuth, sandbox as authSandbox } from '../../src/auth/index.js';
import { getDatabase, ref as rtdbRef, set as rtdbSet, get as rtdbGet } from '../../src/database/modular.js';
import { getStorageSandbox, getStorageService } from '../../src/storage/service.js';

function uniqueDbName(label: string): string {
  return `pyric-reset-all-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('Sandbox.resetAll', () => {
  it('clears Firestore docs, auth users, the RTDB tree, and storage objects', async () => {
    const sandbox = initializeSandbox();

    // ── Seed every service ──────────────────────────────────────────
    // Firestore (admin plane — rules-agnostic).
    sandbox.admin.setDocument('rooms/general', { name: 'General' });
    sandbox.admin.setDocument('rooms/general/messages/m1', { text: 'hi' });

    // Auth user DB.
    const auth = getAuth(sandbox);
    authSandbox.createUser(auth, { email: 'a@example.com', password: 'pw123456' });
    expect(authSandbox.listUsers(auth)).toHaveLength(1);

    // RTDB tree.
    const rtdb = getDatabase(sandbox);
    await rtdbSet(rtdbRef(rtdb, '/presence/u1'), { online: true });

    // Storage object (unique DB per test run; fake-indexeddb persists names
    // process-wide).
    const storage = getStorageSandbox(sandbox, { dbName: uniqueDbName('all') });
    const service = await getStorageService(storage);
    await service.backend.put(
      'uploads/logo.png',
      new Blob(['png-bytes'], { type: 'image/png' }),
      {
        fullPath: 'uploads/logo.png',
        name: 'logo.png',
        bucket: 'pyric-default',
        generation: '1',
        metageneration: '1',
        timeCreated: '2026-07-17T00:00:00.000Z',
        updated: '2026-07-17T00:00:00.000Z',
        size: 9,
      },
    );
    expect(await service.backend.listByPrefix('')).toHaveLength(1);

    // ── The one sandbox-owned reset ─────────────────────────────────
    await sandbox.resetAll();

    // Every service is empty afterwards.
    expect(Object.keys(sandbox.snapshot().firestore)).toHaveLength(0);
    expect(authSandbox.listUsers(auth)).toHaveLength(0);
    // Matches a fresh sandbox: the root reads as an empty tree and the
    // seeded path is gone.
    const tree = await rtdbGet(rtdbRef(rtdb, '/'));
    expect(tree.val()).toEqual({});
    const presence = await rtdbGet(rtdbRef(rtdb, '/presence/u1'));
    expect(presence.val()).toBeNull();
    expect(await service.backend.listByPrefix('')).toHaveLength(0);
  });

  it('reaches storage through the registry seam (storage registers on service open)', async () => {
    // The load-bearing regression: pre-fix, storage never called
    // registerPersistableService, so NO sandbox-owned path could clear it.
    const sandbox = initializeSandbox();
    getStorageSandbox(sandbox, { dbName: uniqueDbName('registry') });
    expect(Object.keys(sandbox.snapshot().services)).toContain('storage');
  });

  it('clears the signed-in session like reset() does', async () => {
    const sandbox = initializeSandbox();
    sandbox.currentUser = { uid: 'u1' };
    await sandbox.resetAll();
    expect(sandbox.currentUser).toBeNull();
  });

  it('isolates a failing service reset so the others still clear', async () => {
    const sandbox = initializeSandbox();
    sandbox.registerPersistableService('broken', {
      snapshot: () => null,
      restore: () => {},
      reset: () => {
        throw new Error('boom');
      },
    });
    const auth = getAuth(sandbox);
    authSandbox.createUser(auth, { email: 'b@example.com', password: 'pw123456' });

    await sandbox.resetAll();
    expect(authSandbox.listUsers(auth)).toHaveLength(0);
  });
});
