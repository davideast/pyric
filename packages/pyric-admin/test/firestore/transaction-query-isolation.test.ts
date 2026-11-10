import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore as getRuleEnforcedFirestore } from 'pyric/sandbox/admin-firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getFirestore } from '../../src/firestore/index.js';
import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';

describe('pyric-admin/firestore runTransaction query snapshot isolation and conflict detection', () => {
  for (const [label, makeArm] of [
    ['in-process', inProcessFirestoreArm],
    ['shared-worker', sharedWorkerFirestoreArm],
  ] as const) {
    describe(label, () => {
      test('tx.get(query) reads from the transaction pinned snapshot and retries on mid-attempt writes', async () => {
        const { app } = makeArm();
        const db = getFirestore(app);

        await db.doc('items/anchor').set({ version: 1 });
        await db.doc('items/target').set({ version: 1 });
        await db.doc('groups/g1/entries/e1').set({ tag: 'v1' });

        const observed: Array<{
          attempt: number;
          docVersion: unknown;
          matchingIds: string[];
          groupMatchingIds: string[];
        }> = [];
        let attempt = 0;

        const outcome = await db.runTransaction(async (tx) => {
          attempt += 1;
          await tx.get(db.doc('items/anchor'));

          if (attempt === 1) {
            // Interleave external writes after the transaction snapshot was pinned.
            await db.doc('items/target').set({ version: 2 });
            await db.doc('groups/g1/entries/e2').set({ tag: 'v2' });
          }

          const docSnap = await tx.get(db.doc('items/target'));
          const querySnap = await tx.get(db.collection('items').where('version', '==', 2));
          const groupSnap = await tx.get(db.collectionGroup('entries').where('tag', '==', 'v2'));

          observed.push({
            attempt,
            docVersion: docSnap.data()?.version,
            matchingIds: querySnap.docs.map((d) => d.id),
            groupMatchingIds: groupSnap.docs.map((d) => d.id),
          });

          return 'committed';
        });

        expect(outcome).toBe('committed');
        expect(attempt).toBe(2);
        expect(observed[0]).toEqual({
          attempt: 1,
          docVersion: 1,
          matchingIds: [],
          groupMatchingIds: [],
        });
        expect(observed[1]).toEqual({
          attempt: 2,
          docVersion: 2,
          matchingIds: ['target'],
          groupMatchingIds: ['e2'],
        });
      });
      test('concurrent transactions reading an empty collection detect phantom inserts and retry', async () => {
        const { app } = makeArm();
        const db = getFirestore(app);

        let arrived = 0;
        let releaseBarrier!: () => void;
        const barrier = new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        });

        const claimSoleOwner = (uid: string) => {
          let enteredBarrier = false;
          return db.runTransaction(async (tx) => {
            const owners = await tx.get(db.collection('orgs/org-1/owners'));
            if (!enteredBarrier) {
              enteredBarrier = true;
              arrived += 1;
              if (arrived === 2) releaseBarrier();
              await barrier;
            }
            if (!owners.empty) {
              return false;
            }
            tx.set(db.doc(`orgs/org-1/owners/${uid}`), { uid });
            return true;
          });
        };

        const results = await Promise.all([claimSoleOwner('u1'), claimSoleOwner('u2')]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.filter((v) => v === false)).toHaveLength(1);

        const finalOwners = await db.collection('orgs/org-1/owners').get();
        expect(finalOwners.docs.map((d) => d.id)).toHaveLength(1);
      });

      test('concurrent filtered query reads detect newly matching documents and retry', async () => {
        const { app } = makeArm();
        const db = getFirestore(app);

        await db.doc('slots/s1').set({ status: 'idle' });

        let attempts = 0;
        const claimed = await db.runTransaction(async (tx) => {
          attempts += 1;
          const active = await tx.get(db.collection('slots').where('status', '==', 'active'));
          if (attempts === 1) {
            // An external update causes s1 (which was not in `active` when read) to enter the query set.
            await db.doc('slots/s1').update({ status: 'active' });
          }
          if (!active.empty) {
            return false;
          }
          tx.set(db.doc('slots/s2'), { status: 'active' });
          return true;
        });

        expect(claimed).toBe(false);
        expect(attempts).toBe(2);
        const activeAfter = await db.collection('slots').where('status', '==', 'active').get();
        expect(activeAfter.docs.map((d) => d.id)).toEqual(['s1']);
      });

      test('exhausting maxAttempts on repeated query conflicts rejects without committing stale writes', async () => {
        const { app } = makeArm();
        const db = getFirestore(app);

        let attempts = 0;
        await expect(
          db.runTransaction(
            async (tx) => {
              attempts += 1;
              await tx.get(db.collection('locks'));
              await db.doc(`locks/external-${attempts}`).set({ attempt: attempts });
              tx.set(db.doc('locks/stale-winner'), { attempts });
              return 'unexpected';
            },
            { maxAttempts: 2 },
          ),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/^(aborted|failed-precondition)$/),
        });

        expect(attempts).toBe(2);
        const staleSnap = await db.doc('locks/stale-winner').get();
        expect(staleSnap.exists).toBe(false);
      });

      test('tx.get(query) after a queued write rejects with failed-precondition', async () => {
        const { app } = makeArm();
        const db = getFirestore(app);

        await expect(
          db.runTransaction(async (tx) => {
            tx.set(db.doc('orders/o1'), { total: 10 });
            await tx.get(db.collection('orders'));
          }),
        ).rejects.toMatchObject({ code: 'failed-precondition' });

        const snap = await db.doc('orders/o1').get();
        expect(snap.exists).toBe(false);
      });
    });
  }

  test('rules-enforced transaction retries on query-set conflict without logging spurious aborted transaction events', async () => {
    const sandbox = initializeSandbox({ projectId: 'proj-1' });
    const authedDb = getRuleEnforcedFirestore(sandbox.withAuth({ uid: 'u1', token: {} }));
    authedDb.setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /slots/{slotId} {
      allow read, write: if request.auth != null;
    }
  }
}`);

    await authedDb.doc('slots/s1').set({ status: 'idle' });

    let attempts = 0;
    const committed = await authedDb.runTransaction(async (tx) => {
      attempts += 1;
      const active = await tx.get(authedDb.collection('slots').where('status', '==', 'active'));
      if (attempts === 1) {
        await authedDb.doc('slots/s1').update({ status: 'active' });
      }
      if (!active.empty) {
        return 'already-active';
      }
      tx.set(authedDb.doc('slots/s2'), { status: 'active' });
      return 'created';
    });

    expect(committed).toBe('already-active');
    expect(attempts).toBe(2);

    const txEvents = getInternalEnv(sandbox)
      .getEvents()
      .filter((e) => e.method === 'transaction');
    const abortedTxEvents = txEvents.filter((e) => e.aborted === true);
    expect(abortedTxEvents).toEqual([]);
    expect(txEvents).toHaveLength(1);
    expect(txEvents[0]?.allowed).toBe(true);
  });
});
