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
    'Implicit orderBy on an inequality-filtered field without explicit orderBy and deterministic document-key tiebreak on equal field values.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, orderBy, query, setDoc, where } = firestoreSdk;
      const items = collection(db, collectionPath('orderby-implicit-tiebreak'));
      await setDoc(doc(items, 'k3'), { group: 20 });
      await setDoc(doc(items, 'k1'), { group: 20 });
      await setDoc(doc(items, 'k2'), { group: 10 });
      await setDoc(doc(items, 'k0'), { group: 30 });

      return {
        equalValueAscTiebreak: await observeFirestoreIdQuery(() =>
          getDocs(query(items, orderBy('group', 'asc'))),
        ),
        equalValueDescTiebreak: await observeFirestoreIdQuery(() =>
          getDocs(query(items, orderBy('group', 'desc'))),
        ),
        inequalityWithoutExplicitOrderBy: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('group', '>', 10))),
        ),
      };
    });
  },
};
