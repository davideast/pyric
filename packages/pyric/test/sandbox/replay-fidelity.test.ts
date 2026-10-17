/**
 * Replay fidelity (#1058 PR 3, FS-MET-2): `replay()` re-commits a captured
 * session so the replayed sandbox matches the original, with no
 * `real-divergence` for a session the rules accepted.
 *
 * Evidence is the in-page sandbox itself. Each original session below
 * committed under the same rules replay evaluates, so any divergence is
 * replay's own. Before this fix:
 * - batches replayed op by op, losing the shared projection and pre-state;
 * - merge/mergeFields were dropped;
 * - `addDoc` minted no alias;
 * - a pinned auto-id create was denied on replay, and the alias then masked
 *   the missing document.
 */
import { describe, it, expect } from 'bun:test';
import { getClock, initializeSandbox, replay, type WriteSandboxEvent } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import { addDoc, collection, doc, getFirestore, runTransaction, setDoc, updateDoc, writeBatch } from 'pyric/firestore';

function realDivergences(history: ReturnType<ReturnType<typeof initializeSandbox>['history']>, rules: string, original: Record<string, Record<string, unknown>>) {
  const result = replay(history, rules, {}, original);
  return { result, real: result.divergences.filter((d) => d.kind === 'real-divergence') };
}

describe('replay re-commits a batch or transaction atomically', () => {
  it('cross-document existsAfter in one batch', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orders/{id} { allow create: if existsAfter(/databases/$(database)/documents/receipts/$(id)); }
    match /receipts/{id} { allow create: if existsAfter(/databases/$(database)/documents/orders/$(id)); }
  }
}`;
    const sb = initializeSandbox();
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'alice' }));
    const b = writeBatch(db);
    b.set(doc(db, 'orders/o1'), { total: 10 });
    b.set(doc(db, 'receipts/o1'), { paid: true });
    await b.commit();
    expect(realDivergences(sb.history(), rules, snapshotDocuments(sb)).real).toEqual([]);
  });

  it('a batch evaluates against its pre-batch state', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /locks/{id} { allow create: if true; }
    match /items/{id} { allow create: if !exists(/databases/$(database)/documents/locks/$(id)); }
  }
}`;
    const sb = initializeSandbox();
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'alice' }));
    const b = writeBatch(db);
    b.set(doc(db, 'locks/k1'), { locked: true });
    b.set(doc(db, 'items/k1'), { name: 'item1' });
    await b.commit();
    expect(realDivergences(sb.history(), rules, snapshotDocuments(sb)).real).toEqual([]);
  });

  it('a transaction commit with cross-document getAfter', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /a/{id} { allow create: if getAfter(/databases/$(database)/documents/b/$(id)).data.v == 1; }
    match /b/{id} { allow create: if existsAfter(/databases/$(database)/documents/a/$(id)); }
  }
}`;
    const sb = initializeSandbox();
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'alice' }));
    await runTransaction(db, async (tx) => {
      tx.set(doc(db, 'a/x'), { v: 0 });
      tx.set(doc(db, 'b/x'), { v: 1 });
    });
    expect(realDivergences(sb.history(), rules, snapshotDocuments(sb)).real).toEqual([]);
  });

  it('a batched set over an existing document replaces it', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents { match /p/{id} { allow read, write: if true; } }
}`;
    const sb = initializeSandbox();
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'alice' }));
    await setDoc(doc(db, 'p/u1'), { a: 1, b: 1 });
    const b = writeBatch(db);
    b.set(doc(db, 'p/u1'), { c: 1 });
    b.set(doc(db, 'p/u2'), { x: { y: 1 } }, { merge: true });
    await b.commit();
    expect(realDivergences(sb.history(), rules, snapshotDocuments(sb)).real).toEqual([]);
  });
});

describe('replay keeps set merge options', () => {
  const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profiles/{id} {
      allow create: if request.resource.data.keys().hasOnly(['allowed'])
        || request.resource.data.nested.change == 1;
      allow update: if request.resource.data.nested.keep == 1 && request.resource.data.nested.change == 2;
    }
  }
}`;

  it('merge: true and mergeFields', async () => {
    const sb = initializeSandbox();
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'alice' }));
    await setDoc(doc(db, 'profiles/u1'), { nested: { keep: 1, change: 1 } });
    await setDoc(doc(db, 'profiles/u1'), { nested: { change: 2 } }, { merge: true });
    await setDoc(doc(db, 'profiles/u2'), { allowed: true, ignoredSecret: 'drop-me' }, { mergeFields: ['allowed'] });
    const writes = sb.history().filter((e): e is WriteSandboxEvent => e.kind === 'write');
    expect(writes.map((w) => w.merge)).toEqual([undefined, true, { mergeFields: ['allowed'] }]);
    expect(realDivergences(sb.history(), rules, snapshotDocuments(sb)).real).toEqual([]);
  });

  it('a captured event without the merge field still replays as before', async () => {
    const sb = initializeSandbox();
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'alice' }));
    await setDoc(doc(db, 'profiles/u1'), { nested: { keep: 1, change: 1 } });
    // A merge whose payload replaces the whole map lands the same document
    // with or without the merge, so the legacy replay path converges.
    await setDoc(doc(db, 'profiles/u1'), { nested: { keep: 1, change: 2 } }, { merge: true });
    // An event recorded before `merge` existed: strip it.
    const legacy = sb.history().map((e) => {
      if (e.kind !== 'write') return e;
      const { merge: _merge, ...rest } = e;
      return rest as WriteSandboxEvent;
    });
    const { real } = realDivergences(legacy, rules, snapshotDocuments(sb));
    expect(real).toEqual([]);
  });
});

describe('replay aliases auto-id creates and never masks a failed one', () => {
  it('addDoc tags its write with autoId, so replay aliases it', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents { match /logs/{id} { allow create: if true; } }
}`;
    const sb = initializeSandbox();
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'alice' }));
    await addDoc(collection(db, 'logs'), { msg: 'hello' });
    const { result, real } = realDivergences(sb.history(), rules, snapshotDocuments(sb));
    expect(result.pathAliases.size).toBe(1);
    expect(real).toEqual([]);
  });

  it('later writes to an added document, and under it, follow the alias', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents { match /{path=**} { allow read, write: if true; } }
}`;
    const sb = initializeSandbox();
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'alice' }));
    const ref = await addDoc(collection(db, 'logs'), { msg: 'hello' });
    await updateDoc(ref, { msg: 'edited' });
    await setDoc(doc(db, `${ref.path}/notes/n1`), { body: 'x' });
    const { result, real } = realDivergences(sb.history(), rules, snapshotDocuments(sb));
    expect(result.pathAliases.size).toBe(1);
    expect(real).toEqual([]);
    const replayed = snapshotDocuments(result.sandbox);
    const [minted] = [...result.pathAliases.values()];
    expect(replayed[minted!]).toEqual({ msg: 'edited' });
    expect(replayed[`${minted}/notes/n1`]).toEqual({ body: 'x' });
  });

  it('addDoc still denies a create the rules refuse', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents { match /logs/{id} { allow create: if false; } }
}`;
    const sb = initializeSandbox();
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'alice' }));
    await expect(addDoc(collection(db, 'logs'), { msg: 'hello' })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(snapshotDocuments(sb)).toEqual({});
  });

  it('a pinned auto-id create replays at its captured request time', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /logs/{id} { allow create: if request.time == timestamp.date(2020, 1, 1); }
  }
}`;
    const sb = initializeSandbox();
    getClock(sb).set(Date.parse('2020-01-01T00:00:00.000Z'));
    setRules(sb, rules);
    getInternalEnv(sb).createWithAutoId('logs', { msg: 'hello' }, { uid: 'alice' });
    const original = snapshotDocuments(sb);
    const { result, real } = realDivergences(sb.history(), rules, original);
    expect(Object.keys(snapshotDocuments(result.sandbox))).toHaveLength(1);
    expect(real).toEqual([]);
  });

  it('an alias whose replayed write was denied is a real divergence', () => {
    const allow = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents { match /logs/{id} { allow create: if true; } }
}`;
    const deny = allow.replace('if true', 'if false');
    const sb = initializeSandbox();
    setRules(sb, allow);
    getInternalEnv(sb).createWithAutoId('logs', { msg: 'hello' }, { uid: 'alice' });
    const original = snapshotDocuments(sb);
    const { real } = realDivergences(sb.history(), deny, original);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ kind: 'real-divergence', after: undefined });
  });
});
