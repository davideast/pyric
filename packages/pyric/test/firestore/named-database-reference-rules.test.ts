import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { applyFullState, captureFullState, initializeSandbox } from 'pyric/sandbox';
import { collection, doc, getDoc, getDocs, getFirestore, query, setDoc, updateDoc, where } from 'pyric/firestore';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';

describe('named-database DocumentReference rules isolation', () => {
  test('preserves named databaseId in Firestore rules and Storage firestore.get() lookups', async () => {
    const sb = initializeSandbox();
    const dbDefault = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const dbAnalytics = getFirestore(sb.withAuth({ uid: 'u1', token: {} }), 'analytics');

    seedDocuments(sb, {
      'items/i1': {
        analyticsRef: doc(dbAnalytics, 'orgs', 'org-1'),
        defaultRef: doc(dbDefault, 'orgs', 'org-1'),
      },
    });

    setRules(
      sb,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        '      allow get: if resource.data.analyticsRef == /databases/(default)/documents/orgs/org-1;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    await expect(getDoc(doc(dbDefault, 'items', 'i1'))).rejects.toThrow();

    setRules(
      sb,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        '      allow get: if resource.data.analyticsRef == /databases/analytics/documents/orgs/org-1',
        '        && resource.data.analyticsRef != resource.data.defaultRef',
        "        && string(resource.data.analyticsRef) == '/databases/analytics/documents/orgs/org-1';",
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    const snap = await getDoc(doc(dbDefault, 'items', 'i1'));
    expect(snap.exists()).toBe(true);

    const st = getStorageSandbox(sb.withAuth({ uid: 'u1', token: {} }), {
      dbName: 'named-db-ref-test',
      rules: [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        '    match /deny/{id} {',
        '      allow write: if firestore.get(/databases/(default)/documents/items/i1).data.analyticsRef',
        '        == /databases/(default)/documents/orgs/org-1;',
        '    }',
        '    match /allow/{id} {',
        '      allow write: if firestore.get(/databases/(default)/documents/items/i1).data.analyticsRef',
        '        == /databases/analytics/documents/orgs/org-1;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    });
    await expect(uploadBytes(storageRef(st, 'deny/f1'), new Uint8Array([1]))).rejects.toThrow();
    await uploadBytes(storageRef(st, 'allow/f2'), new Uint8Array([1]));
  });

  test('preserves DocumentReference paths containing segments named documents across rules, queries, and snapshots', async () => {
    const sb = initializeSandbox();
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    const dbAnalytics = getFirestore(sb.withAuth({ uid: 'u1', token: {} }), 'analytics');

    const rulesSource = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow create: if request.auth != null',
      '        && request.resource.data.memberRef == /databases/$(database)/documents/members/$(request.auth.uid);',
      '    }',
      '    match /links/{id} {',
      '      allow create, get, list: if true;',
      '      allow update: if request.resource.data.docRef == resource.data.docRef;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    setRules(sb, rulesSource);

    // Document ID named 'documents' ('orgs/documents/members/u1') must NOT spoof '/members/u1'.
    await expect(
      setDoc(doc(db, 'items', 'spoof'), {
        memberRef: doc(db, 'orgs', 'documents', 'members', 'u1'),
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    // Subcollection named 'documents' ('orgs/org-1/documents/doc-1' vs 'orgs/org-2/documents/doc-1')
    // must NOT collapse across tenants in rules, queries, or state snapshots.
    const org1DocRef = doc(db, 'orgs', 'org-1', 'documents', 'doc-1');
    const org2DocRef = doc(db, 'orgs', 'org-2', 'documents', 'doc-1');
    const namedOrg1DocRef = doc(dbAnalytics, 'orgs', 'org-1', 'documents', 'doc-1');

    await setDoc(doc(db, 'links', 'org1Link'), { docRef: org1DocRef, namedRef: namedOrg1DocRef });
    await setDoc(doc(db, 'links', 'org2Link'), { docRef: org2DocRef });

    await expect(
      updateDoc(doc(db, 'links', 'org1Link'), { docRef: org2DocRef }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    const matchingOrg1 = await getDocs(query(collection(db, 'links'), where('docRef', '==', org1DocRef)));
    expect(matchingOrg1.docs.map((d) => d.id)).toEqual(['org1Link']);

    const snap = sb.snapshot();
    const loadedSb = initializeSandbox();
    loadedSb.loadSnapshot(snap);
    const loadedDb = getFirestore(loadedSb.withAuth({ uid: 'u1', token: {} }));
    expect((await getDoc(doc(loadedDb, 'links', 'org1Link'))).data()?.docRef.path).toBe(
      'orgs/org-1/documents/doc-1',
    );
    expect((await getDoc(doc(loadedDb, 'links', 'org2Link'))).data()?.docRef.path).toBe(
      'orgs/org-2/documents/doc-1',
    );
    await expect(
      updateDoc(doc(loadedDb, 'links', 'org1Link'), {
        docRef: doc(loadedDb, 'orgs', 'org-2', 'documents', 'doc-1'),
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    const fullState = await captureFullState(sb);
    expect(fullState.firestore['links/org1Link']).toEqual({
      docRef: { __type: 'reference', path: 'orgs/org-1/documents/doc-1' },
      namedRef: {
        __type: 'reference',
        path: 'databases/analytics/documents/orgs/org-1/documents/doc-1',
      },
    });
    expect(fullState.firestore['links/org2Link']).toEqual({
      docRef: { __type: 'reference', path: 'orgs/org-2/documents/doc-1' },
    });
    const restoredSb = initializeSandbox();
    await applyFullState(restoredSb, fullState);
    const restoredDb = getFirestore(restoredSb.withAuth({ uid: 'u1', token: {} }));
    await expect(
      updateDoc(doc(restoredDb, 'links', 'org1Link'), {
        docRef: doc(restoredDb, 'orgs', 'org-2', 'documents', 'doc-1'),
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
