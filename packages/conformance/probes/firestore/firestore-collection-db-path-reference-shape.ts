import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { observeFirestoreConstructorCall } from '../../src/firestore-path-constructor-probe-helpers.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#9',
  rowIds: ['firestore#9'],
  description:
    'collection(db, path, ...pathSegments) returns a CollectionReference with type, id, path, parent (null at root, DocumentReference when nested), and even-segment rejection.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, refEqual, setDoc } = firestoreSdk;

      const rootColl = collection(db, 'items');
      const nestedColl = collection(db, 'orgs/o1/projects');
      const variadicColl = collection(db, 'orgs', 'o1', 'projects');

      const evenSegmentError = observeFirestoreConstructorCall(
        () => collection(db, 'orgs/o1'),
        FirebaseError,
      );

      const liveColl = collection(db, collectionPath('pc-coll-db'));
      await setDoc(doc(liveColl, 'c1'), { kind: 'coll-db' });
      const querySnap = await getDocs(liveColl);

      return {
        root: {
          type: rootColl.type,
          id: rootColl.id,
          path: rootColl.path,
          parentIsNull: rootColl.parent === null,
        },
        nested: {
          type: nestedColl.type,
          id: nestedColl.id,
          path: nestedColl.path,
          parentPath: nestedColl.parent?.path ?? null,
          parentType: nestedColl.parent?.type ?? null,
        },
        variadicEqualsNested: refEqual(variadicColl, nestedColl),
        evenSegmentError: {
          threw: evenSegmentError.threw,
          isFirebaseError: evenSegmentError.isFirebaseError,
          isTypeError: evenSegmentError.isTypeError,
          code: evenSegmentError.code,
        },
        liveDocIds: querySnap.docs.map((entry) => entry.id),
      };
    });
  },
};
