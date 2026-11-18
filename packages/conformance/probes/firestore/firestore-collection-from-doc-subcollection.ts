import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { observeFirestoreConstructorCall } from '../../src/firestore-path-constructor-probe-helpers.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'collection(docRef, name, ...pathSegments) builds subcollection references anchored at docRef.path, links parent DocumentReference, and rejects even relative segment counts.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, refEqual, setDoc } = firestoreSdk;

      const parentDoc = doc(db, 'users/u1');
      const subColl = collection(parentDoc, 'tasks');
      const deepSubColl = collection(parentDoc, 'tasks', 't1', 'comments');

      const evenRelativeError = observeFirestoreConstructorCall(
        () => collection(parentDoc, 'tasks', 't1'),
        FirebaseError,
      );

      const liveParentDoc = doc(collection(db, collectionPath('pc-subcoll')), 'u1');
      const liveSubColl = collection(liveParentDoc, 'tasks');
      await setDoc(doc(liveSubColl, 'task-1'), { done: true });
      const snap = await getDocs(liveSubColl);

      return {
        sub: {
          type: subColl.type,
          id: subColl.id,
          path: subColl.path,
          parentPath: subColl.parent?.path ?? null,
          parentEqualsDocRef:
            subColl.parent !== null && refEqual(subColl.parent, parentDoc),
          equalsDbCollection: refEqual(subColl, collection(db, 'users/u1/tasks')),
        },
        deepSub: {
          id: deepSubColl.id,
          path: deepSubColl.path,
          parentPath: deepSubColl.parent?.path ?? null,
          equalsDbCollection: refEqual(
            deepSubColl,
            collection(db, 'users/u1/tasks/t1/comments'),
          ),
        },
        evenRelativeError: {
          threw: evenRelativeError.threw,
          isFirebaseError: evenRelativeError.isFirebaseError,
          isTypeError: evenRelativeError.isTypeError,
          code: evenRelativeError.code,
        },
        liveSubDocIds: snap.docs.map((entry) => entry.id),
      };
    });
  },
};
