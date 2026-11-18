import type { Probe } from '../../rigs/types.ts';
import { observeFirestoreFieldQuery } from '../../src/firestore-not-in-probe.ts';
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
      const { collection, doc, setDoc } = firestoreSdk;
      const itemsPath = collectionPath('where-existence-null');
      const items = collection(db, itemsPath);
      await setDoc(doc(items, 'missing'), { label: 'absent' });
      await setDoc(doc(items, 'null_val'), { val: null });
      await setDoc(doc(items, 'ten'), { val: 10 });
      await setDoc(doc(items, 'twenty'), { val: 20 });

      const webConfig = db.app.options;
      const runWhere = (
        op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in',
        value: number | null | readonly (number | null)[],
      ) =>
        observeFirestoreFieldQuery({
          webConfig,
          collectionPath: itemsPath,
          field: 'val',
          op,
          value,
        });

      return {
        eqTen: await runWhere('==', 10),
        eqNull: await runWhere('==', null),
        ltTwenty: await runWhere('<', 20),
        lteTwenty: await runWhere('<=', 20),
        gtTen: await runWhere('>', 10),
        gteTen: await runWhere('>=', 10),
        inTenTwenty: await runWhere('in', [10, 20]),
        inWithNull: await runWhere('in', [10, null]),
        neqTen: await runWhere('!=', 10),
        neqNull: await runWhere('!=', null),
        notInTen: await runWhere('not-in', [10]),
        notInWithNull: await runWhere('not-in', [10, null]),
      };
    });
  },
};
