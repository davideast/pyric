import 'fake-indexeddb/auto';
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import { normalizeDocumentPath } from '../../src/rules/simulator/document-lookups.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';
import {
  getStorageSandbox,
  ref as storageRef,
  uploadBytes,
  getBlob,
} from '../../src/storage/index.js';
import { DataSnapshot, evaluateRtdbExpression } from '../../src/rules/rtdb/grammar/simulator.js';
import { SimulateHandler } from '../../src/rules/rtdb/simulation/handler.js';
import { compileRtdbRules } from '../../src/rules/rtdb/compiled-rules.js';
import {
  getDatabase,
  getAdminDatabase,
  get,
  set,
  update,
  ref as dbRef,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';

function uniqueDbName(label: string): string {
  return `pyric-soundness-tier3-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

// ═══════════════════════════════════════════════════════════════
// TIER 3: Cross-Feature Combinations (Pairwise Interactions)
// ═══════════════════════════════════════════════════════════════

describe('Tier 3: Cross-Feature Combinations', () => {

  // ─── Combination 1: F1 (Unary NOT) + F4 (Path Canonicalization) ─
  describe('Combination F1 + F4: Strict Unary NOT with Canonical Document Lookups', () => {
    const firestoreHandler = new SimulateFirestoreRulesHandler();

    test('F1+F4.1: Negated exists() lookup on canonicalized relative path allows when target does not exist', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /content/{docId} {
      allow read: if !exists(/databases/$(database)/documents/users/alice/../banned/$(request.auth.uid));
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'negated exists on non-existent document',
        expectation: 'ALLOW',
        method: 'get',
        path: 'content/article1',
        auth: { uid: 'good-user', token: {} },
        functionMocks: [{
          function: 'exists',
          path: 'banned/good-user',
          result: false,
        }],
      }]);

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('ALLOW');
      }
    });

    test('F1+F4.2: Negated exists() lookup on canonicalized relative path denies when target exists', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /content/{docId} {
      allow read: if !exists(/databases/$(database)/documents/users/alice/../banned/$(request.auth.uid));
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'negated exists on existing banned doc',
        expectation: 'DENY',
        method: 'get',
        path: 'content/article1',
        auth: { uid: 'banned-user', token: {} },
        functionMocks: [{
          function: 'exists',
          path: 'banned/banned-user',
          result: true,
        }],
      }]);

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });

    test('F1+F4.3: Unary NOT on non-boolean field from relative get() lookup fails closed (DENY)', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /content/{docId} {
      allow read: if !get(/databases/$(database)/documents/users/alice/../roles/$(request.auth.uid)).data.restricted;
    }
  }
}`;
      // When `restricted` is a string "yes" rather than boolean, ! throws EvalError
      const res = firestoreHandler.simulate(rules, [{
        description: 'non-boolean field negation',
        expectation: 'DENY',
        method: 'get',
        path: 'content/article1',
        auth: { uid: 'user-with-string-field', token: {} },
        functionMocks: [{
          function: 'get',
          path: 'roles/user-with-string-field',
          result: { restricted: 'yes' },
        }],
      }]);

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });
  });

  // ─── Combination 2: F1 (Unary NOT) + F2 (Virtual Path Hierarchy) ─
  describe('Combination F1 + F2: Unary NOT with DataSnapshot Virtual Path Hierarchy', () => {
    test('F1+F2.1: Negation of parent exists check on missing virtual path evaluates to true', () => {
      const rootData = { otherData: true };
      const ctx = {
        auth: { uid: 'u1', token: {} },
        data: new DataSnapshot(null, '/', rootData),
        newData: new DataSnapshot(null, '/', rootData),
        root: new DataSnapshot(rootData, '/', rootData),
        now: Date.now(),
        pathVariableBindings: {},
      };

      // Since data.child('missing/a/b').parent().exists() is false,
      // its negation !... must evaluate to true.
      // (In buggy version, parent collapsed to root which existed, so !true evaluated to false).
      const expr = "!data.child('missing/a/b').parent().exists()";
      const result = evaluateRtdbExpression(expr, ctx);
      expect(result).toBe(true);
    });

    test('F1+F2.2: Negation of existing child parent check evaluates to false', () => {
      const rootData = { parentNode: { childNode: 123 } };
      const ctx = {
        auth: { uid: 'u1', token: {} },
        data: new DataSnapshot(rootData, '/', rootData),
        newData: new DataSnapshot(rootData, '/', rootData),
        root: new DataSnapshot(rootData, '/', rootData),
        now: Date.now(),
        pathVariableBindings: {},
      };

      const expr = "!data.child('parentNode/childNode').parent().exists()";
      const result = evaluateRtdbExpression(expr, ctx);
      expect(result).toBe(false);
    });
  });

  // ─── Combination 3: F2 (Virtual Path) + F3 (Multi-Path Validation) ─
  describe('Combination F2 + F3: Multi-Path Updates with Virtual Snapshot Parent Navigation', () => {
    const handler = new SimulateHandler();

    test('F2+F3.1: Multi-path update deleting a node while sibling validates via multi-level parent() fails closed', () => {
      const rules = compileRtdbRules({
        rules: {
          workspaces: {
            $wsId: {
              ".write": "auth != null",
              metadata: {
                owner: { ".validate": "newData.isString()" },
              },
              channels: {
                $channelId: {
                  ".validate": "newData.parent().parent().child('metadata/owner').exists()",
                },
              },
            },
          },
        },
      });

      // Attempting to delete metadata while creating or maintaining a channel
      const result = handler.execute(rules, {
        operation: 'write',
        path: '/workspaces/ws1',
        auth: { uid: 'u1', token: {} },
        mockData: {
          workspaces: {
            ws1: {
              metadata: { owner: 'alice' },
              channels: { c1: { name: 'general' } },
            },
          },
        },
        newData: {
          // metadata deleted
          channels: { c1: { name: 'general' } },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed).toBe(false);
      }
    });

    test('F2+F3.2: Multi-path write preserving multi-level parent relation passes validation', () => {
      const rules = compileRtdbRules({
        rules: {
          workspaces: {
            $wsId: {
              ".write": "auth != null",
              metadata: {
                owner: { ".validate": "newData.isString()" },
              },
              channels: {
                $channelId: {
                  ".validate": "newData.parent().parent().child('metadata/owner').exists()",
                },
              },
            },
          },
        },
      });

      const result = handler.execute(rules, {
        operation: 'write',
        path: '/workspaces/ws1',
        auth: { uid: 'u1', token: {} },
        mockData: {},
        newData: {
          metadata: { owner: 'alice' },
          channels: { c1: { name: 'general' } },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed).toBe(true);
      }
    });
  });

  // ─── Combination 4: F1 (Unary NOT) + F5 (Closed-by-Default RTDB) ──
  describe('Combination F1 + F5: RTDB Sandbox Lifecycle from Default Deny to Strict Rules', () => {
    test('F1+F5.1: Unconfigured RTDB denies write; configuring strict unary rules allows valid boolean and denies invalid', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client' }));

      // Phase 1: Unconfigured -> PERMISSION_DENIED
      await expect(set(dbRef(db, '/status'), { active: true })).rejects.toThrow('PERMISSION_DENIED');

      // Phase 2: Load rules requiring !auth.token.banned
      rtdbSandbox.setRules(db, {
        rules: {
          status: {
            ".read": true,
            ".write": "auth != null && !auth.token.banned",
          },
        },
      });

      // User with banned == false -> ALLOW
      const allowedDb = getDatabase(sandbox.withAuth({ uid: 'client', token: { banned: false } }));
      await set(dbRef(allowedDb, '/status'), { active: true });
      const snap = await get(dbRef(allowedDb, '/status'));
      expect(snap.val()).toEqual({ active: true });

      // User with banned == true -> DENY
      const deniedDb = getDatabase(sandbox.withAuth({ uid: 'client', token: { banned: true } }));
      await expect(set(dbRef(deniedDb, '/status'), { active: false })).rejects.toThrow('PERMISSION_DENIED');
    });
  });

  // ─── Combination 5: F1 (Unary NOT) + F6 (Closed-by-Default Storage) ─
  describe('Combination F1 + F6: Storage Lifecycle from Default Deny to Strict Rules', () => {
    test('F1+F6.1: Storage transitions from default deny to configured rules with strict negation on token claims', async () => {
      const sandbox = initializeSandbox();
      const dbName = uniqueDbName('f1-f6-storage');

      // Step 1: Unconfigured -> throws storage/unauthorized
      const unconfigured = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { dbName });
      await expect(
        uploadBytes(storageRef(unconfigured, 'file.txt'), new Blob(['hello'])),
      ).rejects.toThrow(/unauthorized/);

      // Step 2: Configure rules enforcing !request.auth.token.revoked
      const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow write: if request.auth != null && !request.auth.token.revoked;
    }
  }
}`;
      const goodUserStorage = getStorageSandbox(sandbox.withAuth({ uid: 'alice', token: { revoked: false } }), {
        dbName,
        rules,
      });
      await uploadBytes(storageRef(goodUserStorage, 'file.txt'), new Blob(['hello']));
      const blob = await getBlob(storageRef(goodUserStorage, 'file.txt'));
      expect(await blob.text()).toBe('hello');

      // Missing claim `revoked` -> strict NOT fails closed
      const missingClaimStorage = getStorageSandbox(sandbox.withAuth({ uid: 'bob', token: {} }), {
        dbName,
        rules,
      });
      await expect(
        uploadBytes(storageRef(missingClaimStorage, 'file.txt'), new Blob(['hacked'])),
      ).rejects.toThrow(/unauthorized/);
    });
  });

  // ─── Combination 6: F3 (Multi-Path Update) + F5 (RTDB Admin Bypass) ─
  describe('Combination F3 + F5: Admin Seeding under Default Deny followed by Sibling Invariant Checks', () => {
    test('F3+F5.1: Admin seeds data tree under default deny; client update deleting required field is denied', async () => {
      const sandbox = initializeSandbox();
      const adminDb = getAdminDatabase(sandbox);

      // Admin seeds data despite no rules loaded yet
      await set(dbRef(adminDb, '/inventory/item1'), {
        sku: 'SKU-001',
        stock: 50,
      });

      // Configure rules that require sku to exist for stock to be valid
      const db = getDatabase(sandbox.withAuth({ uid: 'worker' }));
      rtdbSandbox.setRules(db, {
        rules: {
          inventory: {
            $id: {
              ".read": true,
              ".write": "auth != null",
              sku: { ".validate": "newData.isString()" },
              stock: { ".validate": "newData.parent().child('sku').exists() && newData.isNumber()" },
            },
          },
        },
      });

      // Client tries multi-path update deleting sku while stock remains
      let updateError: unknown = null;
      try {
        await update(dbRef(db, '/inventory/item1'), {
          sku: null,
        });
      } catch (err) {
        updateError = err;
      }

      expect(updateError).toBeInstanceOf(Error);
      expect((updateError as Error).message).toContain('PERMISSION_DENIED');
    });
  });

  // ─── Combination 7: F4 (Path Canonicalization) + F6 (Cross-Service Storage Lookup) ─
  describe('Combination F4 + F6: Storage Rules Cross-Service Firestore Lookups with Relative Paths', () => {
    test('F4+F6.1: Storage rule using firestore.get() with .. relative traversal to authorize upload', async () => {
      const sandbox = initializeSandbox({});
      // Seed Firestore document
      sandbox.admin.setDocument('configs/features', { allowUploads: true });

      const rulesSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow write: if firestore.get(/databases/(default)/documents/users/alice/../configs/features).data.allowUploads == true;
    }
  }
}`;
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName: uniqueDbName('f4-f6-cross-service'),
        rules: rulesSource,
      });

      await uploadBytes(storageRef(storage, 'uploads/doc.pdf'), new Blob(['pdf-data']));
      const blob = await getBlob(storageRef(storage, 'uploads/doc.pdf'));
      expect(await blob.text()).toBe('pdf-data');
    });

    test('F4+F6.2: Storage rule with negated cross-service lookup fails closed when target field is non-boolean', async () => {
      const sandbox = initializeSandbox({});
      // Seed Firestore document with non-boolean
      sandbox.admin.setDocument('configs/features', { allowUploads: 'string-truthy' });

      const rulesSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow write: if !firestore.get(/databases/(default)/documents/users/alice/../configs/features).data.allowUploads;
    }
  }
}`;
      const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
        dbName: uniqueDbName('f4-f6-cross-service-neg'),
        rules: rulesSource,
      });

      await expect(
        uploadBytes(storageRef(storage, 'uploads/doc.pdf'), new Blob(['pdf-data'])),
      ).rejects.toThrow(/unauthorized/);
    });
  });
});
