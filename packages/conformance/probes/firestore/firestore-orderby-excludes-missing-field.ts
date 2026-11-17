import type { Probe } from '../../rigs/types.ts';
import { observeFirestoreIdQuery } from '../../src/firestore-probe-outcomes.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'orderBy(field) excludes documents lacking the ordered field while retaining null-valued documents.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, orderBy, query, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('orderby-excludes-missing'));
      await setDoc(doc(items, 'missing_field'), { tag: 'absent' });
      await setDoc(doc(items, 'present_null'), { score: null, tag: 'null' });
      await setDoc(doc(items, 'present_low'), { score: 1, tag: 'low' });
      await setDoc(doc(items, 'present_high'), { score: 2, tag: 'high' });

      return {
        unfiltered: await observeFirestoreIdQuery(() => getDocs(items)),
        orderByAsc: await observeFirestoreIdQuery(() =>
          getDocs(query(items, orderBy('score', 'asc'))),
        ),
        orderByDesc: await observeFirestoreIdQuery(() =>
          getDocs(query(items, orderBy('score', 'desc'))),
        ),
      };
    });
  },
};
