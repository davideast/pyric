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
    'doc(db, path, ...pathSegments) joins variadic single and multi-segment arguments into an equivalent DocumentReference and rejects odd total segment counts.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, basePath }) => {
      const { doc, getDoc, refEqual, setDoc } = firestoreSdk;

      const fourSegRef = doc(db, 'a', 'b', 'c', 'd');
      const mixedSegRef = doc(db, 'a/b', 'c', 'd');
      const singleStringRef = doc(db, 'a/b/c/d');

      const oddVariadicError = observeFirestoreConstructorCall(
        () => doc(db, 'a', 'b', 'c'),
        FirebaseError,
      );

      const liveRef = doc(db, basePath, 'pc-doc-variadic', 'd1');
      await setDoc(liveRef, { joined: true, depth: 2 });
      const liveSnap = await getDoc(doc(db, `${basePath}/pc-doc-variadic/d1`));

      return {
        fourSeg: {
          type: fourSegRef.type,
          id: fourSegRef.id,
          path: fourSegRef.path,
          parentPath: fourSegRef.parent.path,
        },
        mixedSegPath: mixedSegRef.path,
        equalsSingleString: refEqual(fourSegRef, singleStringRef),
        mixedEqualsSingleString: refEqual(mixedSegRef, singleStringRef),
        oddVariadicError: {
          threw: oddVariadicError.threw,
          isFirebaseError: oddVariadicError.isFirebaseError,
          isTypeError: oddVariadicError.isTypeError,
          code: oddVariadicError.code,
        },
        liveRoundtripData: liveSnap.data() ?? null,
      };
    });
  },
};
