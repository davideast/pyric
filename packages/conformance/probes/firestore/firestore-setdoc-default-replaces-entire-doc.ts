import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'setDoc(ref, data) without options (and with { merge: false }) replaces the existing document completely, removing unmentioned top-level and nested fields.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('setdoc-replace'));

      const refA = doc(items, 'doc-no-opts');
      await setDoc(refA, {
        title: 'Initial',
        status: 'draft',
        nested: { a: 1, b: 2 },
        tags: ['v1', 'v2'],
      });
      await setDoc(refA, {
        title: 'Replaced',
        count: 10,
      });
      const snapA = await getDoc(refA);
      const dataA = snapA.data() ?? null;

      const refB = doc(items, 'doc-merge-false');
      await setDoc(refB, {
        keepAttempt: 'before',
        nested: { x: 1, y: 2 },
      });
      await setDoc(refB, { nested: { x: 9 } }, { merge: false });
      const snapB = await getDoc(refB);
      const dataB = snapB.data() ?? null;

      return {
        noOptionsExists: snapA.exists(),
        noOptionsData: dataA,
        noOptionsHasPriorStatus: dataA !== null && 'status' in dataA,
        noOptionsHasPriorNested: dataA !== null && 'nested' in dataA,
        noOptionsHasPriorTags: dataA !== null && 'tags' in dataA,
        mergeFalseData: dataB,
        mergeFalseHasPriorKeepAttempt: dataB !== null && 'keepAttempt' in dataB,
      };
    });
  },
};
