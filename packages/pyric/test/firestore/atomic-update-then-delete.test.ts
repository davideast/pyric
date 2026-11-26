import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getFirestore, runTransaction, writeBatch } from 'pyric/firestore';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { LocalEnvironment } from '../../src/sandbox/internal/index.js';

function evidenceText(messages: readonly string[] | undefined): string {
  return (messages ?? []).join('\n');
}

describe('atomic same-path set/update/create followed by delete', () => {
  test('evaluates each write under its own rule method with projected request.resource and final getAfter', async () => {
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

  test('#1382: batch set then delete evaluates set under create/update, not delete, when delete is denied', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow create: if true;
      allow update: if true;
      allow delete: if false;
    }
  }
}`;
    const envNew = new LocalEnvironment();
    envNew.seed({ rules, documents: {} });
    const createThenDelete = envNew.batch(
      [
        { method: 'set', path: 'items/new-1', data: { x: 1 } },
        { method: 'delete', path: 'items/new-1' },
      ],
      { uid: 'u1' },
    );
    expect(createThenDelete.allowed).toBe(false);
    expect(createThenDelete.error?.code).toBe('permission-denied');
    expect(createThenDelete.results[0]?.allowed).toBe(true);
    expect(evidenceText(createThenDelete.results[0]?.debugMessages)).toContain('(create)');
    expect(evidenceText(createThenDelete.results[0]?.debugMessages)).not.toContain('(delete)');
    expect(createThenDelete.results[1]?.allowed).toBe(false);
    expect(evidenceText(createThenDelete.results[1]?.debugMessages)).toContain('(delete)');

    const envExisting = new LocalEnvironment();
    envExisting.seed({ rules, documents: { 'items/ex-1': { x: 0 } } });
    const updateThenDelete = envExisting.batch(
      [
        { method: 'set', path: 'items/ex-1', data: { x: 1 } },
        { method: 'delete', path: 'items/ex-1' },
      ],
      { uid: 'u1' },
    );
    expect(updateThenDelete.allowed).toBe(false);
    expect(updateThenDelete.results[0]?.allowed).toBe(true);
    expect(evidenceText(updateThenDelete.results[0]?.debugMessages)).toContain('(update)');
    expect(evidenceText(updateThenDelete.results[0]?.debugMessages)).not.toContain('(delete)');
    expect(updateThenDelete.results[1]?.allowed).toBe(false);
    expect(evidenceText(updateThenDelete.results[1]?.debugMessages)).toContain('(delete)');
  });

  test('#1382: batch and transaction set/create/update followed by delete fail closed when create/update is denied', async () => {
    const denyWriteAllowDelete = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} {
      allow read: if true;
      allow create: if false;
      allow update: if false;
      allow delete: if true;
    }
  }
}`;
    const env = new LocalEnvironment();
    env.seed({ rules: denyWriteAllowDelete, documents: { 'items/existing': { x: 1 } } });

    const setNewThenDel = env.batch(
      [
        { method: 'set', path: 'items/missing', data: { x: 1 } },
        { method: 'delete', path: 'items/missing' },
      ],
      { uid: 'u1' },
    );
    expect(setNewThenDel.allowed).toBe(false);
    expect(setNewThenDel.error?.code).toBe('permission-denied');
    expect(setNewThenDel.results[0]?.allowed).toBe(false);
    expect(evidenceText(setNewThenDel.results[0]?.debugMessages)).toContain('(create)');

    const setExistingThenDel = env.batch(
      [
        { method: 'set', path: 'items/existing', data: { x: 2 } },
        { method: 'delete', path: 'items/existing' },
      ],
      { uid: 'u1' },
    );
    expect(setExistingThenDel.allowed).toBe(false);
    expect(setExistingThenDel.results[0]?.allowed).toBe(false);
    expect(evidenceText(setExistingThenDel.results[0]?.debugMessages)).toContain('(update)');

    const updExistingThenDel = env.batch(
      [
        { method: 'update', path: 'items/existing', data: { x: 2 } },
        { method: 'delete', path: 'items/existing' },
      ],
      { uid: 'u1' },
    );
    expect(updExistingThenDel.allowed).toBe(false);
    expect(updExistingThenDel.results[0]?.allowed).toBe(false);
    expect(evidenceText(updExistingThenDel.results[0]?.debugMessages)).toContain('(update)');

    const createNewThenDel = env.batch(
      [
        { method: 'create', path: 'items/missing-2', data: { x: 1 } },
        { method: 'delete', path: 'items/missing-2' },
      ],
      { uid: 'u1' },
    );
    expect(createNewThenDel.allowed).toBe(false);
    expect(createNewThenDel.results[0]?.allowed).toBe(false);
    expect(evidenceText(createNewThenDel.results[0]?.debugMessages)).toContain('(create)');

    // Transaction set + delete must also deny when allow create is false.
    const sb = initializeSandbox();
    setRules(sb, denyWriteAllowDelete);
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));
    await expect(
      runTransaction(db, async (tx) => {
        const ref = doc(db, 'items', 'tx-new');
        tx.set(ref, { x: 1 });
        tx.delete(ref);
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('#1382: set followed by delete still exposes final deleted state to existsAfter while preserving set payload for request.resource', async () => {
    const sb = initializeSandbox();
    setRules(
      sb,
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if true;
      allow create: if request.resource.data.ok == true
        && !existsAfter(/databases/$(database)/documents/items/$(id));
      allow delete: if true;
    }
  }
}`,
    );
    const db = getFirestore(sb.withAuth({ uid: 'u1', token: {} }));

    const allowedBatch = writeBatch(db);
    allowedBatch.set(doc(db, 'items', 'ephemeral'), { ok: true });
    allowedBatch.delete(doc(db, 'items', 'ephemeral'));
    await allowedBatch.commit();
    expect((await getDoc(doc(db, 'items', 'ephemeral'))).exists()).toBe(false);

    const deniedBatch = writeBatch(db);
    deniedBatch.set(doc(db, 'items', 'bad-ephemeral'), { ok: false });
    deniedBatch.delete(doc(db, 'items', 'bad-ephemeral'));
    await expect(deniedBatch.commit()).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
