import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import {
  Bytes,
  GeoPoint,
  Timestamp,
  collection,
  collectionGroup,
  doc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  setDoc,
  where,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { staticQueryProofPass } from '../../../src/assurance-surface/passes/static-query-proof.js';
import { storageContractPass } from '../../../src/assurance-surface/passes/storage-contract.js';
import { runProbes } from '../../../src/assurance-surface/probes/run-probes.js';
import { ProbeWorld } from '../../../src/assurance-surface/probes/world.js';
import { ownerConditionsFrom } from '../../../src/assurance-surface/rules/analyze-owners.js';
import { inferOwnerBindings } from '../../../src/assurance-surface/rules/cross-check.js';
import type { RuleSources } from '../../../src/assurance-surface/rules/rule-sources.js';
import { projectRuleSurface } from '../../../src/assurance-surface/rules/rule-surface.js';
import { extractSdkUsage } from '../../../src/assurance-surface/usage.js';

describe('assurance rules-semantics differential corpus', () => {
  test('staticQueryProofPass orderBy and limit projections agree with runtime Firestore list evaluation across single, compound, and dynamic query shapes', async () => {
    const queryCases = [
      {
        name: 'matching single orderBy direction',
        ruleExpr: "resource.data.orgId == 'acme' && request.query.orderBy.createdAt == 'DESC'",
        clientCall: "query(collection(db, 'items'), where('orgId', '==', 'acme'), orderBy('createdAt', 'desc'))",
        runtimeRun: (db: ReturnType<typeof getFirestore>) =>
          getDocs(query(collection(db, 'items'), where('orgId', '==', 'acme'), orderBy('createdAt', 'desc'))),
        expectRuntimeAllow: true,
        expectStaticProofFailure: false,
      },
      {
        name: 'mismatched single orderBy direction',
        ruleExpr: "resource.data.orgId == 'acme' && request.query.orderBy.createdAt == 'DESC'",
        clientCall: "query(collection(db, 'items'), where('orgId', '==', 'acme'), orderBy('createdAt', 'asc'))",
        runtimeRun: (db: ReturnType<typeof getFirestore>) =>
          getDocs(query(collection(db, 'items'), where('orgId', '==', 'acme'), orderBy('createdAt', 'asc'))),
        expectRuntimeAllow: false,
        expectStaticProofFailure: true,
      },
      {
        name: 'compound multi-field orderBy map',
        ruleExpr:
          "resource.data.orgId == 'acme' && request.query.orderBy.priority == 'DESC' && request.query.orderBy.createdAt == 'ASC' && request.query.limit <= 20",
        clientCall:
          "query(collection(db, 'items'), where('orgId', '==', 'acme'), orderBy('priority', 'desc'), orderBy('createdAt'), limit(10))",
        runtimeRun: (db: ReturnType<typeof getFirestore>) =>
          getDocs(
            query(
              collection(db, 'items'),
              where('orgId', '==', 'acme'),
              orderBy('priority', 'desc'),
              orderBy('createdAt'),
              limit(10),
            ),
          ),
        expectRuntimeAllow: true,
        expectStaticProofFailure: false,
      },
      {
        name: 'compound orderBy with second field wrong direction',
        ruleExpr:
          "resource.data.orgId == 'acme' && request.query.orderBy.priority == 'DESC' && request.query.orderBy.createdAt == 'ASC'",
        clientCall:
          "query(collection(db, 'items'), where('orgId', '==', 'acme'), orderBy('priority', 'desc'), orderBy('createdAt', 'desc'))",
        runtimeRun: (db: ReturnType<typeof getFirestore>) =>
          getDocs(
            query(
              collection(db, 'items'),
              where('orgId', '==', 'acme'),
              orderBy('priority', 'desc'),
              orderBy('createdAt', 'desc'),
            ),
          ),
        expectRuntimeAllow: false,
        expectStaticProofFailure: true,
      },
      {
        name: 'dynamic orderBy field downgrades certainty rather than emitting unsound static-proof',
        ruleExpr: "resource.data.orgId == 'acme' && request.query.orderBy.createdAt == 'DESC'",
        clientCall:
          "query(collection(db, 'items'), where('orgId', '==', 'acme'), orderBy(sortField, 'desc'))",
        runtimeRun: (db: ReturnType<typeof getFirestore>) =>
          getDocs(query(collection(db, 'items'), where('orgId', '==', 'acme'), orderBy('createdAt', 'desc'))),
        expectRuntimeAllow: true,
        expectStaticProofFailure: false,
      },
    ];

    for (const tc of queryCases) {
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow create: if true;
      allow get, list: if ${tc.ruleExpr};
    }
  }
}`;
      const sandbox = initializeSandbox();
      setRules(sandbox, rules);
      const adminDb = getFirestore(sandbox);
      await setDoc(doc(adminDb, 'items/i1'), {
        orgId: 'acme',
        priority: 5,
        createdAt: 100,
      });
      const userCtx = sandbox.withAuth({ uid: 'u-alice', token: {} });
      let runtimeAllowed = true;
      try {
        await tc.runtimeRun(getFirestore(userCtx));
      } catch {
        runtimeAllowed = false;
      }
      expect(runtimeAllowed).toBe(tc.expectRuntimeAllow);

      const usage = extractSdkUsage({
        root: '/app',
        files: {
          'src/list.ts': `import { getFirestore, collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
export async function run(sortField: string) {
  const db = getFirestore();
  return getDocs(${tc.clientCall});
}`,
        },
        includeReads: true,
      });
      const diagnostics = staticQueryProofPass(usage, {
        rules: { '(default)': rules },
      });
      const staticProofFailures = diagnostics.filter((d) => d.certainty === 'static-proof');
      if (tc.expectStaticProofFailure) {
        expect(staticProofFailures.length).toBeGreaterThan(0);
      } else {
        // Soundness invariant: if runtime ALLOWS the query, staticQueryProofPass must never emit static-proof failure.
        expect(staticProofFailures).toEqual([]);
      }
    }
  });

  test('storageContractPass and runProbes agree with Storage sandbox across conjoined RE2 contentType patterns and min/max size intervals', async () => {
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/assets/{fileName} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if request.auth != null
        && request.auth.uid == uid
        && request.resource.contentType.matches('image/.*')
        && request.resource.contentType.matches('.*/(png|webp)')
        && request.resource.size >= 8
        && request.resource.size <= 64;
    }
  }
}`;
    const uploadCorpus = [
      { contentType: 'image/png', size: 16, expectAllow: true, expectedCode: undefined },
      { contentType: 'image/webp', size: 8, expectAllow: true, expectedCode: undefined },
      { contentType: 'image/svg+xml', size: 16, expectAllow: false, expectedCode: 'storage-content-type-mismatch' },
      { contentType: 'application/png', size: 16, expectAllow: false, expectedCode: 'storage-content-type-mismatch' },
      { contentType: 'image/png', size: 4, expectAllow: false, expectedCode: 'storage-min-size-not-met' },
      { contentType: 'image/png', size: 128, expectAllow: false, expectedCode: 'storage-max-size-exceeded' },
    ];

    const surface = projectRuleSurface({
      storage: [{ source: 'storage.rules', text: storageRules }],
    });

    for (const sample of uploadCorpus) {
      const sandbox = initializeSandbox();
      getAdminStorageSandbox(sandbox, { rules: storageRules });
      const userCtx = sandbox.withAuth({ uid: 'u-alice', token: {} });
      const st = getAdminStorageSandbox(sandbox);
      void st;
      let runtimeAllowed = true;
      try {
        const { getStorageSandbox } = await import('pyric/storage');
        const clientStorage = getStorageSandbox(userCtx);
        await uploadBytes(
          storageRef(clientStorage, 'users/u-alice/assets/pic.bin'),
          new Uint8Array(sample.size),
          { contentType: sample.contentType },
        );
      } catch {
        runtimeAllowed = false;
      }
      expect(runtimeAllowed).toBe(sample.expectAllow);

      const byteLiteral = `new Uint8Array(${sample.size})`;
      const usage = extractSdkUsage({
        root: '/app',
        files: {
          'src/upload.ts': `import { getAuth } from 'firebase/auth';
import { getStorage, ref, uploadBytes } from 'firebase/storage';
export async function putAsset() {
  const uid = getAuth().currentUser!.uid;
  const st = getStorage();
  await uploadBytes(ref(st, \`users/\${uid}/assets/pic.bin\`), ${byteLiteral}, {
    contentType: '${sample.contentType}',
  });
}`,
        },
      });
      const diags = storageContractPass(usage, { ruleSurface: surface });
      if (sample.expectAllow) {
        expect(diags).toEqual([]);
      } else {
        expect(diags.map((d) => d.code)).toContain(sample.expectedCode!);
      }

      const sources: RuleSources = {
        firestore: [],
        rtdb: [],
        storage: [{ source: 'storage.rules', text: storageRules }],
        problems: [],
      };
      const conditions = ownerConditionsFrom(sources);
      const bindings = inferOwnerBindings(conditions, usage.operations);
      const report = await runProbes({
        accessSites: usage.operations,
        ownerBindings: bindings,
        conditions,
        sources,
      });
      const mustAllowHits = report.findings.filter((f) => f.kind === 'must-allow-denied');
      if (sample.expectAllow) {
        expect(mustAllowHits).toEqual([]);
      } else {
        expect(mustAllowHits.length).toBeGreaterThan(0);
      }
    }
  });

  test('claim extraction and ProbeWorld identity projection agree with authSandbox.mintSession across token.get, token.keys, and firebase.identities', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/docs/{docId} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create, update, delete: if request.auth != null
        && request.auth.token.keys().hasAll(['orgId', 'tier'])
        && 'tier' in request.auth.token.keys()
        && request.auth.token.get('tier', 'free') == 'pro'
        && request.auth.token.get(['roles', 'writer'], false) == true
        && 'google.com' in request.auth.token.firebase.identities;
    }
  }
}`;
    const seededUsers = [
      {
        uid: 'u-alice',
        email: 'alice@example.test',
        emailVerified: true,
        providerId: 'google.com',
        providerUserInfo: [
          {
            providerId: 'google.com',
            rawId: 'goog-alice',
            uid: 'goog-alice',
            email: 'alice@example.test',
          },
        ],
        customClaims: {
          orgId: 'acme',
          tier: 'pro',
          roles: { writer: true },
        },
      },
      {
        uid: 'u-bob',
        email: 'bob@example.test',
        emailVerified: true,
        providerId: 'google.com',
        providerUserInfo: [
          {
            providerId: 'google.com',
            rawId: 'goog-bob',
            uid: 'goog-bob',
            email: 'bob@example.test',
          },
        ],
        customClaims: {
          orgId: 'acme',
          tier: 'pro',
          roles: { writer: true },
        },
      },
    ];

    // 1. Live Sandbox + authSandbox.mintSession oracle
    const sandbox = initializeSandbox();
    setRules(sandbox, rules);
    const auth = getAuth(sandbox);
    authSandbox.seedUsers(auth, seededUsers);
    const aliceSession = authSandbox.mintSession(auth, { kind: 'uid', uid: 'u-alice' });
    const aliceDb = getFirestore(sandbox.withAuth(aliceSession.state));
    await setDoc(doc(aliceDb, 'users/u-alice/docs/d1'), { ownerId: 'u-alice', title: 'v1' });

    // 2. ProbeWorld parity with identical seeded user records
    const world = new ProbeWorld(
      { firestore: rules },
      [
        {
          role: 'owner',
          uid: 'u-alice',
          email: 'alice@example.test',
          displayName: 'Alice',
          token: { email_verified: true, orgId: 'acme', tier: 'pro', roles: { writer: true } },
        },
        {
          role: 'peer',
          uid: 'u-bob',
          email: 'bob@example.test',
          displayName: 'Bob',
          token: { email_verified: true, orgId: 'acme', tier: 'pro', roles: { writer: true } },
        },
      ],
      { users: seededUsers },
    );
    try {
      const ownerWrite = await world.run({
        actor: 'owner',
        service: 'firestore',
        method: 'create',
        path: 'users/u-alice/docs/d1',
        data: { ownerId: 'u-alice', title: 'v1' },
      });
      expect(ownerWrite.decision).toBe('allow');
    } finally {
      world.dispose();
    }

    // 3. End-to-end runProbes with synthetic actors (extracting claims from rules + providerUserInfo from state)
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/docs.ts': `import { getAuth } from 'firebase/auth';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
export async function saveDoc(docId: string) {
  const uid = getAuth().currentUser!.uid;
  await setDoc(doc(getFirestore(), \`users/\${uid}/docs/\${docId}\`), { ownerId: uid, title: 'v1' });
}`,
      },
    });
    const sources: RuleSources = {
      firestore: [{ source: 'firestore.rules', text: rules }],
      rtdb: [],
      storage: [],
      problems: [],
    };
    const conditions = ownerConditionsFrom(sources);
    const bindings = inferOwnerBindings(conditions, usage.operations);
    const probeReport = await runProbes({
      accessSites: usage.operations,
      ownerBindings: bindings,
      conditions,
      sources,
      users: seededUsers,
      state: { users: seededUsers },
    });
    expect(probeReport.findings.some((f) => f.kind === 'must-allow-denied')).toBe(false);
    expect(probeReport.findings.some((f) => f.kind === 'foreign-slot-write')).toBe(true);
  });

  test('staticQueryProofPass wrapper scalars and collection-group disjunctions preserve soundness against runtime RulesListAuthorizer', async () => {
    const overBudgetLookups = Array.from(
      { length: 11 },
      (_, idx) => `exists(/databases/$(database)/documents/flags/f${idx + 1})`,
    ).join(' || ');

    const cases: Array<{
      name: string;
      rules: string;
      clientCall: string;
      runtimeRun: (db: ReturnType<typeof getFirestore>) => Promise<unknown>;
      expectRuntimeAllow: boolean;
      expectStaticProofFailure: boolean;
      expectAnyFailure?: boolean;
    }> = [
      {
        name: 'static matching doc(db, ...) reference constraint',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow create: if true;
      allow list: if resource.data.orgRef == /databases/$(database)/documents/orgs/acme;
    }
  }
}`,
        clientCall: "query(collection(db, 'items'), where('orgRef', '==', doc(db, 'orgs', 'acme')))",
        runtimeRun: (db) =>
          getDocs(query(collection(db, 'items'), where('orgRef', '==', doc(db, 'orgs', 'acme')))),
        expectRuntimeAllow: true,
        expectStaticProofFailure: false,
      },
      {
        name: 'static mismatching doc(db, ...) reference constraint',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow create: if true;
      allow list: if resource.data.orgRef == /databases/$(database)/documents/orgs/acme;
    }
  }
}`,
        clientCall: "query(collection(db, 'items'), where('orgRef', '==', doc(db, 'orgs', 'other')))",
        runtimeRun: (db) =>
          getDocs(query(collection(db, 'items'), where('orgRef', '==', doc(db, 'orgs', 'other')))),
        expectRuntimeAllow: false,
        expectStaticProofFailure: true,
      },
      {
        name: 'dynamic unresolved doc(db, orgs, orgId) constraint preserves soundness',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow create: if true;
      allow list: if resource.data.orgRef == /databases/$(database)/documents/orgs/acme;
    }
  }
}`,
        clientCall: "query(collection(db, 'items'), where('orgRef', '==', doc(db, 'orgs', orgId)))",
        runtimeRun: (db) =>
          getDocs(query(collection(db, 'items'), where('orgRef', '==', doc(db, 'orgs', 'acme')))),
        expectRuntimeAllow: true,
        expectStaticProofFailure: false,
      },
      {
        name: 'static matching Timestamp, Bytes, and GeoPoint wrapper constraints',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow create: if true;
      allow list: if resource.data.publishedAt == timestamp.date(2026, 1, 1)
        && resource.data.header == b'\\x01\\x02'
        && resource.data.coords == latlng.value(37.5, -122.0);
    }
  }
}`,
        clientCall:
          "query(collection(db, 'items'), where('publishedAt', '==', Timestamp.fromMillis(1767225600000)), where('header', '==', Bytes.fromUint8Array(new Uint8Array([1, 2]))), where('coords', '==', new GeoPoint(37.5, -122.0)))",
        runtimeRun: (db) =>
          getDocs(
            query(
              collection(db, 'items'),
              where('publishedAt', '==', Timestamp.fromMillis(1_767_225_600_000)),
              where('header', '==', Bytes.fromUint8Array(new Uint8Array([1, 2]))),
              where('coords', '==', new GeoPoint(37.5, -122.0)),
            ),
          ),
        expectRuntimeAllow: true,
        expectStaticProofFailure: false,
      },
      {
        name: 'mixed pathDependent || pathInvariant collectionGroup rule with satisfying filter',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{path=**}/comments/{id} {
      allow create: if true;
      allow list: if id == 'pinned' || resource.data.public == true;
    }
  }
}`,
        clientCall: "query(collectionGroup(db, 'comments'), where('public', '==', true))",
        runtimeRun: (db) =>
          getDocs(query(collectionGroup(db, 'comments'), where('public', '==', true))),
        expectRuntimeAllow: true,
        expectStaticProofFailure: false,
      },
      {
        name: 'mixed pathDependent || pathInvariant collectionGroup rule without filter',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{path=**}/comments/{id} {
      allow create: if true;
      allow list: if id == 'pinned' || resource.data.public == true;
    }
  }
}`,
        clientCall: "collectionGroup(db, 'comments')",
        runtimeRun: (db) => getDocs(collectionGroup(db, 'comments')),
        expectRuntimeAllow: false,
        expectStaticProofFailure: true,
      },
      {
        name: 'collectionGroup rule exceeding lookup budget in dropped path-dependent branch',
        rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{path=**}/comments/{id} {
      allow create: if true;
      allow list: if (id == 'pinned' && (${overBudgetLookups})) || resource.data.public == true;
    }
  }
}`,
        clientCall: "query(collectionGroup(db, 'comments'), where('public', '==', true))",
        runtimeRun: (db) =>
          getDocs(query(collectionGroup(db, 'comments'), where('public', '==', true))),
        expectRuntimeAllow: false,
        expectStaticProofFailure: false,
        expectAnyFailure: true,
      },
    ];

    for (const tc of cases) {
      const sandbox = initializeSandbox();
      const seedDb = getFirestore(sandbox);
      await setDoc(doc(seedDb, 'items/i1'), {
        orgRef: doc(seedDb, 'orgs/acme'),
        publishedAt: Timestamp.fromMillis(1_767_225_600_000),
        header: Bytes.fromUint8Array(new Uint8Array([1, 2])),
        coords: new GeoPoint(37.5, -122.0),
      });
      await setDoc(doc(seedDb, 'posts/p1/comments/c1'), {
        public: true,
      });
      setRules(sandbox, tc.rules);

      const userCtx = sandbox.withAuth({ uid: 'u-alice', token: {} });
      let runtimeAllowed = true;
      try {
        await tc.runtimeRun(getFirestore(userCtx));
      } catch {
        runtimeAllowed = false;
      }
      expect(runtimeAllowed, tc.name).toBe(tc.expectRuntimeAllow);

      const usage = extractSdkUsage({
        root: '/app',
        files: {
          'src/list.ts': `import { Bytes, GeoPoint, Timestamp, collection, collectionGroup, doc, getDocs, getFirestore, query, where } from 'firebase/firestore';
export async function run(orgId: string) {
  const db = getFirestore();
  return getDocs(${tc.clientCall});
}`,
        },
        includeReads: true,
      });
      const diagnostics = staticQueryProofPass(usage, {
        rules: { '(default)': tc.rules },
      });
      const staticProofFailures = diagnostics.filter((d) => d.certainty === 'static-proof');
      if (tc.expectStaticProofFailure) {
        expect(staticProofFailures.length, tc.name).toBeGreaterThan(0);
      } else {
        expect(staticProofFailures, tc.name).toEqual([]);
      }
      if (tc.expectAnyFailure) {
        expect(diagnostics.length, tc.name).toBeGreaterThan(0);
      }
    }
  });
});
