import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'runTransaction performs consistent snapshot reads and commits multi-document set, update, and delete mutations atomically while writeBatch queues mutations without applying them prior to commit().',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, runTransaction, setDoc, writeBatch } = firestoreSdk;

      const txnItems = collection(db, collectionPath('txn-atomic-read-write'));
      const refA = doc(txnItems, 'acct-a');
      const refB = doc(txnItems, 'acct-b');
      const refNew = doc(txnItems, 'acct-new');
      const refStale = doc(txnItems, 'acct-stale');

      await setDoc(refA, { balance: 100 });
      await setDoc(refB, { balance: 40 });
      await setDoc(refStale, { flag: 'drop' });

      let readConsistentBalances: number[] = [];
      let missingExistsInTxn = true;

      const returnValue = await runTransaction(db, async (txn) => {
        const snapA = await txn.get(refA);
        const snapB = await txn.get(refB);
        const snapMissing = await txn.get(refNew);
        readConsistentBalances = [
          Number(snapA.data()?.balance),
          Number(snapB.data()?.balance),
        ];
        missingExistsInTxn = snapMissing.exists();

        txn.update(refA, { balance: 75 });
        txn.update(refB, { balance: 65 });
        txn.set(refNew, { transferred: 25 });
        txn.delete(refStale);
        return 'committed-25';
      });

      const postA = await getDoc(refA);
      const postB = await getDoc(refB);
      const postNew = await getDoc(refNew);
      const postStale = await getDoc(refStale);

      let newDocData: unknown = null;
      const rawNew = postNew.data();
      if (rawNew !== undefined) {
        newDocData = rawNew;
      }

      const batchItems = collection(db, collectionPath('batch-queued-mutations'));
      const batchSetRef = doc(batchItems, 'b-set');
      const batchUpdateRef = doc(batchItems, 'b-update');
      const batchDeleteRef = doc(batchItems, 'b-delete');

      await setDoc(batchUpdateRef, { count: 1 });
      await setDoc(batchDeleteRef, { keep: false });

      const batch = writeBatch(db);
      batch.set(batchSetRef, { count: 10 });
      batch.update(batchUpdateRef, { count: 9 });
      batch.delete(batchDeleteRef);

      const preCommitSetSnap = await getDoc(batchSetRef);
      const preCommitUpdateSnap = await getDoc(batchUpdateRef);
      const preCommitDeleteSnap = await getDoc(batchDeleteRef);

      await batch.commit();

      const postCommitSetSnap = await getDoc(batchSetRef);
      const postCommitUpdateSnap = await getDoc(batchUpdateRef);
      const postCommitDeleteSnap = await getDoc(batchDeleteRef);

      let preCommitUpdateCount: unknown = null;
      const preUpdateData = preCommitUpdateSnap.data();
      if (preUpdateData !== undefined && preUpdateData.count !== undefined) {
        preCommitUpdateCount = preUpdateData.count;
      }

      let postCommitSetCount: unknown = null;
      const postSetData = postCommitSetSnap.data();
      if (postSetData !== undefined && postSetData.count !== undefined) {
        postCommitSetCount = postSetData.count;
      }

      let postCommitUpdateCount: unknown = null;
      const postUpdateData = postCommitUpdateSnap.data();
      if (postUpdateData !== undefined && postUpdateData.count !== undefined) {
        postCommitUpdateCount = postUpdateData.count;
      }

      return {
        transaction: {
          returnValue,
          readConsistentBalances,
          missingExistsInTxn,
          postCommitBalances: [
            Number(postA.data()?.balance),
            Number(postB.data()?.balance),
          ],
          newDocData,
          deletedDocExists: postStale.exists(),
        },
        writeBatchQueueing: {
          preCommitSetExists: preCommitSetSnap.exists(),
          preCommitUpdateCount,
          preCommitDeleteExists: preCommitDeleteSnap.exists(),
          postCommitSetCount,
          postCommitUpdateCount,
          postCommitDeleteExists: postCommitDeleteSnap.exists(),
        },
      };
    });
  },
};
