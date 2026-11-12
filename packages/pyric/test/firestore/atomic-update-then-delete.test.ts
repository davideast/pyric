import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getFirestore, runTransaction, writeBatch } from 'pyric/firestore';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';

describe('atomic same-path update/create followed by delete', () => {
  test('evaluates allow delete instead of allow update with empty request.resource in writeBatch and runTransaction', async () => {
    const sb = initializeSandbox();
    setRules(
      sb,
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /items/{id} {',
        '      allow read: if true;',
        '      allow create: if request.resource.data.ownerId == request.auth.uid;',
        '      allow update: if request.resource.data.ownerId == resource.data.ownerId;',
        '      allow delete: if request.auth != null && request.auth.uid == resource.data.ownerId;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    seedDocuments(sb, {
      'items/batch-upd-del': { ownerId: 'u1', count: 1 },
      'items/batch-set-upd-del': { ownerId: 'u1', count: 1 },
      'items/tx-upd-del': { ownerId: 'u1', count: 1 },
      'items/denied-del': { ownerId: 'u2', count: 1 },
    });

    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    const b1 = writeBatch(db);
    b1.update(doc(db, 'items', 'batch-upd-del'), { count: 2 });
    b1.delete(doc(db, 'items', 'batch-upd-del'));
    await b1.commit();
    expect((await getDoc(doc(db, 'items', 'batch-upd-del'))).exists()).toBe(false);

    const b2 = writeBatch(db);
    b2.set(doc(db, 'items', 'batch-set-upd-del'), { ownerId: 'u1', count: 2 });
    b2.update(doc(db, 'items', 'batch-set-upd-del'), { count: 3 });
    b2.delete(doc(db, 'items', 'batch-set-upd-del'));
    await b2.commit();
    expect((await getDoc(doc(db, 'items', 'batch-set-upd-del'))).exists()).toBe(false);

    await runTransaction(db, async (tx) => {
      const ref = doc(db, 'items', 'tx-upd-del');
      await tx.get(ref);
      tx.update(ref, { count: 2 });
      tx.delete(ref);
    });
    expect((await getDoc(doc(db, 'items', 'tx-upd-del'))).exists()).toBe(false);

    // Negative control: unauthorized delete must still fail closed with permission-denied.
    const bDenied = writeBatch(db);
    bDenied.update(doc(db, 'items', 'denied-del'), { count: 2 });
    bDenied.delete(doc(db, 'items', 'denied-del'));
    await expect(bDenied.commit()).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await getDoc(doc(db, 'items', 'denied-del'))).exists()).toBe(true);
  });
});
