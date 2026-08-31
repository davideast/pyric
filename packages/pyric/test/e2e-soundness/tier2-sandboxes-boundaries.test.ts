import 'fake-indexeddb/auto';
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref as storageRef,
  uploadBytes,
  listAll,
  updateMetadata,
} from '../../src/storage/index.js';
import {
  getDatabase,
  get,
  set,
  ref as dbRef,
  sandbox as rtdbSandbox,
  DEFAULT_OPEN_RTDB_RULES,
} from '../../src/database/index.js';

function uniqueDbName(label: string): string {
  return `pyric-soundness-tier2-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

// ═══════════════════════════════════════════════════════════════
// TIER 2: Boundary & Corner Cases (Sandboxes)
// ═══════════════════════════════════════════════════════════════

describe('Tier 2: Boundary & Corner Cases (Sandboxes)', () => {
  // ─── F5: Closed-by-Default RTDB Sandboxes Boundaries ──────────
  describe('F5: Closed-by-Default RTDB Sandboxes Boundaries', () => {
    test('F5.B1: explicitly setting rules to null reverts sandbox to default fail-closed deny', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client' }));

      // Set open rules first
      rtdbSandbox.setRules(db, DEFAULT_OPEN_RTDB_RULES);
      await set(dbRef(db, '/temp'), 'open-data');

      // Now revert to null rules
      rtdbSandbox.setRules(db, null);

      await expect(set(dbRef(db, '/temp'), 'denied-data')).rejects.toThrow('PERMISSION_DENIED');
      await expect(get(dbRef(db, '/temp'))).rejects.toThrow('PERMISSION_DENIED');
    });

    test('F5.B2: deep path write fails closed with PERMISSION_DENIED under default deny', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client' }));

      await expect(set(dbRef(db, '/a/b/c/d/e/f'), 'val')).rejects.toThrow('PERMISSION_DENIED');
    });

    test('F5.B3: root path write fails closed with PERMISSION_DENIED under default deny', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client' }));

      await expect(set(dbRef(db, '/'), { root: true })).rejects.toThrow('PERMISSION_DENIED');
    });

    test('F5.B4: root path read fails closed with PERMISSION_DENIED under default deny', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client' }));

      await expect(get(dbRef(db, '/'))).rejects.toThrow('PERMISSION_DENIED');
    });

    test('F5.B5: /.info/connected succeeds even under default deny', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client' }));

      const snap = await get(dbRef(db, '/.info/connected'));
      // In sandbox, connected is a boolean
      expect(typeof snap.val()).toBe('boolean');
    });

    test('F5.B6: sandbox isolation: unconfigured sandbox denies while configured sandbox permits', async () => {
      const sandbox1 = initializeSandbox();
      const sandbox2 = initializeSandbox();

      const db1 = getDatabase(sandbox1.withAuth({ uid: 'user' }));
      const db2 = getDatabase(sandbox2.withAuth({ uid: 'user' }));

      rtdbSandbox.setRules(db2, DEFAULT_OPEN_RTDB_RULES);

      await expect(set(dbRef(db1, '/data'), 1)).rejects.toThrow('PERMISSION_DENIED');
      await expect(set(dbRef(db2, '/data'), 1)).resolves.toBeUndefined();
    });
  });

  // ─── F6: Closed-by-Default Storage Sandboxes Boundaries ────────
  describe('F6: Closed-by-Default Storage Sandboxes Boundaries', () => {
    test('F6.B1: unconfigured storage rejects root file upload', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'u1' }), {
        dbName: uniqueDbName('f6-b1-root'),
      });

      await expect(
        uploadBytes(storageRef(storage, 'root.bin'), new Blob(['binary'])),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F6.B2: unconfigured storage rejects deeply nested file upload', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'u1' }), {
        dbName: uniqueDbName('f6-b2-deep'),
      });

      await expect(
        uploadBytes(storageRef(storage, 'a/b/c/d/e/file.bin'), new Blob(['binary'])),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F6.B3: unconfigured storage rejects empty prefix listAll', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'u1' }), {
        dbName: uniqueDbName('f6-b3-list'),
      });

      await expect(listAll(storageRef(storage, ''))).rejects.toThrow(/unauthorized/);
    });

    test('F6.B4: unconfigured storage rejects updateMetadata', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'u1' }), {
        dbName: uniqueDbName('f6-b4-meta'),
      });

      await expect(
        updateMetadata(storageRef(storage, 'file.txt'), { customMetadata: { key: 'val' } }),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F6.B5: anonymous client against unconfigured storage is rejected', async () => {
      const sandbox = initializeSandbox();
      const storage = getStorageSandbox(sandbox.withAuth(null), {
        dbName: uniqueDbName('f6-b5-anon'),
      });

      await expect(
        uploadBytes(storageRef(storage, 'anon.txt'), new Blob(['data'])),
      ).rejects.toThrow(/unauthorized/);
    });

    test('F6.B6: multi-storage isolation: unconfigured denies while configured instance allows', async () => {
      const sandbox1 = initializeSandbox();
      const sandbox2 = initializeSandbox();

      const openRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`;
      const storage1 = getStorageSandbox(sandbox1.withAuth({ uid: 'u1' }), {
        dbName: uniqueDbName('f6-b6-unconfigured'),
      });
      const storage2 = getStorageSandbox(sandbox2.withAuth({ uid: 'u1' }), {
        dbName: uniqueDbName('f6-b6-configured'),
        rules: openRules,
      });

      await expect(
        uploadBytes(storageRef(storage1, 'f.txt'), new Blob(['data'])),
      ).rejects.toThrow(/unauthorized/);

      await expect(
        uploadBytes(storageRef(storage2, 'f.txt'), new Blob(['data'])),
      ).resolves.toBeDefined();
    });
  });
});
