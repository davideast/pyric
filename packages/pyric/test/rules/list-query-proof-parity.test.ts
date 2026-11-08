import { describe, expect, test } from 'bun:test';
import { firestoreRules } from 'pyric/rules';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules, seedDocuments } from 'pyric/sandbox/firestore';
import { getFirestore, collection, doc, getDoc, getDocs, query, where } from 'pyric/firestore';

describe('Firestore list query proof parity', () => {
  describe('sound residual substitution across finite where branches', () => {
    const AGE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.age > 18;
    }
  }
}`;

    test('denies in-filter when any branch violates an inequality rule even if seeded docs satisfy it, and allows when all branches satisfy it', async () => {
      const ruleset = firestoreRules(AGE_RULES);

      const deniedSim = ruleset.simulate([
        {
          description: 'list items with age in [10, 20]',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'age', op: 'in', value: [10, 20] }],
          },
        },
      ]).cases[0]!;
      expect(deniedSim.decision).toBe('DENY');
      expect(deniedSim.queryProof?.verdict).toBe('UNPROVABLE');

      const allowedSim = ruleset.simulate([
        {
          description: 'list items with age in [19, 25]',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'age', op: 'in', value: [19, 25] }],
          },
        },
      ]).cases[0]!;
      expect(allowedSim.decision).toBe('ALLOW');
      expect(allowedSim.queryProof?.verdict).toBe('PROVABLE');

      const sandbox = initializeSandbox();
      setRules(sandbox, AGE_RULES);
      seedDocuments(sandbox, {
        'items/a': { age: 20 },
        'items/b': { age: 25 },
      });
      const db = getFirestore(sandbox);

      await expect(
        getDocs(query(collection(db, 'items'), where('age', 'in', [10, 20]))),
      ).rejects.toMatchObject({ code: 'permission-denied' });

      const snap = await getDocs(query(collection(db, 'items'), where('age', 'in', [19, 25])));
      expect(snap.docs.map((d) => d.data())).toEqual([{ age: 25 }]);
    });

    test('denies in-filter against equality disjunction when any value is unauthorized and allows when every value is authorized', async () => {
      const statusRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.status == 'open' || resource.data.status == 'archived';
    }
  }
}`;

      const ruleset = firestoreRules(statusRules);

      const deniedSim = ruleset.simulate([
        {
          description: 'list items with status in [open, draft]',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'status', op: 'in', value: ['open', 'draft'] }],
          },
        },
      ]).cases[0]!;
      expect(deniedSim.decision).toBe('DENY');
      expect(deniedSim.queryProof?.verdict).toBe('UNPROVABLE');

      const allowedSim = ruleset.simulate([
        {
          description: 'list items with status in [open, archived]',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'status', op: 'in', value: ['open', 'archived'] }],
          },
        },
      ]).cases[0]!;
      expect(allowedSim.decision).toBe('ALLOW');
      expect(allowedSim.queryProof?.verdict).toBe('PROVABLE');

      const sandbox = initializeSandbox();
      setRules(sandbox, statusRules);
      seedDocuments(sandbox, {
        'items/a': { status: 'open' },
      });
      const db = getFirestore(sandbox);

      await expect(
        getDocs(query(collection(db, 'items'), where('status', 'in', ['open', 'draft']))),
      ).rejects.toMatchObject({ code: 'permission-denied' });

      const snap = await getDocs(query(collection(db, 'items'), where('status', 'in', ['open', 'archived'])));
      expect(snap.docs.map((d) => d.data())).toEqual([{ status: 'open' }]);
    });

    test('denies unrelated in-filter on a disjunctive public-or-owner rule', async () => {
      const ownerOrPublicRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.public == true || resource.data.ownerId == request.auth.uid;
    }
  }
}`;

      const ruleset = firestoreRules(ownerOrPublicRules);
      const sim = ruleset.simulate([
        {
          description: 'list items filtered only by unrelated status in [open, closed]',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          auth: { uid: 'user-1' },
          query: {
            where: [{ field: 'status', op: 'in', value: ['open', 'closed'] }],
          },
        },
      ]).cases[0]!;
      expect(sim.decision).toBe('DENY');
      expect(sim.queryProof?.verdict).toBe('UNPROVABLE');

      const simPublicToggle = ruleset.simulate([
        {
          description: 'list items filtered by public in [true, false] without ownerId filter',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          auth: { uid: 'user-1' },
          query: {
            where: [{ field: 'public', op: 'in', value: [true, false] }],
          },
        },
      ]).cases[0]!;
      expect(simPublicToggle.decision).toBe('DENY');
      expect(simPublicToggle.queryProof?.verdict).toBe('UNPROVABLE');

      const sandbox = initializeSandbox();
      setRules(sandbox, ownerOrPublicRules);
      seedDocuments(sandbox, {
        'items/a': { public: true, ownerId: 'user-1', status: 'open' },
      });
      const db = getFirestore(sandbox.withAuth({ uid: 'user-1' }));

      await expect(
        getDocs(query(collection(db, 'items'), where('status', 'in', ['open', 'closed']))),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });

    test('preserves CEL error absorption and integer division semantics across finite where branches', async () => {
      const celSemanticsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if !(resource.data.age > 18) && resource.data.bucket / 2 == 5;
    }
  }
}`;

      const ruleset = firestoreRules(celSemanticsRules);

      // null > 18 is a CEL type error; !(error) remains an error (not !false), so [null, 10] must be UNPROVABLE.
      const nullBranchSim = ruleset.simulate([
        {
          description: 'list items when one in-branch triggers a negated type error',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: {
            where: [
              { field: 'age', op: 'in', value: [null, 10] },
              { field: 'bucket', op: '==', value: 10 },
            ],
          },
        },
      ]).cases[0]!;
      expect(nullBranchSim.decision).toBe('DENY');
      expect(nullBranchSim.queryProof?.verdict).toBe('UNPROVABLE');

      // In CEL int division, 10 / 2 == 5 and 11 / 2 == 5, whereas 9 / 2 == 4.
      const deniedDivSim = ruleset.simulate([
        {
          description: 'list items when one bucket fails int division',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: {
            where: [
              { field: 'age', op: '==', value: 10 },
              { field: 'bucket', op: 'in', value: [9, 10] },
            ],
          },
        },
      ]).cases[0]!;
      expect(deniedDivSim.decision).toBe('DENY');
      expect(deniedDivSim.queryProof?.verdict).toBe('UNPROVABLE');

      const allowedDivSim = ruleset.simulate([
        {
          description: 'list items when all buckets satisfy int division',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: {
            where: [
              { field: 'age', op: '==', value: 10 },
              { field: 'bucket', op: 'in', value: [10, 11] },
            ],
          },
        },
      ]).cases[0]!;
      expect(allowedDivSim.decision).toBe('ALLOW');
      expect(allowedDivSim.queryProof?.verdict).toBe('PROVABLE');
    });

    test('evaluates closed constant method calls, casts, list errors, non-boolean operands, and ternaries via CEL semantics', async () => {
      const matchesRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.name.matches('^a.*');
    }
  }
}`;
      const matchesRuleset = firestoreRules(matchesRules);
      const matchesCases = matchesRuleset.simulate([
        {
          description: 'list items with name in [apple, banana] without mocked resource',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'name', op: 'in', value: ['apple', 'banana'] }] },
        },
        {
          description: 'list items with name in [apple, banana] and mocked matching resource',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          resource: { name: 'apple' },
          query: { where: [{ field: 'name', op: 'in', value: ['apple', 'banana'] }] },
        },
        {
          description: 'list items with name in [apple, apricot]',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'name', op: 'in', value: ['apple', 'apricot'] }] },
        },
      ]);
      expect(matchesCases.cases[0]!.decision).toBe('DENY');
      expect(matchesCases.cases[0]!.queryProof?.verdict).toBe('UNPROVABLE');
      expect(matchesCases.cases[1]!.queryProof?.verdict).toBe('UNPROVABLE');
      expect(matchesCases.cases[2]!.decision).toBe('ALLOW');
      expect(matchesCases.cases[2]!.queryProof?.verdict).toBe('PROVABLE');

      const castRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if int(resource.data.code) > 18;
    }
  }
}`;
      const castCases = firestoreRules(castRules).simulate([
        {
          description: 'list items with code in [10, 20]',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          resource: { code: '20' },
          query: { where: [{ field: 'code', op: 'in', value: ['10', '20'] }] },
        },
        {
          description: 'list items with code in [19, 25]',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'code', op: 'in', value: ['19', '25'] }] },
        },
      ]);
      expect(castCases.cases[0]!.queryProof?.verdict).toBe('UNPROVABLE');
      expect(castCases.cases[1]!.decision).toBe('ALLOW');
      expect(castCases.cases[1]!.queryProof?.verdict).toBe('PROVABLE');

      const listPlusRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if [resource.data.x] + [2] == [1, 2];
    }
  }
}`;
      const listPlusSim = firestoreRules(listPlusRules).simulate([
        {
          description: 'list items where list + list triggers CEL error',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'x', op: 'in', value: [1] }] },
        },
      ]).cases[0]!;
      expect(listPlusSim.decision).toBe('DENY');
      expect(listPlusSim.queryProof?.verdict).toBe('UNPROVABLE');

      const nonBoolRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.flag && true;
    }
  }
}`;
      const nonBoolCases = firestoreRules(nonBoolRules).simulate([
        {
          description: 'list items with flag in [1, true] without mocked resource',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'flag', op: 'in', value: [1, true] }] },
        },
        {
          description: 'list items with flag in [1, true] with mocked resource { flag: true }',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          resource: { flag: true },
          query: { where: [{ field: 'flag', op: 'in', value: [1, true] }] },
        },
      ]);
      expect(nonBoolCases.cases[0]!.decision).toBe('DENY');
      expect(nonBoolCases.cases[0]!.queryProof?.verdict).toBe('UNPROVABLE');
      expect(nonBoolCases.cases[1]!.queryProof?.verdict).toBe('UNPROVABLE');

      const ternaryRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.tier == 1 ? true : resource.data.secret == 'ok';
    }
  }
}`;
      const ternaryCases = firestoreRules(ternaryRules).simulate([
        {
          description: 'list items with tier in [1] selects provable consequent',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'tier', op: 'in', value: [1] }] },
        },
        {
          description: 'list items with tier in [1, 2] reaches unpinned alternate',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'tier', op: 'in', value: [1, 2] }] },
        },
      ]);
      expect(ternaryCases.cases[0]!.decision).toBe('ALLOW');
      expect(ternaryCases.cases[0]!.queryProof?.verdict).toBe('PROVABLE');
      expect(ternaryCases.cases[1]!.decision).toBe('DENY');
      expect(ternaryCases.cases[1]!.queryProof?.verdict).toBe('UNPROVABLE');

      const sandbox = initializeSandbox();
      const db = getFirestore(sandbox);

      setRules(sandbox, matchesRules);
      seedDocuments(sandbox, { 'items/a': { name: 'apple' } });
      await expect(
        getDocs(query(collection(db, 'items'), where('name', 'in', ['apple', 'banana']))),
      ).rejects.toMatchObject({ code: 'permission-denied' });
      const matchesSnap = await getDocs(
        query(collection(db, 'items'), where('name', 'in', ['apple', 'apricot'])),
      );
      expect(matchesSnap.docs.map((d) => d.data())).toEqual([{ name: 'apple' }]);

      setRules(sandbox, listPlusRules);
      seedDocuments(sandbox, { 'items/a': { x: 1 } });
      await expect(
        getDocs(query(collection(db, 'items'), where('x', 'in', [1]))),
      ).rejects.toMatchObject({ code: 'permission-denied' });

      setRules(sandbox, nonBoolRules);
      seedDocuments(sandbox, { 'items/a': { flag: true } });
      await expect(
        getDocs(query(collection(db, 'items'), where('flag', 'in', [1, true]))),
      ).rejects.toMatchObject({ code: 'permission-denied' });

      setRules(sandbox, ternaryRules);
      seedDocuments(sandbox, { 'items/a': { tier: 1 } });
      const ternarySnap = await getDocs(
        query(collection(db, 'items'), where('tier', 'in', [1])),
      );
      expect(ternarySnap.docs.map((d) => d.data())).toEqual([{ tier: 1 }]);
      await expect(
        getDocs(query(collection(db, 'items'), where('tier', 'in', [1, 2]))),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    });
  });

  describe('lexical function and path-capture scoping in list query proof', () => {
    test('outer helper at service scope calling a helper declared inside match /items/{id} fails both get and list', async () => {
      const outerCallsInnerRules = `rules_version = '2';
service cloud.firestore {
  function outerCanRead() {
    return innerPublicCheck();
  }
  match /databases/{database}/documents {
    match /items/{id} {
      function innerPublicCheck() {
        return resource.data.public == true;
      }
      allow read: if outerCanRead();
    }
  }
}`;

      const ruleset = firestoreRules(outerCallsInnerRules);
      const sim = ruleset.simulate([
        {
          description: 'get item via outer helper calling inner helper',
          expectation: 'DENY',
          method: 'get',
          path: 'items/a',
          resource: { public: true },
        },
        {
          description: 'list items via outer helper calling inner helper',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'public', op: '==', value: true }],
          },
        },
      ]);

      expect(sim.cases[0]!.decision).toBe('DENY');
      expect(sim.cases[1]!.decision).toBe('DENY');
      expect(sim.cases[1]!.queryProof?.verdict).toBe('UNPROVABLE');

      const sandbox = initializeSandbox();
      setRules(sandbox, outerCallsInnerRules);
      seedDocuments(sandbox, {
        'items/a': { public: true },
      });
      const db = getFirestore(sandbox);

      await expect(getDoc(doc(db, 'items/a'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(
        getDocs(query(collection(db, 'items'), where('public', '==', true))),
      ).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    test('outer helper referencing {id} declared only in child match /items/{id} fails both get and list', async () => {
      const outerReadsChildCaptureRules = `rules_version = '2';
service cloud.firestore {
  function outerReadsId() {
    return id != '' && resource.data.public == true;
  }
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if outerReadsId();
    }
  }
}`;

      const ruleset = firestoreRules(outerReadsChildCaptureRules);
      const sim = ruleset.simulate([
        {
          description: 'get item via outer helper referencing child {id}',
          expectation: 'DENY',
          method: 'get',
          path: 'items/a',
          resource: { public: true },
        },
        {
          description: 'list items via outer helper referencing child {id}',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'public', op: '==', value: true }],
          },
        },
      ]);

      expect(sim.cases[0]!.decision).toBe('DENY');
      expect(sim.cases[1]!.decision).toBe('DENY');
      expect(sim.cases[1]!.queryProof?.verdict).toBe('UNPROVABLE');

      const sandbox = initializeSandbox();
      setRules(sandbox, outerReadsChildCaptureRules);
      seedDocuments(sandbox, {
        'items/a': { public: true },
      });
      const db = getFirestore(sandbox);

      await expect(getDoc(doc(db, 'items/a'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(
        getDocs(query(collection(db, 'items'), where('public', '==', true))),
      ).rejects.toMatchObject({
        code: 'permission-denied',
      });

      const outerReadsParentMatchCaptureRules = `rules_version = '2';
service cloud.firestore {
  function outerReadsOrg() {
    return orgId == 'org-1' && resource.data.public == true;
  }
  match /databases/{database}/documents {
    match /orgs/{orgId} {
      match /items/{id} {
        allow read: if outerReadsOrg();
      }
    }
  }
}`;

      const orgRuleset = firestoreRules(outerReadsParentMatchCaptureRules);
      const orgSim = orgRuleset.simulate([
        {
          description: 'get nested item via service helper referencing child {orgId}',
          expectation: 'DENY',
          method: 'get',
          path: 'orgs/org-1/items/a',
          resource: { public: true },
        },
        {
          description: 'list nested items via service helper referencing child {orgId}',
          expectation: 'DENY',
          method: 'list',
          path: 'orgs/org-1/items',
          query: {
            where: [{ field: 'public', op: '==', value: true }],
          },
        },
      ]);

      expect(orgSim.cases[0]!.decision).toBe('DENY');
      expect(orgSim.cases[1]!.decision).toBe('DENY');
      expect(orgSim.cases[1]!.queryProof?.verdict).toBe('UNPROVABLE');

      setRules(sandbox, outerReadsParentMatchCaptureRules);
      seedDocuments(sandbox, {
        'orgs/org-1/items/a': { public: true },
      });

      await expect(getDoc(doc(db, 'orgs/org-1/items/a'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(
        getDocs(query(collection(db, 'orgs/org-1/items'), where('public', '==', true))),
      ).rejects.toMatchObject({
        code: 'permission-denied',
      });
    });

    test('enclosing match /orgs/{orgId} helper referencing {orgId} called from nested match /items/{id} passes both get and list', async () => {
      const enclosingCaptureRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId} {
      function canReadOrgItems() {
        return request.auth != null && request.auth.token.orgId == orgId && resource.data.public == true;
      }
      match /items/{id} {
        allow read: if canReadOrgItems();
      }
    }
  }
}`;

      const auth = { uid: 'user-1', token: { orgId: 'org-1' } };
      const ruleset = firestoreRules(enclosingCaptureRules);
      const sim = ruleset.simulate([
        {
          description: 'get nested item with enclosing org helper',
          expectation: 'ALLOW',
          method: 'get',
          path: 'orgs/org-1/items/a',
          auth,
          resource: { public: true },
        },
        {
          description: 'list nested items with enclosing org helper',
          expectation: 'ALLOW',
          method: 'list',
          path: 'orgs/org-1/items',
          auth,
          query: {
            where: [{ field: 'public', op: '==', value: true }],
          },
        },
      ]);

      expect(sim.cases[0]!.decision).toBe('ALLOW');
      expect(sim.cases[1]!.decision).toBe('ALLOW');
      expect(sim.cases[1]!.queryProof?.verdict).toBe('PROVABLE');

      const sandbox = initializeSandbox();
      setRules(sandbox, enclosingCaptureRules);
      seedDocuments(sandbox, {
        'orgs/org-1/items/a': { public: true },
      });
      const db = getFirestore(sandbox.withAuth(auth));

      const docSnap = await getDoc(doc(db, 'orgs/org-1/items/a'));
      expect(docSnap.exists()).toBe(true);
      expect(docSnap.data()).toEqual({ public: true });

      const listSnap = await getDocs(
        query(collection(db, 'orgs/org-1/items'), where('public', '==', true)),
      );
      expect(listSnap.docs.map((d) => d.data())).toEqual([{ public: true }]);
    });
  });

  describe('signed negative numeric literals in list query proof', () => {
    test('proves equality rules against negative int and float literals and reports mismatch on positive filter', async () => {
      const negativeIntRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.tier == -1;
    }
  }
}`;

      const intRuleset = firestoreRules(negativeIntRules);
      const intResults = intRuleset.simulate([
        {
          description: 'list items with tier == -1',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'tier', op: '==', value: -1 }],
          },
        },
        {
          description: 'list items with tier == 1 against tier == -1 rule',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'tier', op: '==', value: 1 }],
          },
        },
      ]);

      expect(intResults.cases[0]!.decision).toBe('ALLOW');
      expect(intResults.cases[0]!.queryProof?.verdict).toBe('PROVABLE');

      expect(intResults.cases[1]!.decision).toBe('DENY');
      expect(intResults.cases[1]!.queryProof?.verdict).toBe('UNPROVABLE');
      expect(intResults.cases[1]!.queryProof?.kind).toBe('constraints-not-satisfied');
      expect(intResults.cases[1]!.queryProof?.remediation).toContain(".where('tier', '==', -1)");

      const negativeFloatRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.offset == -2.5;
    }
  }
}`;

      const floatRuleset = firestoreRules(negativeFloatRules);
      const floatSim = floatRuleset.simulate([
        {
          description: 'list items with offset == -2.5',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'offset', op: '==', value: -2.5 }],
          },
        },
      ]).cases[0]!;
      expect(floatSim.decision).toBe('ALLOW');
      expect(floatSim.queryProof?.verdict).toBe('PROVABLE');

      const sandbox = initializeSandbox();
      setRules(sandbox, negativeIntRules);
      seedDocuments(sandbox, {
        'items/a': { tier: -1 },
      });
      const db = getFirestore(sandbox);

      const allowedSnap = await getDocs(query(collection(db, 'items'), where('tier', '==', -1)));
      expect(allowedSnap.docs.map((d) => d.data())).toEqual([{ tier: -1 }]);

      await expect(
        getDocs(query(collection(db, 'items'), where('tier', '==', 1))),
      ).rejects.toMatchObject({ code: 'permission-denied' });

      setRules(sandbox, negativeFloatRules);
      seedDocuments(sandbox, {
        'items/f': { offset: -2.5 },
      });
      const floatSnap = await getDocs(query(collection(db, 'items'), where('offset', '==', -2.5)));
      expect(floatSnap.docs.map((d) => d.data())).toEqual([{ offset: -2.5 }]);
    });

    test('proves array-contains membership rules with negative int and float literals', async () => {
      const negativeScoresRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if -1 in resource.data.scores;
    }
  }
}`;

      const ruleset = firestoreRules(negativeScoresRules);
      const sim = ruleset.simulate([
        {
          description: 'list items where scores array-contains -1',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'scores', op: 'array-contains', value: -1 }],
          },
        },
      ]).cases[0]!;
      expect(sim.decision).toBe('ALLOW');
      expect(sim.queryProof?.verdict).toBe('PROVABLE');

      const negativeFloatScoresRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if -2.5 in resource.data.scores;
    }
  }
}`;
      const floatSim = firestoreRules(negativeFloatScoresRules).simulate([
        {
          description: 'list items where scores array-contains -2.5',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'scores', op: 'array-contains', value: -2.5 }],
          },
        },
      ]).cases[0]!;
      expect(floatSim.decision).toBe('ALLOW');
      expect(floatSim.queryProof?.verdict).toBe('PROVABLE');

      const sandbox = initializeSandbox();
      setRules(sandbox, negativeScoresRules);
      seedDocuments(sandbox, {
        'items/a': { scores: [-1, 5] },
      });
      const db = getFirestore(sandbox);

      const snap = await getDocs(
        query(collection(db, 'items'), where('scores', 'array-contains', -1)),
      );
      expect(snap.docs.map((d) => d.data())).toEqual([{ scores: [-1, 5] }]);
    });

    test('distinguishes CEL int vs float in list membership and fails closed past safe int64 precision while equating -1 == -1.0', async () => {
      const floatInListRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if -1.0 in resource.data.scores;
    }
  }
}`;
      const floatInListSim = firestoreRules(floatInListRules).simulate([
        {
          description: 'list items where scores array-contains int -1 against float -1.0 rule',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'scores', op: 'array-contains', value: -1 }] },
        },
      ]).cases[0]!;
      expect(floatInListSim.decision).toBe('DENY');
      expect(floatInListSim.queryProof?.verdict).toBe('UNPROVABLE');

      const hasAnyFloatRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.scores.hasAny([-1.0]);
    }
  }
}`;
      const hasAnyFloatSim = firestoreRules(hasAnyFloatRules).simulate([
        {
          description: 'list items where scores array-contains int -1 against hasAny([-1.0])',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'scores', op: 'array-contains', value: -1 }] },
        },
      ]).cases[0]!;
      expect(hasAnyFloatSim.decision).toBe('DENY');
      expect(hasAnyFloatSim.queryProof?.verdict).toBe('UNPROVABLE');

      const int64MinScoresRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if -9223372036854775808 in resource.data.scores;
    }
  }
}`;
      const int64MinSim = firestoreRules(int64MinScoresRules).simulate([
        {
          description: 'list items where scores array-contains -9223372036854775808',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: {
            where: [{ field: 'scores', op: 'array-contains', value: -9223372036854775808 }],
          },
        },
      ]).cases[0]!;
      expect(int64MinSim.decision).toBe('DENY');
      expect(int64MinSim.queryProof?.verdict).toBe('UNPROVABLE');

      const tierInFloatListRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.tier in [-1.0];
    }
  }
}`;
      const tierInFloatSim = firestoreRules(tierInFloatListRules).simulate([
        {
          description: 'list items where tier == -1 against tier in [-1.0]',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'tier', op: '==', value: -1 }] },
        },
      ]).cases[0]!;
      expect(tierInFloatSim.decision).toBe('DENY');
      expect(tierInFloatSim.queryProof?.verdict).toBe('UNPROVABLE');

      const unsafeIntEqRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.tier == -9223372036854775807;
    }
  }
}`;
      const unsafeIntEqSim = firestoreRules(unsafeIntEqRules).simulate([
        {
          description: 'list items where tier == -9223372036854775807 (lossy JS double)',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'tier', op: '==', value: -9223372036854775807 }] },
        },
      ]).cases[0]!;
      expect(unsafeIntEqSim.decision).toBe('DENY');
      expect(unsafeIntEqSim.queryProof?.verdict).toBe('UNPROVABLE');

      const crossTypeEqRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.tier == -1.0;
    }
  }
}`;
      const crossTypeEqSim = firestoreRules(crossTypeEqRules).simulate([
        {
          description: 'list items where tier == -1 against tier == -1.0',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'tier', op: '==', value: -1 }] },
        },
      ]).cases[0]!;
      expect(crossTypeEqSim.decision).toBe('ALLOW');
      expect(crossTypeEqSim.queryProof?.verdict).toBe('PROVABLE');

      const sandbox = initializeSandbox();
      const db = getFirestore(sandbox);

      setRules(sandbox, floatInListRules);
      seedDocuments(sandbox, { 'items/a': { scores: [-1] } });
      await expect(getDoc(doc(db, 'items/a'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(
        getDocs(query(collection(db, 'items'), where('scores', 'array-contains', -1))),
      ).rejects.toMatchObject({ code: 'permission-denied' });

      setRules(sandbox, int64MinScoresRules);
      seedDocuments(sandbox, { 'items/a': { scores: [-9223372036854775808] } });
      await expect(getDoc(doc(db, 'items/a'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(
        getDocs(
          query(collection(db, 'items'), where('scores', 'array-contains', -9223372036854775808)),
        ),
      ).rejects.toMatchObject({ code: 'permission-denied' });

      setRules(sandbox, tierInFloatListRules);
      seedDocuments(sandbox, { 'items/a': { tier: -1 } });
      await expect(getDoc(doc(db, 'items/a'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(
        getDocs(query(collection(db, 'items'), where('tier', '==', -1))),
      ).rejects.toMatchObject({ code: 'permission-denied' });

      setRules(sandbox, crossTypeEqRules);
      seedDocuments(sandbox, { 'items/a': { tier: -1 } });
      const getSnap = await getDoc(doc(db, 'items/a'));
      expect(getSnap.data()).toEqual({ tier: -1 });
      const listSnap = await getDocs(query(collection(db, 'items'), where('tier', '==', -1)));
      expect(listSnap.docs.map((d) => d.data())).toEqual([{ tier: -1 }]);
    });

    test('preserves getDoc and getDocs parity for -0, == 0, and >= 2^53 under is int while keeping x == 0 provable', async () => {
      const isIntRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.x is int;
    }
  }
}`;
      const isIntRuleset = firestoreRules(isIntRules);
      const simCases = isIntRuleset.simulate([
        {
          description: 'list items with x in [-0] under x is int',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'x', op: 'in', value: [-0] }] },
        },
        {
          description: 'list items with x == 0 under x is int',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'x', op: '==', value: 0 }] },
        },
        {
          description: 'list items with x in [2 ** 53] under x is int',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'x', op: 'in', value: [2 ** 53] }] },
        },
        {
          description: 'list items with x in [0] under x is int',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'x', op: 'in', value: [0] }] },
        },
        {
          description: 'list items with x == 0 intersected with x in [0] under x is int',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: {
            where: [
              { field: 'x', op: '==', value: 0 },
              { field: 'x', op: 'in', value: [0] },
            ],
          },
        },
      ]);

      expect(simCases.cases[0]!.decision).toBe('DENY');
      expect(simCases.cases[0]!.queryProof?.verdict).toBe('UNPROVABLE');
      expect(simCases.cases[1]!.decision).toBe('DENY');
      expect(simCases.cases[1]!.queryProof?.verdict).toBe('UNPROVABLE');
      expect(simCases.cases[2]!.decision).toBe('DENY');
      expect(simCases.cases[2]!.queryProof?.verdict).toBe('UNPROVABLE');
      expect(simCases.cases[3]!.decision).toBe('ALLOW');
      expect(simCases.cases[3]!.queryProof?.verdict).toBe('PROVABLE');
      expect(simCases.cases[4]!.decision).toBe('ALLOW');
      expect(simCases.cases[4]!.queryProof?.verdict).toBe('PROVABLE');

      const sandbox = initializeSandbox();
      const db = getFirestore(sandbox);

      setRules(sandbox, isIntRules);
      seedDocuments(sandbox, {
        'items/negZero': { x: -0 },
        'items/posZero': { x: 0 },
        'items/unsafe': { x: 2 ** 53 },
      });

      await expect(getDoc(doc(db, 'items/negZero'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(
        getDocs(query(collection(db, 'items'), where('x', 'in', [-0]))),
      ).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(
        getDocs(query(collection(db, 'items'), where('x', '==', 0))),
      ).rejects.toMatchObject({ code: 'permission-denied' });

      await expect(getDoc(doc(db, 'items/unsafe'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(
        getDocs(query(collection(db, 'items'), where('x', 'in', [2 ** 53]))),
      ).rejects.toMatchObject({ code: 'permission-denied' });

      const posZeroSnap = await getDocs(
        query(collection(db, 'items'), where('x', 'in', [0])),
      );
      expect(posZeroSnap.docs.map((d) => d.id)).toEqual(['posZero']);

      const eqZeroRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.x == 0;
    }
  }
}`;
      const eqZeroSim = firestoreRules(eqZeroRules).simulate([
        {
          description: 'list items with x == 0 under x == 0',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          query: { where: [{ field: 'x', op: '==', value: 0 }] },
        },
      ]).cases[0]!;
      expect(eqZeroSim.decision).toBe('ALLOW');
      expect(eqZeroSim.queryProof?.verdict).toBe('PROVABLE');

      setRules(sandbox, eqZeroRules);
      const eqZeroSnap = await getDocs(
        query(collection(db, 'items'), where('x', '==', 0)),
      );
      expect(eqZeroSnap.docs.map((d) => d.id).sort()).toEqual(['negZero', 'posZero']);
    });

    test('resolves outer helper calls in their lexical scope when an inner match block shadows a helper name', async () => {
      const shadowedDenyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function checkGate() {
      return request.auth != null;
    }
    function canRead(status) {
      return checkGate() && status == 'pub';
    }
    match /items/{id} {
      function checkGate() {
        return false;
      }
      allow read: if canRead(resource.data.status);
    }
  }
}`;
      const simAllow = firestoreRules(shadowedDenyRules).simulate([
        {
          description: 'list items where status == pub with outer checkGate() true and inner shadowed checkGate() false',
          expectation: 'ALLOW',
          method: 'list',
          path: 'items',
          auth: { uid: 'u1' },
          query: { where: [{ field: 'status', op: '==', value: 'pub' }] },
        },
      ]).cases[0]!;
      expect(simAllow.decision).toBe('ALLOW');
      expect(simAllow.queryProof?.verdict).toBe('PROVABLE');

      const shadowedAllowRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function checkGate() {
      return false;
    }
    function canRead(status) {
      return checkGate() && status == 'pub';
    }
    match /items/{id} {
      function checkGate() {
        return true;
      }
      allow read: if canRead(resource.data.status);
    }
  }
}`;
      const simDeny = firestoreRules(shadowedAllowRules).simulate([
        {
          description: 'list items where status == pub with outer checkGate() false and inner shadowed checkGate() true',
          expectation: 'DENY',
          method: 'list',
          path: 'items',
          auth: { uid: 'u1' },
          query: { where: [{ field: 'status', op: '==', value: 'pub' }] },
        },
      ]).cases[0]!;
      expect(simDeny.decision).toBe('DENY');

      const sandbox = initializeSandbox();
      const db = getFirestore(sandbox);
      seedDocuments(sandbox, { 'items/a': { status: 'pub' } });

      setRules(sandbox, shadowedAllowRules);
      await expect(getDoc(doc(db, 'items/a'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(
        getDocs(query(collection(db, 'items'), where('status', '==', 'pub'))),
      ).rejects.toMatchObject({
        code: 'permission-denied',
      });

      setRules(sandbox, shadowedDenyRules);
      const authedDb = getFirestore(sandbox.withAuth({ uid: 'u1' }));
      const getSnap = await getDoc(doc(authedDb, 'items/a'));
      expect(getSnap.data()).toEqual({ status: 'pub' });
      const listSnap = await getDocs(
        query(collection(authedDb, 'items'), where('status', '==', 'pub')),
      );
      expect(listSnap.docs.map((d) => d.data())).toEqual([{ status: 'pub' }]);
    });
  });
});
