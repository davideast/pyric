import { describe, expect, test } from 'bun:test';
import { firestoreRules, type FirestoreCase } from 'pyric/rules';
import { initializeSandbox } from 'pyric/sandbox';
import {
  Bytes,
  GeoPoint,
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  where,
} from 'pyric/firestore';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';

describe('typed where(...) list-query proof', () => {
  test('authorizes equality, finite in, and array-contains list queries over DocumentReference, Timestamp, Bytes, and GeoPoint', async () => {
    const sb = initializeSandbox();
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const dbAnalytics = getFirestore(sb.withAuth({ uid: 'u1', token: {} }), 'analytics');

    const orgRef = doc(db, 'orgs', 'org-1');
    const otherOrgRef = doc(db, 'orgs', 'org-2');
    const foreignDbRef = doc(dbAnalytics, 'orgs', 'org-1');
    const dueAt = Timestamp.fromDate(new Date('2026-01-01T00:00:00.000Z'));
    const tagBytes = Bytes.fromUint8Array(new Uint8Array([0x61, 0x62]));
    const loc = new GeoPoint(10, 20);

    seedDocuments(sb, {
      'items/i1': {
        orgRef,
        dueAt,
        tagBytes,
        loc,
        watchers: [orgRef],
      },
    });

    const validCases: Array<[string, ReturnType<typeof where>]> = [
      ['resource.data.orgRef == /databases/$(database)/documents/orgs/org-1', where('orgRef', '==', orgRef)],
      [
        'resource.data.orgRef in [/databases/$(database)/documents/orgs/org-1, /databases/$(database)/documents/orgs/org-2]',
        where('orgRef', 'in', [orgRef, otherOrgRef]),
      ],
      ['/databases/$(database)/documents/orgs/org-1 in resource.data.watchers', where('watchers', 'array-contains', orgRef)],
      ['resource.data.dueAt == timestamp.date(2026, 1, 1)', where('dueAt', '==', dueAt)],
      ["resource.data.tagBytes == b'ab'", where('tagBytes', '==', tagBytes)],
      ['resource.data.loc == latlng.value(10.0, 20.0)', where('loc', '==', loc)],
    ];

    for (const [ruleExpr, clause] of validCases) {
      setRules(
        sb,
        [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /items/{id} {',
          `      allow get, list: if ${ruleExpr};`,
          '    }',
          '  }',
          '}',
        ].join('\n'),
      );
      expect((await getDoc(doc(db, 'items', 'i1'))).exists()).toBe(true);
      const snap = await getDocs(query(collection(db, 'items'), clause));
      expect(snap.size).toBe(1);
    }

    // Mismatched DocumentReference in where(...) denies with permission-denied;
    // cross-database DocumentReference throws invalid-argument at query construction.
    setRules(
      sb,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        '      allow list: if resource.data.orgRef == /databases/(default)/documents/orgs/org-1;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    await expect(getDocs(query(collection(db, 'items'), where('orgRef', '==', otherOrgRef)))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(() => query(collection(db, 'items'), where('orgRef', '==', foreignDbRef))).toThrow(
      expect.objectContaining({ code: 'invalid-argument' }),
    );

    // Unprovable typed query denial renders valid client expressions (no JSON __type blobs)
    // and produces a repro testCase that round-trips cleanly through firestoreRules().simulate().
    let caught: unknown;
    try {
      await getDocs(query(collection(db, 'items'), where('orgRef', '==', otherOrgRef)));
    } catch (e) {
      caught = e;
    }
    const denial = caught as {
      remediation?: string;
      denialContext?: { repro?: { command: string; testCase: FirestoreCase } };
    };
    const narrowingGuidance = denial.remediation?.split('\n\nReproduce with:')[0] ?? '';
    expect(narrowingGuidance).toContain(".where('orgRef', '==', doc(db, 'orgs', 'org-1'))");
    expect(narrowingGuidance).toContain("the query pins doc(db, 'orgs', 'org-2')");
    expect(narrowingGuidance).not.toContain('"__type"');

    const rulesSource = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow list: if resource.data.orgRef == /databases/(default)/documents/orgs/org-1;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const ruleset = firestoreRules(rulesSource);
    const jsonRoundTrippedCase = JSON.parse(
      JSON.stringify(denial.denialContext!.repro!.testCase),
    ) as FirestoreCase;
    const simDenial = ruleset.simulate([jsonRoundTrippedCase]).cases[0]!;
    expect(simDenial.queryProof?.verdict).toBe('UNPROVABLE');

    const simAllowed = ruleset.simulate([
      {
        ...jsonRoundTrippedCase,
        query: {
          where: [{ field: 'orgRef', op: '==', value: { __type: 'reference', path: 'orgs/org-1' } }],
        },
      },
    ]).cases[0]!;
    expect(simAllowed.queryProof?.verdict).toBe('PROVABLE');
    expect(simAllowed.decision).toBe('ALLOW');
  });
});
