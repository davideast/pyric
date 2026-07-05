/**
 * Pinning probe for matrix row Firestore #39: `deleteDoc` on a
 * missing doc must resolve cleanly with no throw and no side effects,
 * matching production `firebase/firestore` semantics.
 *
 * Empirical oracle: `scripts/oracle/observations/firestore-deletedoc-missing.json`
 * (`threw: false` against the `blockingfun` project, fb-js-sdk 12.13.0).
 *
 * Before the fix in `applyWrite` (`packages/sandbox/src/firestore/local-environment.ts`)
 * + `applyBatch` (`packages/sandbox/src/firestore/local-state.ts`), the
 * sandbox demoted delete-missing into a `not-found` error and threw
 * `Document '<path>' does not exist` — the divergence this probe locks.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getFirestore } from '../../../src/firestore/index.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`;

function makeSandbox(): Sandbox {
  const sandbox = initializeSandbox();
  const setupDb = getFirestore(sandbox.withAuth(null));
  setupDb.setRules(OPEN_RULES);
  setupDb.seed({ documents: {} });
  return sandbox;
}

describe('deleteDoc on missing doc resolves cleanly (matrix #39)', () => {
  it('resolves without throwing when the doc never existed', async () => {
    const sandbox = makeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    // No doc at the path. Production firebase/firestore no-ops here;
    // sandbox used to throw. The contract is: the promise resolves,
    // no value (delete is void), nothing thrown.
    await expect(db.doc('tickets/never-existed').delete()).resolves.toBeUndefined();
  });

  it('is idempotent — deleting twice in a row is still a no-op', async () => {
    const sandbox = makeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    // Seed a doc, delete it, then delete it again. The second delete
    // should resolve cleanly (matches prod idempotency).
    await db.doc('tickets/T-1').set({ ownerId: 'alice', title: 'doomed' });
    await db.doc('tickets/T-1').delete();

    // First post-delete read confirms the doc is really gone.
    const gone = await db.doc('tickets/T-1').get();
    expect(gone.exists).toBe(false);

    // Second delete against the now-missing path — must not throw.
    await expect(db.doc('tickets/T-1').delete()).resolves.toBeUndefined();
  });

  it('leaves unrelated docs untouched (no side effects on miss)', async () => {
    const sandbox = makeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    // Seed a sibling we will read after the delete-missing.
    await db.doc('tickets/T-keep').set({ ownerId: 'alice', title: 'keep me' });

    // Delete a non-existent path.
    await db.doc('tickets/T-ghost').delete();

    // Sibling is still present and unchanged.
    const sib = await db.doc('tickets/T-keep').get();
    expect(sib.exists).toBe(true);
    expect(sib.data()).toEqual({ ownerId: 'alice', title: 'keep me' });
  });

  it('rule denial still wins over the no-op — denied delete throws', async () => {
    // Guards the orthogonality: making delete-missing a no-op must
    // not weaken rule enforcement. With closed write rules, a delete
    // attempt against any path (missing or present) should still
    // throw `permission-denied`.
    const sandbox = initializeSandbox();
    const setupDb = getFirestore(sandbox.withAuth(null));
    setupDb.setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} {
      allow read, write: if false;
    }
  }
}`);
    setupDb.seed({ documents: {} });

    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    let err: unknown;
    try {
      await db.doc('tickets/forbidden').delete();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe('permission-denied');
  });

  it('WriteBatch.delete on missing doc commits without throwing', async () => {
    // Production batch delete on a missing doc is also a no-op; the
    // batch commits, the sibling write lands. Guards the parallel
    // fix in `local-state.ts:applyBatch`.
    const sandbox = makeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    const batch = db.batch();
    batch.delete(db.doc('tickets/T-ghost'));
    batch.set(db.doc('tickets/T-new'), { ownerId: 'alice', title: 'born' });
    await expect(batch.commit()).resolves.toBeUndefined();

    const created = await db.doc('tickets/T-new').get();
    expect(created.exists).toBe(true);
    expect(created.data()).toEqual({ ownerId: 'alice', title: 'born' });
  });
});
