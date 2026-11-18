import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'increment, arrayUnion, and arrayRemove overwrite absent or type-mismatched prior field values using base 0 or [] across updateDoc and setDoc({ merge: true }) without failing validation.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { arrayRemove, arrayUnion, collection, doc, getDoc, increment, setDoc, updateDoc } =
        firestoreSdk;

      const items = collection(db, collectionPath('sentinel-mismatch'));
      const updateRef = doc(items, 'update-target');
      await setDoc(updateRef, {
        strScore: 'not-a-number',
        mapScore: { nested: 1 },
        nullScore: null,
        strTags: 'scalar-tag',
        numTags: 42,
        strDrop: 'scalar-drop',
        arrDrop: ['keep', 'remove'],
      });

      await updateDoc(updateRef, {
        absentScore: increment(5),
        strScore: increment(5),
        mapScore: increment(-3),
        nullScore: increment(2),
        absentTags: arrayUnion('x', 'y', 'x'),
        strTags: arrayUnion('alpha', 'beta'),
        numTags: arrayUnion(7),
        absentDrop: arrayRemove('z'),
        strDrop: arrayRemove('scalar-drop'),
        arrDrop: arrayRemove('remove'),
      });

      const afterUpdateSnap = await getDoc(updateRef);
      const afterUpdate = afterUpdateSnap.data() ?? null;

      const mergeRef = doc(items, 'merge-target');
      await setDoc(mergeRef, {
        priorStr: 'hello',
        priorNum: 99,
        untouched: 'kept',
      });
      await setDoc(
        mergeRef,
        {
          priorStr: increment(4),
          priorNum: arrayUnion('item'),
          freshCount: increment(1),
        },
        { merge: true },
      );

      const afterMergeSnap = await getDoc(mergeRef);
      const afterMergeSet = afterMergeSnap.data() ?? null;

      return {
        afterUpdate,
        afterMergeSet,
      };
    });
  },
};
