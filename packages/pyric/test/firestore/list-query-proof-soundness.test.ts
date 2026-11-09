import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  collectionGroup,
  doc,
  getAdminFirestore,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
} from 'pyric/firestore';
import { firestoreRules } from 'pyric/rules';

async function isAllowed(operation: Promise<unknown>): Promise<boolean> {
  try {
    await operation;
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === 'permission-denied') return false;
    throw err;
  }
}

describe('Firestore list query proof soundness', () => {
  it('denies array-contains list queries when a sibling hasAny list element throws at runtime', async () => {
    const rulesNullAuth = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.tags.hasAny(['public', request.auth.uid]);
    }
  }
}`;

    const sbAnon = initializeSandbox({ projectId: 'list-has-any-null-auth' });
    await setDoc(doc(getAdminFirestore(sbAnon), 'items/item-1'), { tags: ['public'] });
    setRules(sbAnon, rulesNullAuth);

    const anonDb = getFirestore(sbAnon.withAuth(null));
    expect(await isAllowed(getDoc(doc(anonDb, 'items/item-1')))).toBe(false);
    expect(
      await isAllowed(
        getDocs(query(collection(anonDb, 'items'), where('tags', 'array-contains', 'public'))),
      ),
    ).toBe(false);

    const snapshotCode = await new Promise<string>((resolve) => {
      const unsub = onSnapshot(
        query(collection(anonDb, 'items'), where('tags', 'array-contains', 'public')),
        () => {
          unsub();
          resolve('allowed');
        },
        (err) => {
          unsub();
          resolve(err.code);
        },
      );
    });
    expect(snapshotCode).toBe('permission-denied');

    const signedInDb = getFirestore(sbAnon.withAuth({ uid: 'user-1' }));
    const allowedSnap = await getDocs(
      query(collection(signedInDb, 'items'), where('tags', 'array-contains', 'public')),
    );
    expect(allowedSnap.docs.map((d) => d.id)).toEqual(['item-1']);

    const simNullAuth = firestoreRules(rulesNullAuth).simulate([
      {
        description: 'unauthenticated list with array-contains public',
        expectation: 'DENY',
        method: 'list',
        path: 'items/item-1',
        auth: null,
        query: {
          where: [{ field: 'tags', op: 'array-contains', value: 'public' }],
        },
      },
    ]);
    expect(simNullAuth.cases[0]?.decision).toBe('DENY');

    const rulesMissingClaim = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.tags.hasAny(['public', request.auth.token.orgId]);
    }
  }
}`;

    const sbClaim = initializeSandbox({ projectId: 'list-has-any-missing-claim' });
    await setDoc(doc(getAdminFirestore(sbClaim), 'items/item-1'), { tags: ['public'] });
    setRules(sbClaim, rulesMissingClaim);

    const missingClaimDb = getFirestore(sbClaim.withAuth({ uid: 'user-1', token: {} }));
    expect(await isAllowed(getDoc(doc(missingClaimDb, 'items/item-1')))).toBe(false);
    expect(
      await isAllowed(
        getDocs(
          query(collection(missingClaimDb, 'items'), where('tags', 'array-contains', 'public')),
        ),
      ),
    ).toBe(false);

    const withClaimDb = getFirestore(
      sbClaim.withAuth({ uid: 'user-1', token: { orgId: 'org-1' } }),
    );
    const withClaimSnap = await getDocs(
      query(collection(withClaimDb, 'items'), where('tags', 'array-contains', 'public')),
    );
    expect(withClaimSnap.docs.map((d) => d.id)).toEqual(['item-1']);

    await sbAnon.dispose();
    await sbClaim.dispose();
  });

  it('enforces the 1000-expression evaluation limit across preceding unprovable rules and OR branches on list queries', async () => {
    const overCapRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function step10(x) {
      return (x + 1) + (x + 2) + (x + 3) + (x + 4) + (x + 5);
    }
    function step100(x) {
      return step10(x) + step10(x + 1) + step10(x + 2) + step10(x + 3) + step10(x + 4);
    }
    function step500(x) {
      return step100(x) + step100(x + 1) + step100(x + 2) + step100(x + 3) + step100(x + 4);
    }
    match /items/{id} {
      allow read: if step500(1) == 999999 && resource.data.tier == 'vip';
      allow read: if step500(2) > 0 && resource.data.visibility == 'public';
    }
    match /docs/{docId} {
      allow read: if (step500(1) == 999999 && resource.data.tier == 'vip') || (step500(2) > 0 && resource.data.visibility == 'public');
    }
  }
}`;

    const sb = initializeSandbox({ projectId: 'list-expression-budget' });
    const adminDb = getAdminFirestore(sb);
    await setDoc(doc(adminDb, 'items/item-1'), { tier: 'basic', visibility: 'public' });
    await setDoc(doc(adminDb, 'docs/doc-1'), { tier: 'basic', visibility: 'public' });
    setRules(sb, overCapRules);

    const db = getFirestore(sb.withAuth({ uid: 'user-1' }));
    expect(await isAllowed(getDoc(doc(db, 'items/item-1')))).toBe(false);
    expect(await isAllowed(getDoc(doc(db, 'docs/doc-1')))).toBe(false);
    expect(
      await isAllowed(
        getDocs(query(collection(db, 'items'), where('visibility', '==', 'public'))),
      ),
    ).toBe(false);
    expect(
      await isAllowed(
        getDocs(query(collection(db, 'docs'), where('visibility', '==', 'public'))),
      ),
    ).toBe(false);

    const sim = firestoreRules(overCapRules).simulate([
      {
        description: 'list across two rules exceeding 1000 expressions',
        expectation: 'DENY',
        method: 'list',
        path: 'items/item-1',
        auth: { uid: 'user-1' },
        query: { where: [{ field: 'visibility', op: '==', value: 'public' }] },
      },
      {
        description: 'list across OR branches exceeding 1000 expressions',
        expectation: 'DENY',
        method: 'list',
        path: 'docs/doc-1',
        auth: { uid: 'user-1' },
        query: { where: [{ field: 'visibility', op: '==', value: 'public' }] },
      },
    ]);
    expect(sim.cases.map((c) => c.decision)).toEqual(['DENY', 'DENY']);

    // Balanced constant-false OR tree (> 1000 expressions vs < 1000 expressions) before provable branch
    const buildOrChain = (count: number): string => {
      const terms = Array.from({ length: count }, (_, i) => `${i} == ${i + 1}`);
      const buildBalanced = (lo: number, hi: number): string => {
        if (hi - lo === 1) return `(${terms[lo]})`;
        const mid = (lo + hi) >> 1;
        return `(${buildBalanced(lo, mid)} || ${buildBalanced(mid, hi)})`;
      };
      return buildBalanced(0, terms.length);
    };

    const heavyChainRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow read: if ${buildOrChain(200)} || resource.data.visibility == 'public';
    }
    match /notes/{noteId} {
      allow read: if ${buildOrChain(20)} || resource.data.visibility == 'public';
    }
  }
}`;
    await setDoc(doc(adminDb, 'posts/post-1'), { visibility: 'public' });
    await setDoc(doc(adminDb, 'notes/note-1'), { visibility: 'public' });
    setRules(sb, heavyChainRules);

    expect(
      await isAllowed(
        getDocs(query(collection(db, 'posts'), where('visibility', '==', 'public'))),
      ),
    ).toBe(false);
    const notesSnap = await getDocs(
      query(collection(db, 'notes'), where('visibility', '==', 'public')),
    );
    expect(notesSnap.docs.map((d) => d.id)).toEqual(['note-1']);

    await sb.dispose();
  });

  it('exposes request.query.orderBy as a Map of field names to ASC or DESC', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if request.query.orderBy.score == 'DESC' && request.query.limit <= 10;
    }
    match /docs/{docId} {
      allow list: if request.query.orderBy.tier == 'ASC'
        && request.query.orderBy.score == 'DESC'
        && request.query.orderBy.size() == 2;
    }
    match /orgs/{orgId} {
      allow list: if request.query.orderBy == 'score';
    }
    match /notes/{noteId} {
      allow list: if request.query.orderBy.size() == 0;
    }
  }
}`;

    const sb = initializeSandbox({ projectId: 'request-query-order-by-map' });
    const adminDb = getAdminFirestore(sb);
    await setDoc(doc(adminDb, 'items/item-1'), { score: 10 });
    await setDoc(doc(adminDb, 'docs/doc-1'), { tier: 1, score: 10 });
    await setDoc(doc(adminDb, 'orgs/org-1'), { score: 10 });
    await setDoc(doc(adminDb, 'notes/note-1'), { title: 'plain' });
    setRules(sb, rules);

    const db = getFirestore(sb.withAuth({ uid: 'user-1' }));
    expect(
      await isAllowed(getDocs(query(collection(db, 'items'), orderBy('score', 'desc'), limit(5)))),
    ).toBe(true);
    expect(
      await isAllowed(getDocs(query(collection(db, 'items'), orderBy('score', 'asc'), limit(5)))),
    ).toBe(false);
    expect(
      await isAllowed(
        getDocs(query(collection(db, 'docs'), orderBy('tier', 'asc'), orderBy('score', 'desc'))),
      ),
    ).toBe(true);
    expect(await isAllowed(getDocs(query(collection(db, 'orgs'), orderBy('score', 'desc'))))).toBe(
      false,
    );
    expect(await isAllowed(getDocs(collection(db, 'notes')))).toBe(true);

    const sim = firestoreRules(rules).simulate([
      {
        description: 'map orderBy on simulator list test case',
        expectation: 'ALLOW',
        method: 'list',
        path: 'docs',
        auth: { uid: 'user-1' },
        query: { orderBy: { tier: 'ASC', score: 'DESC' } },
      },
    ]);
    expect(sim.cases[0]?.decision).toBe('ALLOW');

    await sb.dispose();
  });

  it('proves positive OR list and collectionGroup rules when a sufficient branch is path-invariant', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if (request.auth != null && request.auth.uid == uid)
        || resource.data.visibility == 'public';
    }
    match /{path=**}/items/{id} {
      allow read: if id == 'item-pinned' || resource.data.visibility == 'public';
    }
    match /{path=**}/docs/{docId} {
      allow read: if path[0] == 'orgs' && resource.data.visibility == 'public';
    }
  }
}`;

    const sb = initializeSandbox({ projectId: 'positive-or-path-wildcard-proof' });
    const adminDb = getAdminFirestore(sb);
    await setDoc(doc(adminDb, 'users/user-1'), { visibility: 'public' });
    await setDoc(doc(adminDb, 'orgs/org-1/items/item-1'), { visibility: 'public' });
    await setDoc(doc(adminDb, 'orgs/org-1/docs/doc-1'), { visibility: 'public' });
    setRules(sb, rules);

    const anonDb = getFirestore(sb.withAuth(null));
    const usersSnap = await getDocs(
      query(collection(anonDb, 'users'), where('visibility', '==', 'public')),
    );
    expect(usersSnap.docs.map((d) => d.id)).toEqual(['user-1']);

    const groupItemsSnap = await getDocs(
      query(collectionGroup(anonDb, 'items'), where('visibility', '==', 'public')),
    );
    expect(groupItemsSnap.docs.map((d) => d.id)).toEqual(['item-1']);

    // Conjunctions and unnarrowed queries still fail closed
    expect(await isAllowed(getDocs(collection(anonDb, 'users')))).toBe(false);
    expect(await isAllowed(getDocs(collectionGroup(anonDb, 'items')))).toBe(false);
    expect(
      await isAllowed(
        getDocs(query(collectionGroup(anonDb, 'docs'), where('visibility', '==', 'public'))),
      ),
    ).toBe(false);

    await sb.dispose();
  });
});
