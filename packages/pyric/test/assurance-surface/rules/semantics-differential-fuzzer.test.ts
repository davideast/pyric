import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import {
  FieldPath,
  collection,
  doc,
  documentId,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  setDoc,
  where,
} from 'pyric/firestore';
import { firestoreRules } from 'pyric/rules';
import {
  Bytes as RulesBytes,
  Duration as RulesDuration,
  Timestamp as RulesTimestamp,
  type QueryWhereConstraint,
} from 'pyric/rules/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { synthesizeFieldWitness } from '../../../src/assurance-surface/passes/static-query-proof-domain-witness.js';
import { staticQueryProofPass } from '../../../src/assurance-surface/passes/static-query-proof.js';
import { extractSdkUsage } from '../../../src/assurance-surface/usage.js';

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('assurance Firestore rules-semantics standing differential fuzzer', () => {
  test('helper-wrapped and unseeded context rules agree with firestoreRules().simulate() and Sandbox', async () => {
    const cases = [
      {
        name: 'helper-wrapped uid wildcard with unseeded exists() and violated request.query.limit',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner(ownerUid) {
      let current = request.auth.uid;
      return request.auth != null && current == ownerUid;
    }
    match /orgs/{orgId}/users/{uid}/items/{itemId} {
      allow create: if true;
      allow list: if isOwner(uid)
        && exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid))
        && request.query.limit <= 10;
    }
  }
}`,
        simPath: 'orgs/acme/users/u-alice/items/i1',
        clientCall: "query(collection(db, 'orgs', 'acme', 'users', uid, 'items'), limit(50))",
        runQuery: (db: ReturnType<typeof getFirestore>, uid: string) =>
          getDocs(query(collection(db, 'orgs', 'acme', 'users', uid, 'items'), limit(50))),
        queryLimit: 50,
        checkDirectSimulate: false,
        expectAllowWhenMemberExists: false,
        expectStaticProof: true,
      },
      {
        name: 'helper-wrapped uid wildcard with unseeded exists() and satisfied request.query.limit',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner(ownerUid) {
      return request.auth != null && request.auth.uid == ownerUid;
    }
    match /orgs/{orgId}/users/{uid}/items/{itemId} {
      allow create: if true;
      allow list: if isOwner(uid)
        && exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid))
        && request.query.limit <= 10;
    }
  }
}`,
        simPath: 'orgs/acme/users/u-alice/items/i1',
        clientCall: "query(collection(db, 'orgs', 'acme', 'users', uid, 'items'), limit(5))",
        runQuery: (db: ReturnType<typeof getFirestore>, uid: string) =>
          getDocs(query(collection(db, 'orgs', 'acme', 'users', uid, 'items'), limit(5))),
        queryLimit: 5,
        checkDirectSimulate: false,
        expectAllowWhenMemberExists: true,
        expectStaticProof: false,
      },
      {
        name: 'helper-wrapped uid wildcard with satisfied limit under direct simulate()',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isOwner(ownerUid) {
      let current = request.auth.uid;
      return request.auth != null && current == ownerUid;
    }
    match /orgs/{orgId}/users/{uid}/items/{itemId} {
      allow create: if true;
      allow list: if isOwner(uid) && request.query.limit <= 10;
    }
  }
}`,
        simPath: 'orgs/acme/users/u-alice/items/i1',
        clientCall: "query(collection(db, 'orgs', 'acme', 'users', uid, 'items'), limit(5))",
        runQuery: (db: ReturnType<typeof getFirestore>, uid: string) =>
          getDocs(query(collection(db, 'orgs', 'acme', 'users', uid, 'items'), limit(5))),
        queryLimit: 5,
        checkDirectSimulate: true,
        expectAllowWhenMemberExists: true,
        expectStaticProof: false,
      },
      {
        name: 'helper-wrapped resource.data.ownerId with negated exists() and violated limit',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function matchesOwner(ownerUid) {
      return request.auth != null && request.auth.uid == ownerUid;
    }
    match /orgs/{orgId}/items/{itemId} {
      allow create: if true;
      allow list: if matchesOwner(resource.data.ownerId)
        && !exists(/databases/$(database)/documents/orgs/$(orgId)/bans/$(request.auth.uid))
        && request.query.limit <= 10;
    }
  }
}`,
        simPath: 'orgs/acme/items/i1',
        clientCall:
          "query(collection(db, 'orgs', 'acme', 'items'), where('ownerId', '==', uid), limit(25))",
        runQuery: (db: ReturnType<typeof getFirestore>, uid: string) =>
          getDocs(
            query(collection(db, 'orgs', 'acme', 'items'), where('ownerId', '==', uid), limit(25)),
          ),
        queryLimit: 25,
        checkDirectSimulate: false,
        expectAllowWhenMemberExists: false,
        expectStaticProof: true,
      },
      {
        name: 'email_verified == false rule with violated orderBy direction',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/users/{uid}/items/{itemId} {
      allow create: if true;
      allow list: if request.auth != null
        && request.auth.token.email_verified == false
        && request.auth.uid == uid
        && request.query.orderBy.createdAt == 'DESC';
    }
  }
}`,
        simPath: 'orgs/acme/users/u-alice/items/i1',
        clientCall:
          "query(collection(db, 'orgs', 'acme', 'users', uid, 'items'), orderBy('createdAt', 'asc'))",
        runQuery: (db: ReturnType<typeof getFirestore>, uid: string) =>
          getDocs(
            query(
              collection(db, 'orgs', 'acme', 'users', uid, 'items'),
              orderBy('createdAt', 'asc'),
            ),
          ),
        queryLimit: undefined,
        checkDirectSimulate: true,
        expectAllowWhenMemberExists: false,
        expectStaticProof: true,
      },
    ];

    for (const tc of cases) {
      if (tc.checkDirectSimulate) {
        let caseQuery: { limit: number } | { orderBy: Record<string, 'ASC' | 'DESC'> };
        if (tc.queryLimit !== undefined) {
          caseQuery = { limit: tc.queryLimit };
        } else {
          caseQuery = { orderBy: { createdAt: 'ASC' } };
        }
        const simSummary = firestoreRules(tc.rules).simulate([
          {
            description: tc.name,
            expectation: 'ALLOW',
            method: 'list',
            path: tc.simPath,
            auth: { uid: 'u-alice', token: { email_verified: false } },
            resource: { ownerId: 'u-alice', createdAt: 10 },
            query: caseQuery,
          },
        ]);
        const simAllowed = simSummary.cases[0]!.decision === 'ALLOW';
        expect(simAllowed, tc.name).toBe(tc.expectAllowWhenMemberExists);
      }

      const sandbox = initializeSandbox();
      const seedDb = getFirestore(sandbox);
      await setDoc(doc(seedDb, 'orgs/acme/members/u-alice'), { role: 'member' });
      await setDoc(doc(seedDb, 'orgs/acme/users/u-alice/items/i1'), {
        ownerId: 'u-alice',
        createdAt: 10,
      });
      await setDoc(doc(seedDb, 'orgs/acme/items/i1'), { ownerId: 'u-alice', createdAt: 10 });
      setRules(sandbox, tc.rules);

      const userDb = getFirestore(
        sandbox.withAuth({ uid: 'u-alice', token: { email_verified: false } }),
      );
      let runtimeAllowed = true;
      try {
        await tc.runQuery(userDb, 'u-alice');
      } catch {
        runtimeAllowed = false;
      }
      expect(runtimeAllowed, tc.name).toBe(tc.expectAllowWhenMemberExists);

      const usage = extractSdkUsage({
        root: '/app',
        files: {
          'src/q.ts': `import { getAuth } from 'firebase/auth';
import { collection, getDocs, getFirestore, limit, orderBy, query, where } from 'firebase/firestore';
export async function run() {
  const uid = getAuth().currentUser!.uid;
  const db = getFirestore();
  return getDocs(${tc.clientCall});
}`,
        },
        includeReads: true,
      });
      const diags = staticQueryProofPass(usage, { rules: { '(default)': tc.rules } });
      const staticProofs = diags.filter((d) => d.certainty === 'static-proof');
      if (tc.expectStaticProof) {
        expect(staticProofs.length, tc.name).toBeGreaterThan(0);
      } else {
        expect(staticProofs, tc.name).toEqual([]);
      }
    }
  });

  test('named-database {database} wildcards and cross-database DocumentReference filters agree with Sandbox', async () => {
    const defaultRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId} {
      allow list: if resource.data.orgRef == /databases/$(database)/documents/orgs/acme;
    }
  }
}`;
    const analyticsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow list: if database == 'analytics'
        && resource.data.orgRef == /databases/$(database)/documents/orgs/acme;
    }
  }
}`;

    const sandbox = initializeSandbox();
    setRules(sandbox, defaultRules);
    const defaultDb = getFirestore(sandbox.withAuth({ uid: 'u1', token: {} }));
    const analyticsDb = getFirestore(sandbox.withAuth({ uid: 'u1', token: {} }), 'analytics');
    seedDocuments(sandbox, { 'orgs/acme': { orgRef: doc(defaultDb, 'orgs', 'acme') } });

    const sameDbSnap = await getDocs(
      query(collection(defaultDb, 'orgs'), where('orgRef', '==', doc(defaultDb, 'orgs', 'acme'))),
    );
    expect(sameDbSnap.size).toBe(1);

    let crossDbAllowed = true;
    try {
      await getDocs(
        query(
          collection(defaultDb, 'orgs'),
          where('orgRef', '==', doc(analyticsDb, 'orgs', 'acme')),
        ),
      );
    } catch {
      crossDbAllowed = false;
    }
    expect(crossDbAllowed).toBe(false);

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/multi-db.ts': `import { initializeApp } from 'firebase/app';
import { collection, doc, getDocs, getFirestore, query, where } from 'firebase/firestore';
const app = initializeApp({ projectId: 'demo-app' });
const defaultDb = getFirestore(app);
const analyticsDb = getFirestore(app, 'analytics');
export async function run() {
  await getDocs(query(collection(analyticsDb, 'items'), where('orgRef', '==', doc(analyticsDb, 'orgs/acme'))));
  await getDocs(query(collection(analyticsDb, 'items'), where('orgRef', '==', doc(defaultDb, 'orgs/acme'))));
  await getDocs(query(collection(defaultDb, 'orgs'), where('orgRef', '==', doc(analyticsDb, 'orgs/acme'))));
}`,
      },
      includeReads: true,
    });
    const diags = staticQueryProofPass(usage, {
      rules: {
        '(default)': defaultRules,
        analytics: analyticsRules,
      },
    });
    const sources = diags
      .filter((d) => d.certainty === 'static-proof')
      .map((d) => d.codeSite?.source);
    expect(sources).toEqual(['src/multi-db.ts:9', 'src/multi-db.ts:8']);
  });

  test('documentId() and literal-dot FieldPath segments agree with firestoreRules() and Sandbox', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow create: if true;
      allow read: if uid == 'u1';
    }
    match /docs/{docId} {
      allow create: if true;
      allow list: if resource.data.__name__ == 'd1';
    }
    match /nestedItems/{itemId} {
      allow create: if true;
      allow read: if resource.data.a.b == 'ok';
    }
    match /literalDotItems/{itemId} {
      allow create: if true;
      allow read: if resource.data['a.b'] == 'ok';
    }
  }
}`;
    const simSummary = firestoreRules(rules).simulate([
      {
        description: 'owner documentId allowed',
        expectation: 'ALLOW',
        method: 'get',
        path: 'users/u1',
        auth: { uid: 'u1' },
        resource: { label: 'one' },
      },
      {
        description: 'nested FieldPath(a, b) matches resource.data.a.b',
        expectation: 'ALLOW',
        method: 'get',
        path: 'nestedItems/n1',
        auth: { uid: 'u1' },
        resource: { a: { b: 'ok' } },
      },
      {
        description: 'literal-dot FieldPath(a.b) does not match resource.data.a.b',
        expectation: 'DENY',
        method: 'get',
        path: 'nestedItems/n1',
        auth: { uid: 'u1' },
        resource: { 'a.b': 'ok' },
      },
      {
        description: 'literal-dot FieldPath(a.b) matches resource.data["a.b"]',
        expectation: 'ALLOW',
        method: 'get',
        path: 'literalDotItems/i1',
        auth: { uid: 'u1' },
        resource: { 'a.b': 'ok' },
      },
      {
        description: 'nested FieldPath(a, b) does not match resource.data["a.b"]',
        expectation: 'DENY',
        method: 'get',
        path: 'literalDotItems/i1',
        auth: { uid: 'u1' },
        resource: { a: { b: 'ok' } },
      },
    ]);
    expect(simSummary.failed).toBe(0);

    const sandbox = initializeSandbox();
    const seedDb = getFirestore(sandbox);
    await setDoc(doc(seedDb, 'docs/d1'), { __name__: 'd1' });
    setRules(sandbox, rules);
    const userDb = getFirestore(sandbox.withAuth({ uid: 'u1', token: {} }));

    let docIdAgainstDataFieldAllowed = true;
    try {
      await getDocs(query(collection(userDb, 'docs'), where(documentId(), '==', 'd1')));
    } catch {
      docIdAgainstDataFieldAllowed = false;
    }
    expect(docIdAgainstDataFieldAllowed).toBe(false);

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/fp.ts': `import { FieldPath, collection, documentId, getDocs, getFirestore, query, where } from 'firebase/firestore';
export async function run() {
  const db = getFirestore();
  await getDocs(query(collection(db, 'users'), where(documentId(), '==', 'u1')));
  await getDocs(query(collection(db, 'docs'), where(documentId(), '==', 'd1')));
  await getDocs(query(collection(db, 'nestedItems'), where(new FieldPath('a', 'b'), '==', 'ok')));
  await getDocs(query(collection(db, 'nestedItems'), where(new FieldPath('a.b'), '==', 'ok')));
  await getDocs(query(collection(db, 'literalDotItems'), where(new FieldPath('a.b'), '==', 'ok')));
  await getDocs(query(collection(db, 'literalDotItems'), where(new FieldPath('a', 'b'), '==', 'ok')));
}`,
      },
      includeReads: true,
    });
    const diags = staticQueryProofPass(usage, { rules: { '(default)': rules } });
    const proofSources = diags
      .filter((d) => d.certainty === 'static-proof')
      .map((d) => d.codeSite?.source);
    expect(proofSources).toEqual(['src/fp.ts:5', 'src/fp.ts:7', 'src/fp.ts:9']);
  });

  test('seeded PRNG domain witness fuzzer agrees with firestoreRules().simulate() across numeric, string, wrapper, and array constraints', () => {
    const rng = createSeededRng(0x5eed1234);

    for (let trial = 0; trial < 40; trial += 1) {
      const lowerVal = Math.floor(rng() * 10) - 3;
      const span = Math.floor(rng() * 5);
      const upperVal = lowerVal + span;
      const lowerInclusive = rng() < 0.5;
      const upperInclusive = rng() < 0.5;
      const excluded: unknown[] = [];
      const excludeCount = Math.floor(rng() * 4);
      for (let i = 0; i < excludeCount; i += 1) {
        excluded.push(lowerVal + i);
      }
      if (trial % 9 === 0) {
        excluded.push(null);
      }

      let lowerOp: QueryWhereConstraint['op'] = '>';
      if (lowerInclusive) lowerOp = '>=';
      let upperOp: QueryWhereConstraint['op'] = '<';
      if (upperInclusive) upperOp = '<=';

      const constraints: QueryWhereConstraint[] = [
        { fieldPath: 'score', op: lowerOp, value: lowerVal },
        { fieldPath: 'score', op: upperOp, value: upperVal },
      ];
      if (excluded.length > 0) {
        constraints.push({ fieldPath: 'score', op: 'not-in', value: excluded });
      }

      const witness = synthesizeFieldWitness(constraints);
      const hasNullExclusion = excluded.includes(null);
      const singlePointCollapsed =
        span === 0 && (!lowerInclusive || !upperInclusive || excluded.includes(lowerVal));
      if (hasNullExclusion || singlePointCollapsed) {
        expect(witness).toBeUndefined();
        continue;
      }
      expect(typeof witness).toBe('number');
      const numericWitness = witness as number;
      if (lowerInclusive) {
        expect(numericWitness).toBeGreaterThanOrEqual(lowerVal);
      } else {
        expect(numericWitness).toBeGreaterThan(lowerVal);
      }
      if (upperInclusive) {
        expect(numericWitness).toBeLessThanOrEqual(upperVal);
      } else {
        expect(numericWitness).toBeLessThan(upperVal);
      }
      for (const item of excluded) {
        expect(numericWitness).not.toBe(item);
      }

      const ruleText = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow get: if resource.data.score ${lowerOp} ${lowerVal}
        && resource.data.score ${upperOp} ${upperVal};
    }
  }
}`;
      const sim = firestoreRules(ruleText).simulate([
        {
          description: `trial-${trial}`,
          expectation: 'ALLOW',
          method: 'get',
          path: 'items/i1',
          resource: { score: numericWitness },
        },
      ]);
      expect(sim.cases[0]!.decision).toBe('ALLOW');
    }

    const openUnitWitness = synthesizeFieldWitness([
      { fieldPath: 'ratio', op: '>', value: 0 },
      { fieldPath: 'ratio', op: '<', value: 1 },
    ]);
    expect(openUnitWitness).toBe(0.5);

    const tsWitness = synthesizeFieldWitness([
      { fieldPath: 'ts', op: '>', value: new RulesTimestamp(100, 0) },
      { fieldPath: 'ts', op: '<', value: new RulesTimestamp(100, 10) },
    ]);
    expect(tsWitness).toBeInstanceOf(RulesTimestamp);

    const durWitness = synthesizeFieldWitness([
      { fieldPath: 'dur', op: '>', value: new RulesDuration(5, 0) },
      { fieldPath: 'dur', op: '<', value: new RulesDuration(5, 4) },
    ]);
    expect(durWitness).toBeInstanceOf(RulesDuration);

    const bytesWitness = synthesizeFieldWitness([
      { fieldPath: 'raw', op: '>', value: new RulesBytes(new Uint8Array([1])) },
      { fieldPath: 'raw', op: '<', value: new RulesBytes(new Uint8Array([1, 2])) },
    ]);
    expect(bytesWitness).toBeInstanceOf(RulesBytes);

    const strWitness = synthesizeFieldWitness([
      { fieldPath: 'code', op: '>', value: 'a' },
      { fieldPath: 'code', op: '<', value: 'ab' },
      { fieldPath: 'code', op: 'not-in', value: ['aa'] },
    ]);
    expect(typeof strWitness).toBe('string');

    const arrayWitness = synthesizeFieldWitness([
      { fieldPath: 'tags', op: 'array-contains', value: 'alpha' },
      { fieldPath: 'tags', op: 'array-contains', value: 'beta' },
    ]);
    expect(arrayWitness).toEqual(['alpha', 'beta']);
  });
});
