import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#151',
  rowIds: ['firestore#151'],
  description:
    'firebase/firestore exports runtime ES classes, query constraint constructors, and CACHE_SIZE_UNLIMITED satisfying instanceof checks across live database, reference, snapshot, batch, transaction, and aggregate handles.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const {
        AggregateField,
        AggregateQuerySnapshot,
        CACHE_SIZE_UNLIMITED,
        CollectionReference,
        DocumentReference,
        DocumentSnapshot,
        Firestore,
        FirestoreError,
        Query,
        QueryCompositeFilterConstraint,
        QueryConstraint,
        QueryDocumentSnapshot,
        QueryEndAtConstraint,
        QueryFieldFilterConstraint,
        QueryLimitConstraint,
        QueryOrderByConstraint,
        QuerySnapshot,
        QueryStartAtConstraint,
        SnapshotMetadata,
        Transaction,
        WriteBatch,
        collection,
        count,
        doc,
        endAt,
        getCountFromServer,
        getDoc,
        getDocs,
        limit,
        or,
        orderBy,
        query,
        runTransaction,
        setDoc,
        startAt,
        where,
        writeBatch,
      } = firestoreSdk;

      const items = collection(db, collectionPath('runtime-classes-instanceof'));
      const itemRef = doc(items, 'doc-1');
      await setDoc(itemRef, { rank: 1 });

      const docSnap = await getDoc(itemRef);
      const builtQuery = query(items, where('rank', '==', 1));
      const querySnap = await getDocs(builtQuery);
      const firstQueryDoc = querySnap.docs[0];
      if (firstQueryDoc === undefined) {
        throw new Error('Expected query document');
      }

      const countField = count();
      const aggSnap = await getCountFromServer(items);
      const batch = writeBatch(db);

      let txnIsTransaction = false;
      await runTransaction(db, async (txn) => {
        txnIsTransaction = txn instanceof Transaction;
        await txn.get(itemRef);
      });

      let caughtInvalidPathError: unknown = null;
      try {
        doc(db, 'invalid/even');
      } catch (err) {
        caughtInvalidPathError = err;
      }

      const fieldFilter = where('rank', '==', 1);
      const compositeFilter = or(where('rank', '==', 1), where('rank', '==', 2));
      const orderConstraint = orderBy('rank');
      const limitConstraint = limit(5);
      const startConstraint = startAt(1);
      const endConstraint = endAt(1);

      return {
        constantsAndExports: {
          cacheSizeUnlimited: CACHE_SIZE_UNLIMITED,
          hasAbstractUserDataWriter: 'AbstractUserDataWriter' in firestoreSdk,
        },
        handleInstanceOf: {
          dbIsFirestore: db instanceof Firestore,
          collIsCollectionReference: items instanceof CollectionReference,
          collIsQuery: items instanceof Query,
          builtQueryIsQuery: builtQuery instanceof Query,
          docRefIsDocumentReference: itemRef instanceof DocumentReference,
          docSnapIsDocumentSnapshot: docSnap instanceof DocumentSnapshot,
          docSnapMetadataIsSnapshotMetadata: docSnap.metadata instanceof SnapshotMetadata,
          querySnapIsQuerySnapshot: querySnap instanceof QuerySnapshot,
          queryDocIsQueryDocumentSnapshot: firstQueryDoc instanceof QueryDocumentSnapshot,
          queryDocIsDocumentSnapshot: firstQueryDoc instanceof DocumentSnapshot,
          batchIsWriteBatch: batch instanceof WriteBatch,
          txnIsTransaction,
          countIsAggregateField: countField instanceof AggregateField,
          aggSnapIsAggregateQuerySnapshot: aggSnap instanceof AggregateQuerySnapshot,
          invalidPathIsFirestoreError: caughtInvalidPathError instanceof FirestoreError,
          invalidPathIsError: caughtInvalidPathError instanceof Error,
        },
        constraintInstanceOf: {
          fieldFilterIsFieldFilter: fieldFilter instanceof QueryFieldFilterConstraint,
          fieldFilterIsQueryConstraint: fieldFilter instanceof QueryConstraint,
          compositeIsCompositeFilter: compositeFilter instanceof QueryCompositeFilterConstraint,
          compositeIsQueryConstraint: compositeFilter instanceof QueryConstraint,
          orderIsOrderByConstraint: orderConstraint instanceof QueryOrderByConstraint,
          orderIsQueryConstraint: orderConstraint instanceof QueryConstraint,
          limitIsLimitConstraint: limitConstraint instanceof QueryLimitConstraint,
          limitIsQueryConstraint: limitConstraint instanceof QueryConstraint,
          startIsStartAtConstraint: startConstraint instanceof QueryStartAtConstraint,
          startIsQueryConstraint: startConstraint instanceof QueryConstraint,
          endIsEndAtConstraint: endConstraint instanceof QueryEndAtConstraint,
          endIsQueryConstraint: endConstraint instanceof QueryConstraint,
        },
      };
    });
  },
};
