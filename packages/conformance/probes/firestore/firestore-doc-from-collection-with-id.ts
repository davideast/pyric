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
    'doc(coll, id, ...pathSegments) appends relative segments under a CollectionReference, matches doc(db, fullPath) via refEqual, and rejects even relative segment counts.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, refEqual, setDoc } = firestoreSdk;

      const items = collection(db, 'items');
      const childDoc = doc(items, 'item-42');
      const deepChildDoc = doc(items, 'item-42', 'notes', 'note-1');

      const evenRelativeError = observeFirestoreConstructorCall(
        () => doc(items, 'item-42', 'notes'),
        FirebaseError,
      );

      const liveColl = collection(db, collectionPath('pc-doc-from-coll'));
      const liveChild = doc(liveColl, 'row-10');
      await setDoc(liveChild, { source: 'doc-from-collection' });
      const liveSnap = await getDoc(doc(db, `${liveColl.path}/row-10`));

      return {
        child: {
          type: childDoc.type,
          id: childDoc.id,
          path: childDoc.path,
          parentPath: childDoc.parent.path,
          equalsDbDoc: refEqual(childDoc, doc(db, 'items/item-42')),
        },
        deepChild: {
          id: deepChildDoc.id,
          path: deepChildDoc.path,
          parentPath: deepChildDoc.parent.path,
          equalsDbDoc: refEqual(deepChildDoc, doc(db, 'items/item-42/notes/note-1')),
        },
        evenRelativeError: {
          threw: evenRelativeError.threw,
          isFirebaseError: evenRelativeError.isFirebaseError,
          isTypeError: evenRelativeError.isTypeError,
          code: evenRelativeError.code,
        },
        liveRoundtripData: liveSnap.data() ?? null,
      };
    });
  },
};
