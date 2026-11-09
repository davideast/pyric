import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { doc, getAdminFirestore, getFirestore, setDoc } from 'pyric/firestore';
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

describe('set({ merge: true }) after-state projection for empty nested maps', () => {
  it('replaces existing nested maps with an empty map instead of preserving prior keys', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      allow update: if request.resource.data.meta.locked == true;
    }
    match /items/{id} {
      allow update: if !('locked' in request.resource.data.meta)
        && request.resource.data.meta.size() == 0
        && request.resource.data.title == 'kept'
        && getAfter(/databases/$(database)/documents/items/$(id)).data.meta.size() == 0;
    }
  }
}`;

    const sb = initializeSandbox({ projectId: 'merge-empty-nested-map' });
    const adminDb = getAdminFirestore(sb);
    await setDoc(doc(adminDb, 'docs/doc-1'), { meta: { locked: true, tier: 1 }, title: 'a' });
    await setDoc(doc(adminDb, 'items/item-1'), { meta: { locked: true, tier: 1 }, title: 'kept' });
    setRules(sb, rules);

    const db = getFirestore(sb.withAuth({ uid: 'user-1' }));
    expect(await isAllowed(setDoc(doc(db, 'docs/doc-1'), { meta: {} }, { merge: true }))).toBe(
      false,
    );
    expect(await isAllowed(setDoc(doc(db, 'items/item-1'), { meta: {} }, { merge: true }))).toBe(
      true,
    );

    const sim = firestoreRules(rules).simulate([
      {
        description: 'empty nested map in set merge:true clears prior nested fields',
        expectation: 'DENY',
        method: 'update',
        path: 'docs/doc-1',
        auth: { uid: 'user-1' },
        resource: { meta: { locked: true, tier: 1 }, title: 'a' },
        data: { meta: {} },
        writeMode: { kind: 'set', merge: true },
      },
      {
        description: 'empty nested map in set merge:true produces size 0 map while preserving top-level siblings',
        expectation: 'ALLOW',
        method: 'update',
        path: 'items/item-1',
        auth: { uid: 'user-1' },
        resource: { meta: { locked: true, tier: 1 }, title: 'kept' },
        data: { meta: {} },
        writeMode: { kind: 'set', merge: true },
      },
    ]);

    expect(sim.cases.map((c) => c.decision)).toEqual(['DENY', 'ALLOW']);

    await sb.dispose();
  });
});
