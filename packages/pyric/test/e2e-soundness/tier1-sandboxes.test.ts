import 'fake-indexeddb/auto';
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref as storageRef,
  uploadBytes,
  getBlob,
  deleteObject,
  listAll,
  getMetadata,
} from '../../src/storage/index.js';
import { getAdminStorageSandbox } from '../../src/storage/service.js';
import {
  getDatabase,
  getAdminDatabase,
  get,
  set,
  update,
  remove,
  ref as dbRef,
} from '../../src/database/index.js';

function uniqueDbName(label: string): string {
  return `pyric-soundness-tier1-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

// ═══════════════════════════════════════════════════════════════
// TIER 1: Feature Coverage (Sandboxes)
// ═══════════════════════════════════════════════════════════════

describe('Tier 1: Feature Coverage (Sandboxes)', () => {
  // ─── F5: Closed-by-Default RTDB Sandboxes ─────────────────────
  describe('F5: Closed-by-Default RTDB Sandboxes', () => {
    test('F5.1: RTDB Sandbox - unconfigured database rejects client write with PERMISSION_DENIED', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client-user' }));

      let writeError: unknown = null;
      try {
        await set(dbRef(db, '/unconfigured/write'), 'value');
      } catch (err) {
        writeError = err;
      }
      expect(writeError).toBeInstanceOf(Error);
      expect((writeError as Error).message).toContain('PERMISSION_DENIED');
    });

    test('F5.2: RTDB Sandbox - unconfigured database rejects client read with PERMISSION_DENIED', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client-user' }));

      let readError: unknown = null;
      try {
        await get(dbRef(db, '/unconfigured/read'));
      } catch (err) {
        readError = err;
      }
      expect(readError).toBeInstanceOf(Error);
      expect((readError as Error).message).toContain('PERMISSION_DENIED');
    });

    test('F5.3: RTDB Sandbox - unconfigured database rejects client update with PERMISSION_DENIED', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client-user' }));

      let updateError: unknown = null;
      try {
        await update(dbRef(db, '/unconfigured'), { key: 'val' });
      } catch (err) {
        updateError = err;
      }
      expect(updateError).toBeInstanceOf(Error);
      expect((updateError as Error).message).toContain('PERMISSION_DENIED');
    });

    test('F5.4: RTDB Sandbox - unconfigured database rejects client remove with PERMISSION_DENIED', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client-user' }));

      let removeError: unknown = null;
      try {
        await remove(dbRef(db, '/unconfigured/delete-target'));
      } catch (err) {
        removeError = err;
      }
      expect(removeError).toBeInstanceOf(Error);
      expect((removeError as Error).message).toContain('PERMISSION_DENIED');
    });

    test('F5.5: RTDB Sandbox - unconfigured database allows reading /.info/serverTimeOffset', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client-user' }));

      const snap = await get(dbRef(db, '/.info/serverTimeOffset'));
      expect(snap.val()).toBe(0);
    });

    test('F5.6: RTDB Sandbox - admin database handle bypasses default deny and succeeds on write/read', async () => {
      const sandbox = initializeSandbox();
      const adminDb = getAdminDatabase(sandbox);

      await set(dbRef(adminDb, '/admin/data'), { createdBy: 'admin' });
      const snap = await get(dbRef(adminDb, '/admin/data'));
      expect(snap.val()).toEqual({ createdBy: 'admin' });
    });
  });

  // ─── F6: Closed-by-Default Storage Sandboxes ───────────────────
  describe('F6: Closed-by-Default Storage Sandboxes', () => {
    test('F6.1: Storage Sandbox - unconfigured storage rejects client uploadBytes with storage/unauthorized', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'user1' }), {
        dbName: uniqueDbName('f6-upload'),
      });

      await expect(
        uploadBytes(storageRef(storage, 'test.txt'), new Blob(['data'])),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F6.2: Storage Sandbox - unconfigured storage rejects client getBlob with storage/unauthorized', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'user1' }), {
        dbName: uniqueDbName('f6-getblob'),
      });

      await expect(
        getBlob(storageRef(storage, 'test.txt')),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F6.3: Storage Sandbox - unconfigured storage rejects client deleteObject with storage/unauthorized', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'user1' }), {
        dbName: uniqueDbName('f6-delete'),
      });

      await expect(
        deleteObject(storageRef(storage, 'test.txt')),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F6.4: Storage Sandbox - unconfigured storage rejects client listAll with storage/unauthorized', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'user1' }), {
        dbName: uniqueDbName('f6-list'),
      });

      await expect(
        listAll(storageRef(storage, '')),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F6.5: Storage Sandbox - unconfigured storage rejects client getMetadata with storage/unauthorized', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'user1' }), {
        dbName: uniqueDbName('f6-meta'),
      });

      await expect(
        getMetadata(storageRef(storage, 'test.txt')),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F6.6: Storage Sandbox - admin storage handle bypasses default deny and uploads/downloads successfully', async () => {
      const sandbox = initializeSandbox();
      const dbName = uniqueDbName('f6-admin-bypass');
      const storage = getAdminStorageSandbox(sandbox, { dbName });

      await uploadBytes(storageRef(storage, 'admin-file.txt'), new Blob(['admin-data']));
      const blob = await getBlob(storageRef(storage, 'admin-file.txt'));
      const text = await blob.text();
      expect(text).toBe('admin-data');
    });
  });
});
