import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'setDoc(ref, data, { merge: true }) deep-merges nested maps while preserving unspecified sibling fields at every depth, replacing arrays, and creating absent documents.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('setdoc-merge-true'));

      const existingRef = doc(items, 'existing-doc');
      await setDoc(existingRef, {
        topKeep: 'kept',
        meta: {
          a: 1,
          nested: { x: 10, y: 20 },
        },
        list: ['old-a', 'old-b'],
      });

      await setDoc(
        existingRef,
        {
          meta: {
            b: 2,
            nested: { y: 99, z: 30 },
          },
          list: ['new-only'],
        },
        { merge: true },
      );
      const mergedSnap = await getDoc(existingRef);

      const absentRef = doc(items, 'absent-doc');
      await setDoc(absentRef, { createdViaMerge: true, nested: { k: 'v' } }, { merge: true });
      const createdSnap = await getDoc(absentRef);

      return {
        mergedExists: mergedSnap.exists(),
        mergedData: mergedSnap.data() ?? null,
        createdFromAbsentExists: createdSnap.exists(),
        createdFromAbsentData: createdSnap.data() ?? null,
      };
    });
  },
};
