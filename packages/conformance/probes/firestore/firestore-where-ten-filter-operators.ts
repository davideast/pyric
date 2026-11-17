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
    'where(field, op, value) evaluation across all 10 filter operators (<, <=, ==, >=, >, !=, in, not-in, array-contains, array-contains-any).',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, query, setDoc, where } = firestoreSdk;
      const itemsPath = collectionPath('where-ten-ops');
      const items = collection(db, itemsPath);
      await setDoc(doc(items, 'd1'), { num: 10, tags: ['red', 'blue'] });
      await setDoc(doc(items, 'd2'), { num: 20, tags: ['blue', 'green'] });
      await setDoc(doc(items, 'd3'), { num: 30, tags: ['yellow'] });
      await setDoc(doc(items, 'd4'), { num: 40, tags: [] });

      return {
        lt: await observeFirestoreIdQuery(() => getDocs(query(items, where('num', '<', 30)))),
        lte: await observeFirestoreIdQuery(() => getDocs(query(items, where('num', '<=', 30)))),
        eq: await observeFirestoreIdQuery(() => getDocs(query(items, where('num', '==', 20)))),
        gte: await observeFirestoreIdQuery(() => getDocs(query(items, where('num', '>=', 20)))),
        gt: await observeFirestoreIdQuery(() => getDocs(query(items, where('num', '>', 20)))),
        neq: await observeFirestoreIdQuery(() => getDocs(query(items, where('num', '!=', 20)))),
        inOp: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('num', 'in', [10, 30]))),
        ),
        notInOp: await observeFirestoreNotInQuery({
          webConfig: db.app.options,
          collectionPath: itemsPath,
          field: 'num',
          values: [10, 30],
        }),
        arrayContains: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('tags', 'array-contains', 'blue'))),
        ),
        arrayContainsAny: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('tags', 'array-contains-any', ['red', 'yellow']))),
        ),
      };
    });
  },
};
