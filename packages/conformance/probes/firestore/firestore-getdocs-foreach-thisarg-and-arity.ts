import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'QuerySnapshot.forEach(callback, thisArg) invokes callback.call(thisArg, doc) once per document in query order with single-argument arity across raw and withConverter queries.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, orderBy, query, setDoc } = firestoreSdk;

      const emptyColl = collection(db, collectionPath('foreach-empty'));
      const emptySnap = await getDocs(emptyColl);
      let emptyCallCount = 0;
      emptySnap.forEach(() => {
        emptyCallCount += 1;
      });

      const items = collection(db, collectionPath('foreach-items'));
      await setDoc(doc(items, 'step-2'), { seq: 2, code: 'two' });
      await setDoc(doc(items, 'step-1'), { seq: 1, code: 'one' });
      await setDoc(doc(items, 'step-3'), { seq: 3, code: 'three' });

      const orderedQuery = query(items, orderBy('seq', 'asc'));
      const snap = await getDocs(orderedQuery);
      const receiver = { marker: 'bound-receiver' };
      const rawVisits: Array<{
        id: string;
        code: unknown;
        argCount: number;
        thisBoundToReceiver: boolean;
        exists: boolean;
      }> = [];

      snap.forEach(function (this: unknown, docSnap) {
        rawVisits.push({
          id: docSnap.id,
          code: docSnap.data().code,
          argCount: arguments.length,
          thisBoundToReceiver: this === receiver,
          exists: docSnap.exists(),
        });
      }, receiver);

      const converter = {
        toFirestore(model: { seq: number; upperCode: string }) {
          return { seq: model.seq, code: model.upperCode.toLowerCase() };
        },
        fromFirestore(snapshot: { data(): Record<string, unknown> }) {
          const raw = snapshot.data();
          return {
            seq: Number(raw.seq),
            upperCode: String(raw.code).toUpperCase(),
          };
        },
      };

      const typedQuery = query(items.withConverter(converter), orderBy('seq', 'desc'));
      const typedSnap = await getDocs(typedQuery);
      const converterVisits: Array<{
        id: string;
        data: { seq: number; upperCode: string };
        argCount: number;
        thisBoundToReceiver: boolean;
      }> = [];

      typedSnap.forEach(function (this: unknown, docSnap) {
        converterVisits.push({
          id: docSnap.id,
          data: docSnap.data(),
          argCount: arguments.length,
          thisBoundToReceiver: this === receiver,
        });
      }, receiver);

      return {
        emptyCallCount,
        rawVisits,
        converterVisits,
      };
    });
  },
};
