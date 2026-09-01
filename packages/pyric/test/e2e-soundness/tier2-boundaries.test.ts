import 'fake-indexeddb/auto';
import { describe, test, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import { normalizeDocumentPath, resolveGet } from '../../src/rules/simulator/document-lookups.js';
import { EvalError } from '../../src/rules/simulator/eval-error.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';
import { DataSnapshot } from '../../src/rules/rtdb/grammar/simulator.js';
import { SimulateHandler } from '../../src/rules/rtdb/simulation/handler.js';
import { compileRtdbRules } from '../../src/rules/rtdb/compiled-rules.js';
import {
  getDatabase,
  getAdminDatabase,
  set,
  update,
  ref as dbRef,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';

// ═══════════════════════════════════════════════════════════════
// TIER 2: Boundary & Corner Cases
// ═══════════════════════════════════════════════════════════════

describe('Tier 2: Boundary & Corner Cases', () => {

  // ─── F1: Boundary & Adversarial Unary Negation ────────────────
  describe('F1: Boundary & Adversarial Unary Negation', () => {
    const firestoreHandler = new SimulateFirestoreRulesHandler();

    test('F1.B1: Firestore - empty string negation (!"") throws EvalError and fails closed (DENY)', () => {
      // In JS, !"" is true. In production rules, it MUST throw EvalError and DENY.
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow read: if !"";
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'empty string negation',
        expectation: 'DENY',
        method: 'get',
        path: 'test/doc1',
      }]);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });

    test('F1.B2: Firestore - number 0 negation (!(0)) throws EvalError and fails closed (DENY)', () => {
      // In JS, !0 is true. In production rules, it MUST throw EvalError and DENY.
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow read: if !(0);
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'number zero negation',
        expectation: 'DENY',
        method: 'get',
        path: 'test/doc1',
      }]);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });

    test('F1.B3: Firestore - list literal negation (!([])) throws EvalError and fails closed (DENY)', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow read: if !([]);
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'list negation',
        expectation: 'DENY',
        method: 'get',
        path: 'test/doc1',
      }]);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });

    test('F1.B4: Firestore - map literal negation (!({})) throws EvalError and fails closed (DENY)', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
      allow read: if !({});
    }
  }
}`;
      const res = firestoreHandler.simulate(rules, [{
        description: 'map negation',
        expectation: 'DENY',
        method: 'get',
        path: 'test/doc1',
      }]);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.results[0].decision).toBe('DENY');
      }
    });

    test('F1.B5: Firestore - double negation on non-boolean (!!null, !!"value") fails closed (DENY)', () => {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test1/{docId} {
      allow read: if !!null;
    }
    match /test2/{docId} {
      allow read: if !!"valid";
    }
  }
}`;
      const res1 = firestoreHandler.simulate(rules, [{
        description: 'double negation null',
        expectation: 'DENY',
        method: 'get',
        path: 'test1/doc1',
      }]);
      expect(res1.success && res1.data.results[0].decision).toBe('DENY');

      const res2 = firestoreHandler.simulate(rules, [{
        description: 'double negation string',
        expectation: 'DENY',
        method: 'get',
        path: 'test2/doc1',
      }]);
      expect(res2.success && res2.data.results[0].decision).toBe('DENY');
    });

    test('F1.B6: Storage - falsy JS operands (!"", !0, !null) all fail closed with RuleEvalError (DENY)', () => {
      const rulesSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /empty-str/{file} {
      allow read: if !"";
    }
    match /zero-num/{file} {
      allow read: if !0;
    }
    match /null-val/{file} {
      allow read: if !null;
    }
  }
}`;
      const parsed = parseStorageRules(rulesSource);

      const resEmpty = evaluateStorageRules(parsed, {
        request: { method: 'get', path: '/b/bucket/o/empty-str/f.txt', auth: null },
      });
      expect(resEmpty.allowed).toBe(false);

      const resZero = evaluateStorageRules(parsed, {
        request: { method: 'get', path: '/b/bucket/o/zero-num/f.txt', auth: null },
      });
      expect(resZero.allowed).toBe(false);

      const resNull = evaluateStorageRules(parsed, {
        request: { method: 'get', path: '/b/bucket/o/null-val/f.txt', auth: null },
      });
      expect(resNull.allowed).toBe(false);
    });
  });

  // ─── F2: Boundary & Traversal Limits in DataSnapshot ──────────
  describe('F2: Boundary & Traversal Limits in DataSnapshot', () => {
    test('F2.B1: navigation through primitive leaf maintains full virtual path and correct parent recovery', () => {
      const rootData = { leaf: 42 };
      const rootSnap = new DataSnapshot(rootData, '/', rootData);
      const deepUnderLeaf = rootSnap.child('leaf/a/b/c');

      expect(deepUnderLeaf.val()).toBeNull();
      expect(deepUnderLeaf.exists()).toBe(false);
      expect((deepUnderLeaf as unknown as { _path: string })._path).toBe('/leaf/a/b/c');

      const parent1 = deepUnderLeaf.parent();
      expect(parent1!.exists()).toBe(false);
      expect((parent1 as unknown as { _path: string })._path).toBe('/leaf/a/b');

      const parent2 = parent1!.parent();
      expect(parent2!.exists()).toBe(false);
      expect((parent2 as unknown as { _path: string })._path).toBe('/leaf/a');

      const parent3 = parent2!.parent();
      expect(parent3!.exists()).toBe(true);
      expect((parent3 as unknown as { _path: string })._path).toBe('/leaf');
      expect(parent3!.val()).toBe(42);
    });

    test('F2.B2: 10-level deep virtual path preserves hierarchy across 10 parent() steps', () => {
      const snap = new DataSnapshot(null, '/', {});
      const deep = snap.child('1/2/3/4/5/6/7/8/9/10');
      expect((deep as unknown as { _path: string })._path).toBe('/1/2/3/4/5/6/7/8/9/10');

      let current: DataSnapshot | null = deep;
      for (let i = 10; i >= 1; i--) {
        expect(current).not.toBeNull();
        expect(current!.exists()).toBe(false);
        current = current!.parent();
      }
      expect(current).not.toBeNull();
      expect((current as unknown as { _path: string })._path).toBe('/');
      expect(current!.parent()).toBeNull();
    });

    test('F2.B3: consecutive slashes in child path normalize cleanly', () => {
      const rootData = { a: { b: { c: 'deep' } } };
      const rootSnap = new DataSnapshot(rootData, '/', rootData);
      const child = rootSnap.child('a///b//c');

      expect(child.val()).toBe('deep');
      expect((child as unknown as { _path: string })._path).toBe('/a/b/c');
    });

    test('F2.B4: leading and trailing slashes in child path normalize cleanly', () => {
      const rootData = { a: { b: { c: 'clean' } } };
      const rootSnap = new DataSnapshot(rootData, '/', rootData);
      const child = rootSnap.child('/a/b/c/');

      expect(child.val()).toBe('clean');
      expect((child as unknown as { _path: string })._path).toBe('/a/b/c');
    });

    test('F2.B5: empty string child path returns self snapshot with unchanged path', () => {
      const rootData = { x: 1 };
      const rootSnap = new DataSnapshot(rootData, '/sub', rootData);
      const child = rootSnap.child('');

      expect((child as unknown as { _path: string })._path).toBe('/sub');
      expect(child.val()).toEqual({ x: 1 });
    });

    test('F2.B6: navigation on empty root snapshot preserves parent links without error', () => {
      const emptySnap = new DataSnapshot(null, '/', null);
      const ghost = emptySnap.child('ghost');
      expect(ghost.exists()).toBe(false);

      const parentOfGhost = ghost.parent();
      expect(parentOfGhost).not.toBeNull();
      expect((parentOfGhost as unknown as { _path: string })._path).toBe('/');
      expect(parentOfGhost!.exists()).toBe(false);
      expect(parentOfGhost!.parent()).toBeNull();
    });
  });

  // ─── F3: Multi-Path Update & Boundary Deletions ────────────────
  describe('F3: Multi-Path Update & Boundary Deletions', () => {
    const handler = new SimulateHandler();

    test('F3.B1: simultaneous deletion of multiple required fields fails parent validate', () => {
      const rules = compileRtdbRules({
        rules: {
          nodes: {
            $nodeId: {
              ".write": "auth != null",
              ".validate": "newData.hasChildren(['reqA', 'reqB'])",
              reqA: { ".validate": "newData.isString()" },
              reqB: { ".validate": "newData.isNumber()" },
            },
          },
        },
      });

      const result = handler.execute(rules, {
        operation: 'write',
        path: '/nodes/n1',
        auth: { uid: 'u1', token: {} },
        mockData: {
          nodes: {
            n1: { reqA: 'ok', reqB: 10 },
          },
        },
        newData: {}, // both deleted
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed).toBe(false);
      }
    });

    test('F3.B2: deeply nested deletion in multi-path write triggers sibling validate failure', () => {
      const rules = compileRtdbRules({
        rules: {
          org: {
            dept: {
              eng: {
                ".write": "auth != null",
                lead: { ".validate": "newData.isString()" },
                status: { ".validate": "newData.parent().child('lead').exists()" },
              },
            },
          },
        },
      });

      const result = handler.execute(rules, {
        operation: 'write',
        path: '/org/dept/eng',
        auth: { uid: 'mgr', token: {} },
        mockData: {
          org: {
            dept: {
              eng: {
                lead: 'alice',
                status: 'active',
              },
            },
          },
        },
        newData: {
          // deleting lead, preserving status
          status: 'active',
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed).toBe(false);
      }
    });

    test('F3.B3: multi-location update setting one field and deleting required sibling fails closed', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client' }));

      rtdbSandbox.setRules(db, {
        rules: {
          records: {
            $rId: {
              ".read": true,
              ".write": "auth != null",
              key: { ".validate": "newData.isString()" },
              signature: { ".validate": "newData.parent().child('key').exists()" },
            },
          },
        },
      });

      const adminDb = getAdminDatabase(sandbox);
      await set(dbRef(adminDb, '/records/rec1'), {
        key: 'secret-key',
        signature: 'valid-sig',
      });

      // Update that updates signature while deleting key
      let updateError: unknown = null;
      try {
        await update(dbRef(db, '/records/rec1'), {
          signature: 'updated-sig',
          key: null,
        });
      } catch (err) {
        updateError = err;
      }

      expect(updateError).toBeInstanceOf(Error);
      expect((updateError as Error).message).toContain('PERMISSION_DENIED');
    });

    test('F3.B4: deleting entire container node when parent requires children fails validation', () => {
      const rules = compileRtdbRules({
        rules: {
          parent: {
            ".write": "auth != null",
            ".validate": "newData.hasChildren()",
            container: {
              ".write": "auth != null",
            },
          },
        },
      });

      const result = handler.execute(rules, {
        operation: 'write',
        path: '/parent/container',
        auth: { uid: 'u1', token: {} },
        mockData: {
          parent: {
            container: { child1: true },
          },
        },
        newData: null, // delete container
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed).toBe(false);
      }
    });

    test('F3.B5: no-op deletion of non-existent child does not trigger sibling failure', () => {
      const rules = compileRtdbRules({
        rules: {
          users: {
            $uid: {
              ".write": "auth != null",
              name: { ".validate": "newData.isString()" },
              optional: { ".validate": "newData.isString()" },
            },
          },
        },
      });

      const result = handler.execute(rules, {
        operation: 'write',
        path: '/users/u1',
        auth: { uid: 'u1', token: {} },
        mockData: {
          users: {
            u1: { name: 'Alice' },
          },
        },
        newData: {
          name: 'Alice',
          optional: null, // was already missing
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed).toBe(true);
      }
    });

    test('F3.B6: atomic multi-path update with root-level slash paths properly evaluates sibling invariants', async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox.withAuth({ uid: 'client' }));

      rtdbSandbox.setRules(db, {
        rules: {
          orders: {
            $orderId: {
              ".read": true,
              ".write": "auth != null",
              items: { ".validate": "newData.parent().child('billing').exists()" },
              billing: { ".validate": "newData.isString()" },
            },
          },
        },
      });

      const adminDb = getAdminDatabase(sandbox);
      await set(dbRef(adminDb, '/orders/o1'), {
        items: 'item-list',
        billing: 'credit-card',
      });

      // Slash-separated multi-path update targeting root
      let updateError: unknown = null;
      try {
        await update(dbRef(db), {
          '/orders/o1/billing': null, // deleting billing
        });
      } catch (err) {
        updateError = err;
      }

      expect(updateError).toBeInstanceOf(Error);
      expect((updateError as Error).message).toContain('PERMISSION_DENIED');
    });
  });

  // ─── F4: Path Traversal & Root Clamping Boundaries ────────────
  describe('F4: Path Traversal & Root Clamping Boundaries', () => {
    test('F4.B1: excessive ../ traversal clamps strictly to document root without escaping', () => {
      const path = normalizeDocumentPath('/databases/(default)/documents/../../../../../../users/alice');
      expect(path).toBe('users/alice');
    });

    test('F4.B1b: relative traversal cannot escape collection root', () => {
      const path = normalizeDocumentPath('/databases/(default)/documents/users/../secrets/123');
      // Collection root 'users' cannot be popped by ..; resolves within users/
      expect(path).toBe('users/secrets/123');
    });

    test('F4.B2: redundant current directory dots (.) resolve cleanly', () => {
      const path = normalizeDocumentPath('/databases/(default)/documents/./users/./alice/./posts/./p1');
      expect(path).toBe('users/alice/posts/p1');
    });

    test('F4.B3: alternating .. and names resolve to correct destination', () => {
      const path = normalizeDocumentPath('/databases/(default)/documents/col/doc/sub/doc2/../doc3/../../../doc4');
      expect(path).toBe('col/doc4');
    });

    test('F4.B4: .. traversal resulting in odd segment count is rejected as collection path', () => {
      let threw = false;
      try {
        const path = normalizeDocumentPath('/databases/(default)/documents/users/alice/posts/p1/..');
        // If it resolved to 'users/alice/posts' (3 segments), resolveGet must reject it
        resolveGet(path, { mockDocuments: new Map() } as unknown as any);
      } catch (err) {
        threw = true;
        expect(err).toBeInstanceOf(EvalError);
      }
      expect(threw).toBe(true);
    });

    test('F4.B5: trailing slashes in document path are cleanly stripped before normalization', () => {
      const path = normalizeDocumentPath('/databases/(default)/documents/users/alice/');
      expect(path).toBe('users/alice');
    });

    test('F4.B6: deeply nested subcollection path with 8 levels resolves canonical document', () => {
      const raw = '/databases/(default)/documents/a/1/b/2/c/3/d/4/../5';
      const path = normalizeDocumentPath(raw);
      expect(path).toBe('a/1/b/2/c/3/d/5');
    });
  });
});
