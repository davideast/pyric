import 'fake-indexeddb/auto';
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import { normalizeDocumentPath, resolveGet, resolveExists } from '../../src/rules/simulator/document-lookups.js';
import { EvalError } from '../../src/rules/simulator/eval-error.js';
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

describe('Tier 1: Feature Coverage (Paths & Deletion Validation)', () => {
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
});
