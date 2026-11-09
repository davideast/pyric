import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { getAdminDatabase, get as databaseGet, ref as databaseRef, set as databaseSet, sandbox as rtdbSandbox } from 'pyric/database';
import { getActiveRules as getActiveDatabaseRules } from 'pyric/sandbox/database';
import { getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox, replaceStorageRules } from 'pyric/storage/internal';

import { createSurfaceContext } from '../../../../../src/bridge/surface/context.js';
import resetMethod from '../../../../../src/bridge/surface/methods/sandbox/reset.js';

describe('sandbox.reset', () => {
  it('preserves active Firestore, RTDB, and Storage security rules across scope: "all"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-reset-rules-'));
    try {
      const sandbox = initializeSandbox();
      setFirestoreRules(
        sandbox,
        `rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /items/{id} { allow read, write: if false; } } }`,
      );
      rtdbSandbox.setRules(getAdminDatabase(sandbox), { rules: { '.read': false, '.write': false } });
      getAdminStorageSandbox(sandbox);
      await replaceStorageRules(
        sandbox,
        `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if false; } } }`,
        {},
      );

      const ctx = createSurfaceContext(sandbox, dir);
      const outcome = await resetMethod.handler({ confirm: true, scope: 'all' }, ctx);
      expect(outcome.ok).toBe(true);

      const anonSandbox = sandbox.withAuth(null);
      await expect(setDoc(doc(getFirestore(anonSandbox), 'items/a'), { v: 1 })).rejects.toThrow();
      await expect(
        uploadBytes(storageRef(getStorageSandbox(anonSandbox), 'docs/a.txt'), new Uint8Array([1])),
      ).rejects.toThrow();
      expect(getActiveDatabaseRules(getAdminDatabase(sandbox))).toEqual({
        rules: { '.read': false, '.write': false },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears named Realtime Database instances alongside the default instance on scope: "database"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-reset-named-rtdb-'));
    try {
      writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));
      writeFileSync(join(dir, 'database.rules.json'), JSON.stringify({ rules: { '.read': false, '.write': false } }));
      writeFileSync(
        join(dir, 'firebase.json'),
        JSON.stringify({
          database: [
            { instance: 'demo-proj-default-rtdb', rules: 'database.rules.json' },
            { instance: 'secondary-rtdb', rules: 'database.rules.json' },
          ],
        }),
      );

      const sandbox = initializeSandbox();
      await databaseSet(databaseRef(getAdminDatabase(sandbox), 'items/default'), { count: 1 });
      await databaseSet(databaseRef(getAdminDatabase(sandbox, 'secondary-rtdb'), 'items/named'), { count: 2 });

      const ctx = createSurfaceContext(sandbox, dir);
      const outcome = await resetMethod.handler({ confirm: true, scope: 'database' }, ctx);
      expect(outcome.ok).toBe(true);

      const defaultSnap = await databaseGet(databaseRef(getAdminDatabase(sandbox), 'items/default'));
      const namedSnap = await databaseGet(databaseRef(getAdminDatabase(sandbox, 'secondary-rtdb'), 'items/named'));
      expect(defaultSnap.exists()).toBe(false);
      expect(namedSnap.exists()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
