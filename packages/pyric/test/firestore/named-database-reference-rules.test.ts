import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getFirestore } from 'pyric/firestore';
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
});
