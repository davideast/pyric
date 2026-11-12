import { describe, expect, test } from 'bun:test';
import { bytes, firestoreRules, latlng, reference, timestamp } from 'pyric/rules';
import { initializeSandbox } from 'pyric/sandbox';
import {
  Bytes,
  GeoPoint,
  Timestamp,
  and,
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  or,
  query,
  where,
} from 'pyric/firestore';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';

describe('Firestore list-query prover counterexample-universe soundness', () => {
  test('every document returned by authorized typed, composite-OR, and collectionGroup list queries is individually allowed by getDoc and simulate()', async () => {
    const sb = initializeSandbox();
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const dbOther = getFirestore(sb.withAuth({ uid: 'u1', token: {} }), 'archive');

    const org1 = doc(db, 'orgs', 'org-1');
    const org2 = doc(db, 'orgs', 'org-2');
    const archiveOrg1 = doc(dbOther, 'orgs', 'org-1');
    const t2026 = Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z'));
    const t2025 = Timestamp.fromDate(new Date('2025-01-01T00:00:00.000Z'));
    const bTag = Bytes.fromUint8Array(new Uint8Array([0x61, 0x62]));
    const bOther = Bytes.fromUint8Array(new Uint8Array([0x63, 0x64]));
    const gLoc = new GeoPoint(10, 20);
    const gOther = new GeoPoint(-10, -20);

    // Counterexample universe spanning matching docs, wrong-typed values, cross-db refs, and private docs.
    seedDocuments(sb, {
      'items/match-owner': {
        ownerId: 'u1',
        visibility: 'private',
        orgRef: org1,
        dueAt: t2026,
        tagBytes: bTag,
        loc: gLoc,
      },
      'items/match-public': {
        ownerId: 'u2',
        visibility: 'public',
        orgRef: org2,
        dueAt: t2025,
        tagBytes: bOther,
        loc: gOther,
      },
      'items/counter-private': {
        ownerId: 'u2',
        visibility: 'private',
        orgRef: archiveOrg1,
        dueAt: t2025,
        tagBytes: bOther,
        loc: gOther,
      },
      'orgs/o1/entries/e1': { ownerId: 'u1', visibility: 'private' },
      'orgs/o2/entries/e2': { ownerId: 'u2', visibility: 'public' },
      'orgs/o2/entries/e3': { ownerId: 'u2', visibility: 'private' },
    });

    const simResources: Record<string, Record<string, unknown>> = {
      'items/match-owner': {
        ownerId: 'u1',
        visibility: 'private',
        orgRef: reference('orgs/org-1'),
        dueAt: timestamp('2026-01-01T00:00:00.000Z'),
        tagBytes: bytes(new Uint8Array([0x61, 0x62])),
        loc: latlng(10, 20),
      },
      'items/match-public': {
        ownerId: 'u2',
        visibility: 'public',
        orgRef: reference('orgs/org-2'),
        dueAt: timestamp('2025-01-01T00:00:00.000Z'),
        tagBytes: bytes(new Uint8Array([0x63, 0x64])),
        loc: latlng(-10, -20),
      },
      'orgs/o1/entries/e1': { ownerId: 'u1', visibility: 'private' },
      'orgs/o2/entries/e2': { ownerId: 'u2', visibility: 'public' },
    };

    const allowedMatrix: Array<{
      name: string;
      rules: string;
      buildQuery: () => ReturnType<typeof query>;
      expectedPaths: string[];
    }> = [
      {
        name: 'typed conjunction over Reference, Timestamp, Bytes, and GeoPoint',
        rules: [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /items/{id} {',
          '      allow get, list: if resource.data.orgRef == /databases/$(database)/documents/orgs/org-1',
          '        && resource.data.dueAt == timestamp.date(2026, 1, 1)',
          "        && resource.data.tagBytes == b'ab'",
          '        && resource.data.loc == latlng.value(10.0, 20.0);',
          '    }',
          '  }',
          '}',
        ].join('\n'),
        buildQuery: () =>
          query(
            collection(db, 'items'),
            and(
              where('orgRef', '==', org1),
              where('dueAt', '==', t2026),
              where('tagBytes', '==', bTag),
              where('loc', '==', gLoc),
            ),
          ),
        expectedPaths: ['items/match-owner'],
      },
      {
        name: 'composite or(...) over ownerId and visibility',
        rules: [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /items/{id} {',
          '      allow get, list: if request.auth != null',
          "        && (resource.data.ownerId == request.auth.uid || resource.data.visibility == 'public');",
          '    }',
          '  }',
          '}',
        ].join('\n'),
        buildQuery: () =>
          query(
            collection(db, 'items'),
            or(where('ownerId', '==', 'u1'), where('visibility', '==', 'public')),
          ),
        expectedPaths: ['items/match-owner', 'items/match-public'],
      },
      {
        name: 'collectionGroup with within-budget path-dependent || branch and composite or(...)',
        rules: [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /{path=**}/entries/{id} {',
          "      allow get, list: if (id == 'e1' && exists(/databases/$(database)/documents/configs/k0))",
          "        || (request.auth != null && (resource.data.ownerId == request.auth.uid || resource.data.visibility == 'public'));",
          '    }',
          '  }',
          '}',
        ].join('\n'),
        buildQuery: () =>
          query(
            collectionGroup(db, 'entries'),
            or(where('ownerId', '==', 'u1'), where('visibility', '==', 'public')),
          ),
        expectedPaths: ['orgs/o1/entries/e1', 'orgs/o2/entries/e2'],
      },
    ];

    for (const entry of allowedMatrix) {
      setRules(sb, entry.rules);
      const ruleset = firestoreRules(entry.rules);
      const snap = await getDocs(entry.buildQuery());
      const returnedPaths = snap.docs.map((d) => d.ref.path).sort();
      expect(returnedPaths).toEqual(entry.expectedPaths);

      // Soundness: every returned document must be allowed individually by both getDoc and simulate().
      for (const docPath of returnedPaths) {
        expect((await getDoc(doc(db, docPath))).exists()).toBe(true);
        const sim = ruleset.simulate([
          {
            description: `${entry.name}: ${docPath}`,
            expectation: 'ALLOW',
            method: 'get',
            path: docPath,
            auth: { uid: 'u1' },
            resource: simResources[docPath],
          },
        ]);
        expect(sim.cases[0]?.decision).toBe('ALLOW');
      }
    }

    // Counterexample soundness: budget-exhausting collectionGroup rules must NEVER allow when single-doc denies.
    const elevenLookups = Array.from(
      { length: 11 },
      (_, i) => `exists(/databases/$(database)/documents/configs/k${i})`,
    ).join(' || ');
    const budgetExhaustedRules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /{path=**}/entries/{id} {',
      `      allow get, list: if (id == 'e1' && (${elevenLookups})) || request.auth != null;`,
      '    }',
      '  }',
      '}',
    ].join('\n');

    setRules(sb, budgetExhaustedRules);
    const singleSim = firestoreRules(budgetExhaustedRules).simulate([
      {
        description: 'single doc e1 exceeds lookup budget',
        expectation: 'DENY',
        method: 'get',
        path: 'orgs/o1/entries/e1',
        auth: { uid: 'u1' },
        resource: simResources['orgs/o1/entries/e1'],
      },
    ]);
    expect(singleSim.cases[0]?.decision).toBe('DENY');
    await expect(getDoc(doc(db, 'orgs/o1/entries/e1'))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(getDocs(collectionGroup(db, 'entries'))).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
