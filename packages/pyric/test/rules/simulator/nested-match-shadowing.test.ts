import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  doc,
  getAdminFirestore,
  getDoc,
  getDocs,
  getFirestore,
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

describe('nested match wildcard shadowing and lexical helper bindings', () => {
  it('resolves outer helper captures lexically and types single-segment wildcards shadowing recursive wildcards as string', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{id} {
      function isPublicOrg() {
        return id == 'org-public';
      }
      function matchesOrg(docOrgId) {
        return docOrgId == id;
      }
      match /items/{id} {
        allow get, list: if isPublicOrg();
      }
      match /scopedItems/{id} {
        allow get, list: if matchesOrg(resource.data.orgId);
      }
    }
    match /{id=**} {
      function hasExpectedPrefix() {
        return id is path && id == path('orgs/org-1');
      }
      match /docs/{id} {
        allow get: if hasExpectedPrefix() && id is string && id == 'doc-1';
      }
    }
  }
}`;

    const sb = initializeSandbox({ projectId: 'nested-match-shadowing' });
    const adminDb = getAdminFirestore(sb);
    await setDoc(doc(adminDb, 'orgs/org-secret/items/org-public'), { secret: true });
    await setDoc(doc(adminDb, 'orgs/org-public/items/item-1'), { secret: false });
    await setDoc(doc(adminDb, 'orgs/org-public/scopedItems/item-1'), { orgId: 'org-public' });
    await setDoc(doc(adminDb, 'orgs/org-secret/scopedItems/org-public'), { orgId: 'org-public' });
    await setDoc(doc(adminDb, 'orgs/org-1/docs/doc-1'), { ok: true });
    setRules(sb, rules);

    const db = getFirestore(sb.withAuth({ uid: 'user-1' }));

    expect(await isAllowed(getDoc(doc(db, 'orgs/org-secret/items/org-public')))).toBe(false);
    expect(await isAllowed(getDoc(doc(db, 'orgs/org-public/items/item-1')))).toBe(true);
    expect(await isAllowed(getDocs(collection(db, 'orgs/org-public/items')))).toBe(true);
    expect(await isAllowed(getDocs(collection(db, 'orgs/org-secret/items')))).toBe(false);

    expect(
      await isAllowed(
        getDocs(
          query(
            collection(db, 'orgs/org-public/scopedItems'),
            where('orgId', '==', 'org-public'),
          ),
        ),
      ),
    ).toBe(true);
    expect(
      await isAllowed(
        getDocs(
          query(
            collection(db, 'orgs/org-secret/scopedItems'),
            where('orgId', '==', 'org-public'),
          ),
        ),
      ),
    ).toBe(false);

    expect(await isAllowed(getDoc(doc(db, 'orgs/org-1/docs/doc-1')))).toBe(true);

    const sim = firestoreRules(rules).simulate([
      {
        description: 'secret org item whose child id collides with allowed org id',
        expectation: 'DENY',
        method: 'get',
        path: 'orgs/org-secret/items/org-public',
        auth: { uid: 'user-1' },
        resource: { secret: true },
      },
      {
        description: 'public org list query when child wildcard reuses outer wildcard name',
        expectation: 'ALLOW',
        method: 'list',
        path: 'orgs/org-public/items',
        auth: { uid: 'user-1' },
      },
      {
        description: 'single-segment wildcard shadowing recursive wildcard binds as string',
        expectation: 'ALLOW',
        method: 'get',
        path: 'orgs/org-1/docs/doc-1',
        auth: { uid: 'user-1' },
        resource: { ok: true },
      },
    ]);
    expect(sim.cases.map((c) => c.decision)).toEqual(['DENY', 'ALLOW', 'ALLOW']);

    await sb.dispose();
  });
});
