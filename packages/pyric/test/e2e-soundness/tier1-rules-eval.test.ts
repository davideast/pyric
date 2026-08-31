import 'fake-indexeddb/auto';
import { describe, test, expect } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';
import { RuleEvalError } from '../../src/storage/sandbox/rules-evaluation-error.js';
import { DataSnapshot, evaluateRtdbExpression } from '../../src/rules/rtdb/grammar/simulator.js';

describe('Tier 1: Feature Coverage (Evaluation Rules)', () => {
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
});
