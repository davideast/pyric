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
    'orderBy cross-type canonical sort order (null, boolean, NaN/number, Timestamp, string, Bytes, DocumentReference, GeoPoint, array, map) and same-type range filter isolation.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { Bytes, GeoPoint, Timestamp, collection, doc, getDocs, orderBy, query, setDoc, where } =
        firestoreSdk;
      const items = collection(db, collectionPath('orderby-type-order'));
      const refTarget = doc(db, collectionPath('orderby-type-targets'), 'target-a');

      await setDoc(doc(items, 't_map'), { v: { k: 1 } });
      await setDoc(doc(items, 't_arr'), { v: [1, 2] });
      await setDoc(doc(items, 't_geo'), { v: new GeoPoint(10, 20) });
      await setDoc(doc(items, 't_ref'), { v: refTarget });
      await setDoc(doc(items, 't_bytes'), { v: Bytes.fromUint8Array(new Uint8Array([1, 2])) });
      await setDoc(doc(items, 't_str'), { v: 'alpha' });
      await setDoc(doc(items, 't_ts'), { v: Timestamp.fromMillis(1_700_000_000_000) });
      await setDoc(doc(items, 't_num_ten'), { v: 10 });
      await setDoc(doc(items, 't_num_two'), { v: 2 });
      await setDoc(doc(items, 't_num_neg'), { v: -5 });
      await setDoc(doc(items, 't_num_nan'), { v: Number.NaN });
      await setDoc(doc(items, 't_bool_true'), { v: true });
      await setDoc(doc(items, 't_bool_false'), { v: false });
      await setDoc(doc(items, 't_null'), { v: null });

      return {
        allAsc: await observeFirestoreIdQuery(() => getDocs(query(items, orderBy('v', 'asc')))),
        allDesc: await observeFirestoreIdQuery(() => getDocs(query(items, orderBy('v', 'desc')))),
        numberRangeGtZero: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('v', '>', 0))),
        ),
        stringRangeGteA: await observeFirestoreIdQuery(() =>
          getDocs(query(items, where('v', '>=', 'a'))),
        ),
      };
    });
  },
};
