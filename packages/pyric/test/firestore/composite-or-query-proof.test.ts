import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  and,
  collection,
  collectionGroup,
  getDocs,
  getFirestore,
  or,
  query,
  where,
} from 'pyric/firestore';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';

describe('composite or(...) list-query proof', () => {
  test('authorizes composite or(...) queries when every disjunctive arm satisfies the list rule, and denies when any arm is unprovable', async () => {
    const sb = initializeSandbox();
    setRules(
      sb,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        '      allow get, list: if request.auth != null',
        "        && (resource.data.ownerId == request.auth.uid || resource.data.visibility == 'public');",
        '    }',
        '    match /{path=**}/entries/{id} {',
        '      allow list: if request.auth != null',
        "        && (resource.data.ownerId == request.auth.uid || resource.data.visibility == 'public');",
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    seedDocuments(sb, {
      'items/i1': { ownerId: 'u1', visibility: 'private', kind: 'note' },
      'items/i2': { ownerId: 'u2', visibility: 'public', kind: 'note' },
      'items/i3': { ownerId: 'u2', visibility: 'private', kind: 'note' },
      'orgs/o1/entries/e1': { ownerId: 'u1', visibility: 'private' },
      'orgs/o2/entries/e2': { ownerId: 'u2', visibility: 'public' },
    });

    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    const snap = await getDocs(
      query(
        collection(db, 'items'),
        or(where('ownerId', '==', 'u1'), where('visibility', '==', 'public')),
      ),
    );
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['i1', 'i2']);

    // Nested and(..., or(...)) distributes conjunctions into each disjunctive arm.
    const nestedSnap = await getDocs(
      query(
        collection(db, 'items'),
        and(
          where('kind', '==', 'note'),
          or(where('ownerId', '==', 'u1'), where('visibility', '==', 'public')),
        ),
      ),
    );
    expect(nestedSnap.docs.map((d) => d.id).sort()).toEqual(['i1', 'i2']);

    // Collection-group query with composite or(...) also authorizes when every arm is provable.
    const cgSnap = await getDocs(
      query(
        collectionGroup(db, 'entries'),
        or(where('ownerId', '==', 'u1'), where('visibility', '==', 'public')),
      ),
    );
    expect(cgSnap.docs.map((d) => d.id).sort()).toEqual(['e1', 'e2']);

    // Unprovable arm inside or(...) must deny the entire query ("rules are not filters").
    await expect(
      getDocs(
        query(
          collection(db, 'items'),
          or(where('ownerId', '==', 'u1'), where('visibility', '==', 'private')),
        ),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
