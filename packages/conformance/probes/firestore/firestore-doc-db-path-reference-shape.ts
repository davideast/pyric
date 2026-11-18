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
    'doc(db, path) returns a DocumentReference with type, id, normalized path, parent CollectionReference, odd-segment rejection, and live read/write usability.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { doc, getDoc, refEqual, setDoc } = firestoreSdk;

      const simpleRef = doc(db, 'items/item-1');
      const nestedRef = doc(db, 'orgs/o1/members/m2');
      const slashTrimmedRef = doc(db, '/items/item-1/');

      const oddSegmentError = observeFirestoreConstructorCall(
        () => doc(db, 'items'),
        FirebaseError,
      );
      const emptyPathError = observeFirestoreConstructorCall(
        () => doc(db, ''),
        FirebaseError,
      );

      const liveRef = doc(db, `${collectionPath('pc-doc-db')}/d1`);
      await setDoc(liveRef, { label: 'doc-db-roundtrip', n: 1 });
      const liveSnap = await getDoc(liveRef);

      return {
        simple: {
          type: simpleRef.type,
          id: simpleRef.id,
          path: simpleRef.path,
          parentPath: simpleRef.parent.path,
          parentType: simpleRef.parent.type,
        },
        nested: {
          id: nestedRef.id,
          path: nestedRef.path,
          parentPath: nestedRef.parent.path,
        },
        slashTrimmedPath: slashTrimmedRef.path,
        slashTrimmedEqualsSimple: refEqual(simpleRef, slashTrimmedRef),
        oddSegmentError: {
          threw: oddSegmentError.threw,
          isFirebaseError: oddSegmentError.isFirebaseError,
          isTypeError: oddSegmentError.isTypeError,
          code: oddSegmentError.code,
        },
        emptyPathError: {
          threw: emptyPathError.threw,
          isFirebaseError: emptyPathError.isFirebaseError,
          isTypeError: emptyPathError.isTypeError,
          code: emptyPathError.code,
        },
        liveRoundtripData: liveSnap.data() ?? null,
      };
    });
  },
};
