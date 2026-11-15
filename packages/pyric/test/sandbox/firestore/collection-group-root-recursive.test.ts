import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  collectionGroup,
  getDocs,
  getFirestore,
  query,
  where,
} from 'pyric/firestore';

function makeDb(rules: string, auth: { uid: string } | null = { uid: 'u1' }) {
  const sandbox = initializeSandbox({});
  seedDocuments(sandbox, {
    'items/root-1': { owner: 'u1', score: 1 },
    'orgs/o1/items/nested-1': { owner: 'u1', score: 0 },
    'orgs/o2/items/nested-2': { owner: 'u2', score: 1.5 },
  });
  setRules(sandbox, rules);
  if (auth) {
    return getFirestore(sandbox.withAuth(auth));
  }
  return getFirestore(sandbox);
}

const DENIED = { code: 'permission-denied' };

describe('collectionGroup authorization under root-recursive match blocks', () => {
  test('allows collectionGroup under root-recursive match with path-invariant own allow', async () => {
    const db = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{document=**} {
    allow read: if true;
  }
}`);
    const snap = await getDocs(collectionGroup(db, 'items'));
    expect(snap.size).toBe(3);
  });

  test('allows collectionGroup under root-recursive match with direct collection child block', async () => {
    const db = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{path=**} {
    match /items/{id} {
      allow list: if true;
    }
  }
}`);
    const snap = await getDocs(collectionGroup(db, 'items'));
    expect(snap.size).toBe(3);
  });

  test('enforces query filter proof and retains root helpers under root-recursive match', async () => {
    const db = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{document=**} {
    function isOwner() {
      return request.auth != null && resource.data.owner == request.auth.uid;
    }
    allow list: if isOwner();
  }
}`);
    await expect(getDocs(collectionGroup(db, 'items'))).rejects.toMatchObject(DENIED);
    const snap = await getDocs(query(collectionGroup(db, 'items'), where('owner', '==', 'u1')));
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['nested-1', 'root-1']);
  });

  test('allows collectionGroup under wider recursive root shapes', async () => {
    const dbBelowDatabase = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/{rest=**} {
    allow read: if true;
  }
}`);
    expect((await getDocs(collectionGroup(dbBelowDatabase, 'items'))).size).toBe(3);

    const dbTopRecursive = makeDb(`rules_version = '2';
service cloud.firestore {
  match /{rest=**} {
    allow read: if true;
  }
}`);
    expect((await getDocs(collectionGroup(dbTopRecursive, 'items'))).size).toBe(3);
  });

  test('denies path-dependent root-recursive allows and path-dependent child allows', async () => {
    const pathBoundRoot = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{document=**} {
    allow read: if document == 'items/__listPlaceholder__';
  }
}`);
    await expect(getDocs(collectionGroup(pathBoundRoot, 'items'))).rejects.toMatchObject(DENIED);

    const requestPathRoot = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{document=**} {
    allow read: if request.path.document == 'items/__listPlaceholder__';
  }
}`);
    await expect(getDocs(collectionGroup(requestPathRoot, 'items'))).rejects.toMatchObject(DENIED);

    const childReadsRootBinding = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{path=**} {
    match /items/{id} {
      allow list: if path == 'orgs/o1';
    }
  }
}`);
    await expect(getDocs(collectionGroup(childReadsRootBinding, 'items'))).rejects.toMatchObject(DENIED);

    const childReadsIdBinding = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{path=**} {
    match /items/{id} {
      allow list: if id == 'root-1';
    }
  }
}`);
    await expect(getDocs(collectionGroup(childReadsIdBinding, 'items'))).rejects.toMatchObject(DENIED);
  });

  test('denies non-recursive root own allows, fixed-prefix nested matches, and v1 root-recursive matches', async () => {
    const nonRecursiveRootOwnAllow = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    allow read: if true;
  }
}`);
    await expect(getDocs(collectionGroup(nonRecursiveRootOwnAllow, 'items'))).rejects.toMatchObject(DENIED);

    const nonRecursiveRootWithDenyingChild = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    allow read: if true;
    match /{document=**} {
      allow list: if false;
    }
  }
}`);
    await expect(getDocs(collectionGroup(nonRecursiveRootWithDenyingChild, 'items'))).rejects.toMatchObject(DENIED);

    const fixedPrefixNested = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{path=**} {
    match /orgs/{orgId}/items/{id} {
      allow list: if true;
    }
  }
}`);
    await expect(getDocs(collectionGroup(fixedPrefixNested, 'items'))).rejects.toMatchObject(DENIED);

    const twoLevelNested = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{path=**} {
    match /orgs/{orgId} {
      match /items/{id} {
        allow list: if true;
      }
    }
  }
}`);
    await expect(getDocs(collectionGroup(twoLevelNested, 'items'))).rejects.toMatchObject(DENIED);

    const v1RootRecursive = makeDb(`rules_version = '1';
service cloud.firestore {
  match /databases/{database}/documents/{document=**} {
    allow read: if true;
  }
}`);
    await expect(getDocs(collectionGroup(v1RootRecursive, 'items'))).rejects.toMatchObject(DENIED);
  });

  test('enforces lookup budget from a path-dependent root-recursive allow before a granting sibling', async () => {
    const lookups = Array.from(
      { length: 11 },
      (_, idx) => `exists(/databases/$(database)/documents/flags/f${idx})`,
    ).join(' && ');
    const db = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{document=**} {
    allow list: if document == 'orgs/o1' && ${lookups};
    allow list: if true;
  }
}`);
    await expect(getDocs(collectionGroup(db, 'items'))).rejects.toMatchObject(DENIED);
  });

  test('denies int-only list rules in sandbox for safe integer equality filters while allowing float-only fractional filters', async () => {
    const intOnlyDb = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if resource.data.score is int;
    }
  }
}`);
    await expect(
      getDocs(query(collection(intOnlyDb, 'items'), where('score', '==', 1))),
    ).rejects.toMatchObject(DENIED);
    await expect(
      getDocs(query(collection(intOnlyDb, 'items'), where('score', '==', 0))),
    ).rejects.toMatchObject(DENIED);

    const floatOnlyDb = makeDb(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if resource.data.score is float;
    }
  }
}`);
    const snap = await getDocs(query(collection(floatOnlyDb, 'items'), where('score', '==', 1.5)));
    expect(snap.size).toBe(0);
  });
});
