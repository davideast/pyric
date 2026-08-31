import 'fake-indexeddb/auto';
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import { normalizeDocumentPath, resolveGet, resolveExists } from '../../src/rules/simulator/document-lookups.js';
import { evaluate, type SimulationContext } from '../../src/rules/simulator/evaluator.js';
import { EvalError } from '../../src/rules/simulator/eval-error.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';
import { RuleEvalError } from '../../src/storage/sandbox/rules-evaluation-error.js';
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
import { DataSnapshot, evaluateRtdbExpression } from '../../src/rules/rtdb/grammar/simulator.js';
import { SimulateHandler } from '../../src/rules/rtdb/simulation/handler.js';
import { compileRtdbRules } from '../../src/rules/rtdb/compiled-rules.js';
import {
  getDatabase,
  getAdminDatabase,
  get,
  set,
  update,
  remove,
  ref as dbRef,
  sandbox as rtdbSandbox,
  DEFAULT_OPEN_RTDB_RULES,
} from '../../src/database/index.js';

function uniqueDbName(label: string): string {
  return `pyric-soundness-tier1-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

// ═══════════════════════════════════════════════════════════════
// TIER 1: Feature Coverage (Equivalence Classes)
// ═══════════════════════════════════════════════════════════════

describe('Tier 1: Feature Coverage', () => {

  // ─── F1: Strict Unary NOT Type Checking ───────────────────────
  describe('F1: Strict Unary NOT Type Checking', () => {
    const firestoreHandler = new SimulateFirestoreRulesHandler();

    test('F1.1: Firestore - boolean operand !true evaluates to false (DENY)', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{item} {
      allow read: if !true;
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'unary not true',
        expectation: 'DENY',
        method: 'get',
        path: 'items/1',
      }]);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });

    test('F1.2: Firestore - boolean operand !false evaluates to true (ALLOW)', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{item} {
      allow read: if !false;
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'unary not false',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/1',
      }]);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('ALLOW');
      }
    });

    test('F1.3: Firestore - missing property / undefined claim (!request.auth.token.admin) throws and fails closed (DENY)', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /secure/{docId} {
      allow read: if !request.auth.token.admin;
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'missing admin claim negated',
        expectation: 'DENY',
        method: 'get',
        path: 'secure/doc1',
        auth: { uid: 'regular-user', token: {} },
      }]);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });

    test('F1.4: Firestore - string operand (!"admin") throws EvalError and fails closed (DENY)', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /secure/{docId} {
      allow read: if !"admin";
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'string negation',
        expectation: 'DENY',
        method: 'get',
        path: 'secure/doc1',
      }]);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });

    test('F1.5: Firestore - null operand throws EvalError and fails closed (DENY)', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /secure/{docId} {
      allow read: if !(resource.data.missingField);
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'missing field negation',
        expectation: 'DENY',
        method: 'get',
        path: 'secure/doc1',
        resource: { existingField: 123 },
      }]);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });

    test('F1.6: Storage - boolean operand !false evaluates to true (ALLOW) and !true to false (DENY)', () => {
      const rulesSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /allow-path/{file} {
      allow read: if !false;
    }
    match /deny-path/{file} {
      allow read: if !true;
    }
  }
}`;
      const parsed = parseStorageRules(rulesSource);
      const allowRes = evaluateStorageRules(parsed, {
        request: { method: 'get', path: '/b/bucket/o/allow-path/test.txt', auth: null },
      });
      expect(allowRes.allowed).toBe(true);

      const denyRes = evaluateStorageRules(parsed, {
        request: { method: 'get', path: '/b/bucket/o/deny-path/test.txt', auth: null },
      });
      expect(denyRes.allowed).toBe(false);
    });

    test('F1.7: Storage - missing property / undefined claim (!request.auth.token.admin) throws RuleEvalError and DENIES', () => {
      const rulesSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /secure/{file} {
      allow read: if !request.auth.token.admin;
    }
  }
}`;
      const parsed = parseStorageRules(rulesSource);
      const res = evaluateStorageRules(parsed, {
        request: {
          method: 'get',
          path: '/b/bucket/o/secure/data.bin',
          auth: { uid: 'alice', token: {} },
        },
      });
      expect(res.allowed).toBe(false);
    });

    test('F1.8: Storage - string / number operand (!"text", !0) throws RuleEvalError and DENIES', () => {
      const rulesSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /string-op/{file} {
      allow read: if !"hello";
    }
    match /num-op/{file} {
      allow read: if !0;
    }
  }
}`;
      const parsed = parseStorageRules(rulesSource);
      const strRes = evaluateStorageRules(parsed, {
        request: { method: 'get', path: '/b/bucket/o/string-op/file.txt', auth: null },
      });
      expect(strRes.allowed).toBe(false);

      const numRes = evaluateStorageRules(parsed, {
        request: { method: 'get', path: '/b/bucket/o/num-op/file.txt', auth: null },
      });
      expect(numRes.allowed).toBe(false);
    });
  });

  // ─── F2: Virtual Path Hierarchy in DataSnapshot ───────────────
  describe('F2: Virtual Path Hierarchy in DataSnapshot', () => {
    test('F2.1: child() preserves full virtual path across non-existent nodes', () => {
      const rootData = { users: { alice: { age: 30 } } };
      const snap = new DataSnapshot(null, '/', rootData);
      const childSnap = snap.child('a/b/c');

      expect(childSnap.val()).toBeNull();
      expect(childSnap.exists()).toBe(false);
      expect((childSnap as unknown as { _path: string })._path).toBe('/a/b/c');
    });

    test('F2.2: chained parent() traverses upward through missing virtual hierarchy', () => {
      const rootData = { existing: 'yes' };
      const snap = new DataSnapshot(null, '/', rootData);
      const deepSnap = snap.child('missing/child/leaf');

      expect((deepSnap as unknown as { _path: string })._path).toBe('/missing/child/leaf');

      const parent1 = deepSnap.parent();
      expect(parent1).not.toBeNull();
      expect((parent1 as unknown as { _path: string })._path).toBe('/missing/child');
      expect(parent1!.exists()).toBe(false);

      const parent2 = parent1!.parent();
      expect(parent2).not.toBeNull();
      expect((parent2 as unknown as { _path: string })._path).toBe('/missing');
      expect(parent2!.exists()).toBe(false);

      const parent3 = parent2!.parent();
      expect(parent3).not.toBeNull();
      expect((parent3 as unknown as { _path: string })._path).toBe('/');
      expect(parent3!.exists()).toBe(true); // Root node exists
    });

    test('F2.3: parent() on child of non-existent node returns exists() === false', () => {
      const rootData = { rootItem: 'present' };
      const rootSnap = new DataSnapshot(rootData, '/', rootData);

      const missingChild = rootSnap.child('ghost/branch/node');
      const missingParent = missingChild.parent();

      expect(missingParent).not.toBeNull();
      expect(missingParent!.exists()).toBe(false);
      expect((missingParent as unknown as { _path: string })._path).toBe('/ghost/branch');
    });

    test('F2.4: parent() traversal terminates cleanly at root and returns null on root parent()', () => {
      const rootSnap = new DataSnapshot({ data: true }, '/', { data: true });
      expect(rootSnap.parent()).toBeNull();

      const leaf = rootSnap.child('single');
      const backToRoot = leaf.parent();
      expect(backToRoot).not.toBeNull();
      expect((backToRoot as unknown as { _path: string })._path).toBe('/');
      expect(backToRoot!.parent()).toBeNull();
    });

    test('F2.5: navigation through existing nested nodes preserves valid values and paths', () => {
      const mockData = {
        company: {
          engineering: {
            team: 'core',
          },
        },
      };
      const rootSnap = new DataSnapshot(mockData, '/', mockData);
      const teamSnap = rootSnap.child('company/engineering/team');
      expect(teamSnap.val()).toBe('core');
      expect(teamSnap.exists()).toBe(true);
      expect((teamSnap as unknown as { _path: string })._path).toBe('/company/engineering/team');

      const engSnap = teamSnap.parent();
      expect(engSnap).not.toBeNull();
      expect(engSnap!.exists()).toBe(true);
      expect((engSnap as unknown as { _path: string })._path).toBe('/company/engineering');
      expect(engSnap!.val()).toEqual({ team: 'core' });
    });

    test('F2.6: RTDB expression rule checking parent existence on missing child evaluates to false (DENY)', () => {
      const ctx = {
        auth: { uid: 'user1', token: {} },
        data: new DataSnapshot(null, '/', { rootData: true }),
        newData: new DataSnapshot(null, '/', { rootData: true }),
        root: new DataSnapshot({ rootData: true }, '/', { rootData: true }),
        now: Date.now(),
        pathVariableBindings: {},
      };
      // In buggy version, data.child('missing/a/b').parent() prematurely collapsed to root ('/'),
      // which has rootData, so exists() was true! In production parity, it must evaluate to false.
      const result = evaluateRtdbExpression("data.child('missing/a/b').parent().exists()", ctx);
      expect(result).toBe(false);
    });
  });

  // ─── F3: Multi-Path RTDB Deletion Validation ───────────────────
  describe('F3: Multi-Path RTDB Deletion Validation', () => {
    const handler = new SimulateHandler();

    test('F3.1: RTDB Simulator - multi-path write deleting required sibling field fails .validate and DENIES', () => {
      const rules = compileRtdbRules({
        rules: {
          catalog: {
            $itemId: {
              ".write": "auth != null",
              title: {
                ".validate": "newData.isString()",
              },
              price: {
                ".validate": "newData.parent().child('title').exists() && newData.isNumber()",
              },
            },
          },
        },
      });

      // Attempting to delete `title` while `price` exists in mockData
      const result = handler.execute(rules, {
        operation: 'write',
        path: '/catalog/item1',
        auth: { uid: 'admin-user', token: {} },
        mockData: {
          catalog: {
            item1: {
              title: 'Widget',
              price: 100,
            },
          },
        },
        newData: {
          // title is deleted (omitted), price remains
          price: 100,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed).toBe(false);
      }
    });

    test('F3.2: RTDB Simulator - multi-path write preserving required sibling field passes .validate and ALLOWS', () => {
      const rules = compileRtdbRules({
        rules: {
          catalog: {
            $itemId: {
              ".write": "auth != null",
              title: {
                ".validate": "newData.isString()",
              },
              price: {
                ".validate": "newData.parent().child('title').exists() && newData.isNumber()",
              },
            },
          },
        },
      });

      const result = handler.execute(rules, {
        operation: 'write',
        path: '/catalog/item1',
        auth: { uid: 'admin-user', token: {} },
        mockData: {
          catalog: {
            item1: {
              title: 'Widget',
              price: 100,
            },
          },
        },
        newData: {
          title: 'Widget Updated',
          price: 120,
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed).toBe(true);
      }
    });

    test('F3.3: RTDB Simulator - subtree deletion violating sibling parent validate fails closed', () => {
      const rules = compileRtdbRules({
        rules: {
          entities: {
            $id: {
              ".write": "auth != null",
              header: {
                ".validate": "newData.parent().child('payload').exists()",
              },
              payload: {
                ".validate": "newData.isString()",
              },
            },
          },
        },
      });

      const result = handler.execute(rules, {
        operation: 'write',
        path: '/entities/e1/payload',
        auth: { uid: 'user1', token: {} },
        mockData: {
          entities: {
            e1: {
              header: { status: 'active' },
              payload: 'content',
            },
          },
        },
        newData: null, // deleting payload
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed).toBe(false);
      }
    });

    test('F3.4: RTDB Simulator - collection/wildcard multi-path delete enforcing sibling invariants fails closed', () => {
      const rules = compileRtdbRules({
        rules: {
          profiles: {
            $uid: {
              ".write": "auth != null",
              name: {
                ".validate": "newData.isString()",
              },
              verified: {
                ".validate": "newData.parent().child('name').exists()",
              },
            },
          },
        },
      });

      const result = handler.execute(rules, {
        operation: 'write',
        path: '/profiles/u1',
        auth: { uid: 'u1', token: {} },
        mockData: {
          profiles: {
            u1: {
              name: 'Alice',
              verified: true,
            },
          },
        },
        newData: {
          verified: true,
          // name deleted
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed).toBe(false);
      }
    });

    test('F3.5: RTDB WritePlane - update() deleting a required sibling is rejected with PERMISSION_DENIED', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client-user' }));

      rtdbSandbox.setRules(db, {
        rules: {
          docs: {
            $docId: {
              ".read": true,
              ".write": "auth != null",
              meta: {
                ".validate": "newData.parent().child('content').exists()",
              },
              content: {
                ".validate": "newData.isString()",
              },
            },
          },
        },
      });

      const adminDb = getAdminDatabase(sandbox);
      await set(dbRef(adminDb, '/docs/doc1'), {
        meta: 'info',
        content: 'hello',
      });

      // Now client attempts shallow or deep update deleting content while meta survives
      let updateError: unknown = null;
      try {
        await update(dbRef(db, '/docs/doc1'), {
          content: null,
        });
      } catch (err) {
        updateError = err;
      }

      expect(updateError).toBeInstanceOf(Error);
      expect((updateError as Error).message).toContain('PERMISSION_DENIED');
    });

    test('F3.6: RTDB WritePlane - update() modifying non-required fields while preserving siblings succeeds', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client-user' }));

      rtdbSandbox.setRules(db, {
        rules: {
          docs: {
            $docId: {
              ".read": true,
              ".write": "auth != null",
              meta: {
                ".validate": "newData.parent().child('content').exists()",
              },
              content: {
                ".validate": "newData.isString()",
              },
            },
          },
        },
      });

      const adminDb = getAdminDatabase(sandbox);
      await set(dbRef(adminDb, '/docs/doc1'), {
        meta: 'info',
        content: 'hello',
      });

      await update(dbRef(db, '/docs/doc1'), {
        content: 'world',
      });

      const snap = await get(dbRef(db, '/docs/doc1/content'));
      expect(snap.val()).toBe('world');
    });
  });

  // ─── F4: Document Path Canonicalization & Root Clamping ───────
  describe('F4: Document Path Canonicalization & Root Clamping', () => {
    const firestoreHandler = new SimulateFirestoreRulesHandler();

    test('F4.1: normalizeDocumentPath resolves single and multiple relative .. segments', () => {
      expect(normalizeDocumentPath('/databases/(default)/documents/users/alice/../bob')).toBe('users/bob');
      expect(normalizeDocumentPath('/databases/(default)/documents/users/alice/settings/../profile')).toBe('users/alice/profile');
    });

    test('F4.2: normalizeDocumentPath resolves relative . current-directory segments', () => {
      expect(normalizeDocumentPath('/databases/(default)/documents/users/./alice')).toBe('users/alice');
      expect(normalizeDocumentPath('/databases/$(database)/documents/orgs/./team/./doc1')).toBe('orgs/team/doc1');
    });

    test('F4.3: normalizeDocumentPath clamps traversal at document root when excessive .. are present', () => {
      // Relative segments must not escape root
      const clamped = normalizeDocumentPath('/databases/(default)/documents/../../users/alice');
      expect(clamped).toBe('users/alice');
    });

    test('F4.4: normalizeDocumentPath rejects or throws on odd-parity path (collection instead of document)', () => {
      // Document lookups require an even number of segments (collection/doc)
      let threw = false;
      try {
        const path = normalizeDocumentPath('/databases/(default)/documents/users');
        // If it returns a path without throwing, resolveGet must reject it as non-document
        const ctx = {
          mockDocuments: new Map(),
        } as unknown as SimulationContext;
        resolveGet(path, ctx);
      } catch (err) {
        threw = true;
        expect(err).toBeInstanceOf(EvalError);
      }
      expect(threw).toBe(true);
    });

    test('F4.5: Firestore Simulator - document get() with .. relative traversal accesses canonical target', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow read: if get(/databases/$(database)/documents/users/alice/../bob).data.active == true;
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'relative path get()',
        expectation: 'ALLOW',
        method: 'get',
        path: 'posts/p1',
        functionMocks: [{
          function: 'get',
          path: 'users/bob',
          result: { active: true },
        }],
      }]);

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('ALLOW');
      }
    });

    test('F4.6: Firestore Simulator - document exists() cannot escape collection root with excessive ..', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /public/{docId} {
      allow read: if exists(/databases/$(database)/documents/../../../../secrets/secret1);
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'clamped root exists()',
        expectation: 'ALLOW',
        method: 'get',
        path: 'public/doc1',
        functionMocks: [{
          function: 'exists',
          path: 'secrets/secret1', // root-clamped path
          result: true,
        }],
      }]);

      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('ALLOW');
      }
    });
  });

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
