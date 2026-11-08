import { describe, expect, test } from 'bun:test';
import { firestoreRules } from 'pyric/rules';
import { resolveModules } from 'pyric/rules/internal/node';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  where,
} from 'pyric/firestore';

async function expectPermissionDenied(op: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await op;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(caught).toMatchObject({ code: 'permission-denied' });
}

describe('Multi-root service blocks and recursive root prefix bindings', () => {
  test('evaluates getDoc, getDocs, collectionGroup, and module resolution across multiple top-level match blocks', async () => {
    const helperModule = `
export function isSignedInOwner(ownerId) {
  return request.auth != null && request.auth.uid == ownerId;
}
`;
    const moduleRules = `rules_version = '2+modules';
import { isSignedInOwner } from './auth';

service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
  }
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if isSignedInOwner(resource.data.owner);
    }
    match /{path=**}/notes/{noteId} {
      allow read: if isSignedInOwner(resource.data.owner);
    }
  }
}`;

    const resolved = resolveModules(moduleRules, {
      modules: { './auth': helperModule },
      targetService: 'cloud.firestore',
    });
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;

    const ruleset = firestoreRules(resolved.data.resolved);
    expect(ruleset.lint().filter((i) => i.severity === 'error')).toEqual([]);

    const sandbox = initializeSandbox({});
    setRules(sandbox, resolved.data.resolved);
    seedDocuments(sandbox, {
      'users/u1': { handle: 'u1' },
      'items/i1': { owner: 'u1', title: 'First' },
      'items/i2': { owner: 'u2', title: 'Second' },
      'orgs/o1/notes/n1': { owner: 'u1', body: 'Note 1' },
      'orgs/o2/notes/n2': { owner: 'u2', body: 'Note 2' },
    });

    const db = getFirestore(sandbox.withAuth({ uid: 'u1' }));

    const itemSnap = await getDoc(doc(db, 'items', 'i1'));
    expect(itemSnap.exists()).toBe(true);
    expect(itemSnap.data()?.title).toBe('First');

    await expectPermissionDenied(getDoc(doc(db, 'items', 'i2')));

    const listSnap = await getDocs(
      query(collection(db, 'items'), where('owner', '==', 'u1')),
    );
    expect(listSnap.docs.map((d) => d.id)).toEqual(['i1']);

    const groupSnap = await getDocs(
      query(collectionGroup(db, 'notes'), where('owner', '==', 'u1')),
    );
    expect(groupSnap.docs.map((d) => d.id)).toEqual(['n1']);
  });

  test('denies getDoc and getDocs when recursive root wildcard Path binding is compared to string fields', async () => {
    const recursiveRootRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{prefix=**}/documents {
    match /items/{id} {
      allow read: if resource.data.parent == prefix || prefix in resource.data.parents;
    }
  }
}`;

    const sandbox = initializeSandbox({});
    setRules(sandbox, recursiveRootRules);
    seedDocuments(sandbox, {
      'items/i1': {
        parent: '(default)',
        parents: ['(default)'],
      },
    });

    const db = getFirestore(sandbox.withAuth({ uid: 'u1' }));

    await expectPermissionDenied(getDoc(doc(db, 'items', 'i1')));

    await expectPermissionDenied(
      getDocs(query(collection(db, 'items'), where('parent', '==', '(default)'))),
    );

    await expectPermissionDenied(
      getDocs(
        query(
          collection(db, 'items'),
          where('parents', 'array-contains', '(default)'),
        ),
      ),
    );
  });
});
