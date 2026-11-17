import type { Probe } from '../../rigs/types.ts';
import { observeFirestoreNotInQuery } from '../../src/firestore-not-in-probe.ts';
import { observeFirestoreIdQuery } from '../../src/firestore-probe-outcomes.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'where() field-existence and null-value behavior across ==, <, <=, >, >=, in, !=, and not-in (including null operands).',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, query, setDoc, where } = firestoreSdk;
      const itemsPath = collectionPath('where-existence-null');
      const items = collection(db, itemsPath);
      await setDoc(doc(items, 'missing'), { label: 'absent' });
      await setDoc(doc(items, 'null_val'), { val: null });
      await setDoc(doc(items, 'ten'), { val: 10 });
      await setDoc(doc(items, 'twenty'), { val: 20 });

      return {
        eqTen: await observeFirestoreIdQuery(() => getDocs(query(items, where('val', '==', 10)))),
        eqNull: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('val', '==', null))),
        ),
        ltTwenty: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('val', '<', 20))),
        ),
        lteTwenty: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('val', '<=', 20))),
        ),
        gtTen: await observeFirestoreIdQuery(() => getDocs(query(items, where('val', '>', 10)))),
        gteTen: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('val', '>=', 10))),
        ),
        inTenTwenty: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('val', 'in', [10, 20]))),
        ),
        inWithNull: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('val', 'in', [10, null]))),
        ),
        neqTen: await observeFirestoreIdQuery(() => getDocs(query(items, where('val', '!=', 10)))),
        neqNull: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('val', '!=', null))),
        ),
        notInTen: await observeFirestoreNotInQuery({
          webConfig: db.app.options,
          collectionPath: itemsPath,
          field: 'val',
          values: [10],
        }),
        notInWithNull: await observeFirestoreNotInQuery({
          webConfig: db.app.options,
          collectionPath: itemsPath,
          field: 'val',
          values: [10, null],
        }),
      };
    });
  },
};
