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
  setDoc,
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

  test('SD:FS-LIST-PROVER standing check: lookup-budget counterexamples never allow getDocs when single-doc getDoc/simulate denies', async () => {
    const lookups = (count: number, offset = 0) =>
      Array.from(
        { length: count },
        (_, i) => `exists(/databases/$(database)/documents/configs/k${offset + i})`,
      ).join(' || ');

    const sb = initializeSandbox();
    seedDocuments(sb, {
      'items/poison': {
        flag: true,
        visibility: 'public',
        k0: 'a0',
        k1: 'a1',
        k2: 'a2',
        k3: 'a3',
        k4: 'a4',
        k5: 'a5',
        k6: 'a6',
        k7: 'a7',
        k8: 'a8',
        k9: 'a9',
        k10: 'a10',
      },
      'items/clean': {
        flag: false,
        visibility: 'public',
      },
      'orgs/o1/entries/e1': {
        flag: true,
        visibility: 'public',
      },
    });
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    const poisonResource = {
      flag: true,
      visibility: 'public',
      k0: 'a0',
      k1: 'a1',
      k2: 'a2',
      k3: 'a3',
      k4: 'a4',
      k5: 'a5',
      k6: 'a6',
      k7: 'a7',
      k8: 'a8',
      k9: 'a9',
      k10: 'a10',
    };

    const budgetBypassCorpus: Array<{
      name: string;
      rules: string;
      counterexamplePath: string;
      counterexampleResource: Record<string, unknown>;
      runList: () => Promise<unknown>;
    }> = [
      {
        name: 'unconstrained resource.data membership guard in || branch',
        rules: `
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              match /items/{id} {
                allow get, list: if ('flag' in resource.data && (${lookups(11)})) || request.auth != null;
              }
            }
          }
        `,
        counterexamplePath: 'items/poison',
        counterexampleResource: poisonResource,
        runList: () => getDocs(collection(db, 'items')),
      },
      {
        name: 'negated resource.data membership guard short-circuiting ||',
        rules: `
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              match /items/{id} {
                allow get, list: if ((!('flag' in resource.data)) || (${lookups(11)})) && false || request.auth != null;
              }
            }
          }
        `,
        counterexamplePath: 'items/poison',
        counterexampleResource: poisonResource,
        runList: () => getDocs(collection(db, 'items')),
      },
      {
        name: 'preceding allow rule guarded by resource.data.get()',
        rules: `
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              match /items/{id} {
                allow get, list: if resource.data.get('flag', false) == true && (${lookups(11)});
                allow get, list: if request.auth != null;
              }
            }
          }
        `,
        counterexamplePath: 'items/poison',
        counterexampleResource: poisonResource,
        runList: () => getDocs(collection(db, 'items')),
      },
      {
        name: 'split lookup budget across preceding allow rule (6) and || branch (5)',
        rules: `
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              match /items/{id} {
                allow get, list: if ('flag' in resource.data && (${lookups(6, 0)})) && false;
                allow get, list: if (resource.data.get('flag', false) == true && (${lookups(5, 6)})) || request.auth != null;
              }
            }
          }
        `,
        counterexamplePath: 'items/poison',
        counterexampleResource: poisonResource,
        runList: () => getDocs(collection(db, 'items')),
      },
      {
        name: 'ternary condition reading unconstrained resource.data field',
        rules: `
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              match /items/{id} {
                allow get, list: if (resource.data.flag ? (${lookups(11)}) : false) || request.auth != null;
              }
            }
          }
        `,
        counterexamplePath: 'items/poison',
        counterexampleResource: poisonResource,
        runList: () => getDocs(collection(db, 'items')),
      },
      {
        name: 'dynamic lookup path segments reading unconstrained resource.data fields',
        rules: `
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              match /items/{id} {
                allow get, list: if (${Array.from(
                  { length: 11 },
                  (_, i) => `exists(/databases/$(database)/documents/configs/$(resource.data.k${i}))`,
                ).join(' || ')}) || request.auth != null;
              }
            }
          }
        `,
        counterexamplePath: 'items/poison',
        counterexampleResource: poisonResource,
        runList: () => getDocs(collection(db, 'items')),
      },
      {
        name: 'collection helper-wrapped candidate id guard',
        rules: `
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              function isPoison(docId) {
                return docId == 'poison' && (${lookups(11)});
              }
              match /items/{id} {
                allow get, list: if isPoison(id) || request.auth != null;
              }
            }
          }
        `,
        counterexamplePath: 'items/poison',
        counterexampleResource: poisonResource,
        runList: () => getDocs(collection(db, 'items')),
      },
      {
        name: 'collectionGroup helper-wrapped candidate id guard',
        rules: `
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              function specialEntry(docId) {
                return docId == 'e1' && (${lookups(11)});
              }
              match /{path=**}/entries/{id} {
                allow get, list: if specialEntry(id) || request.auth != null;
              }
            }
          }
        `,
        counterexamplePath: 'orgs/o1/entries/e1',
        counterexampleResource: { flag: true, visibility: 'public' },
        runList: () => getDocs(collectionGroup(db, 'entries')),
      },
      {
        name: 'collectionGroup combined path and resource guard',
        rules: `
          rules_version = '2';
          service cloud.firestore {
            match /databases/{database}/documents {
              match /{path=**}/entries/{id} {
                allow get, list: if (id == 'e1' && 'flag' in resource.data && (${lookups(11)})) || request.auth != null;
              }
            }
          }
        `,
        counterexamplePath: 'orgs/o1/entries/e1',
        counterexampleResource: { flag: true, visibility: 'public' },
        runList: () => getDocs(collectionGroup(db, 'entries')),
      },
    ];

    for (const scenario of budgetBypassCorpus) {
      setRules(sb, scenario.rules);
      const sim = firestoreRules(scenario.rules).simulate([
        {
          description: scenario.name,
          expectation: 'DENY',
          method: 'get',
          path: scenario.counterexamplePath,
          auth: { uid: 'u1' },
          resource: scenario.counterexampleResource,
        },
      ]);
      expect(sim.cases[0]?.decision).toBe('DENY');
      expect(sim.cases[0]?.resourceLimit?.kind).toBe('document-lookups');
      await expect(getDoc(doc(db, scenario.counterexamplePath))).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(scenario.runList()).rejects.toMatchObject({
        code: 'permission-denied',
      });
    }

    // Positive control: when query pins flag == false, the poison document is outside the query domain
    // and the 11-lookup branch is provably unreachable on every matching document.
    setRules(
      sb,
      `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /items/{id} {
              allow get, list: if (resource.data.flag == true && (${lookups(11)})) || request.auth != null;
            }
          }
        }
      `,
    );
    const pinnedSnap = await getDocs(query(collection(db, 'items'), where('flag', '==', false)));
    expect(pinnedSnap.docs.map((d) => d.id)).toEqual(['clean']);
  });

  test('SD:FS-LIST-PROVER standing check: Reference pins and prototype-chain keys maintain getDoc/getDocs/simulate parity', async () => {
    const sb = initializeSandbox();
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const userRef = doc(db, 'users', 'u1');
    const teamRef = doc(db, 'teams', 't1');

    seedDocuments(sb, {
      'users/u1': { active: true },
      'refItems/r1': {
        ownerRef: userRef,
        watchers: [userRef, teamRef],
      },
    });

    const refRules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /refItems/{id} {
            allow get, list: if resource.data.ownerRef is reference
              && resource.data.ownerRef is path
              && resource.data.ownerRef.id == request.auth.uid
              && resource.data.ownerRef.parent == 'users'
              && resource.data.ownerRef.path == 'users/' + request.auth.uid
              && get(resource.data.ownerRef).data.active == true;
          }
        }
      }
    `;
    setRules(sb, refRules);
    expect((await getDoc(doc(db, 'refItems', 'r1'))).exists()).toBe(true);
    const eqSnap = await getDocs(query(collection(db, 'refItems'), where('ownerRef', '==', userRef)));
    expect(eqSnap.docs.map((d) => d.id)).toEqual(['r1']);
    const inSnap = await getDocs(query(collection(db, 'refItems'), where('ownerRef', 'in', [userRef])));
    expect(inSnap.docs.map((d) => d.id)).toEqual(['r1']);

    // Prototype-chain keys (__proto__, constructor, toString, valueOf) with both scalar and Reference values.
    const openCreateRules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /protoDocs/{id} {
            allow create: if request.auth != null;
          }
        }
      }
    `;
    setRules(sb, openCreateRules);
    await setDoc(doc(db, 'protoDocs', 'p1'), {
      ['__proto__']: 'safe',
      constructor: 'ctor-tag',
      toString: 'str-tag',
      valueOf: 'val-tag',
    });
    await setDoc(doc(db, 'protoDocs', 'pRef'), {
      ['__proto__']: userRef,
    });

    for (const [key, val] of [
      ['__proto__', 'safe'],
      ['constructor', 'ctor-tag'],
      ['toString', 'str-tag'],
      ['valueOf', 'val-tag'],
    ] as const) {
      const protoRules = `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /protoDocs/{id} {
              allow get, list: if resource.data['${key}'] == '${val}';
            }
          }
        }
      `;
      setRules(sb, protoRules);
      expect((await getDoc(doc(db, 'protoDocs', 'p1'))).exists()).toBe(true);
      const snap = await getDocs(query(collection(db, 'protoDocs'), where(key, '==', val)));
      expect(snap.docs.map((d) => d.id)).toEqual(['p1']);
    }

    setRules(
      sb,
      `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /protoDocs/{id} {
              allow get, list: if resource.data['__proto__'] is reference
                && resource.data['__proto__'].id == request.auth.uid;
            }
          }
        }
      `,
    );
    expect((await getDoc(doc(db, 'protoDocs', 'pRef'))).exists()).toBe(true);
    const protoRefSnap = await getDocs(query(collection(db, 'protoDocs'), where('__proto__', '==', userRef)));
    expect(protoRefSnap.docs.map((d) => d.id)).toEqual(['pRef']);
  });
});
