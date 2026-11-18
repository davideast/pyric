import type { Probe } from '../../rigs/types.ts';
import { createRecordedItemConverter } from '../../src/firestore-withconverter-probe-model.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'updateDoc through a converted DocumentReference bypasses converter.toFirestore and converter.fromFirestore across object and field/value forms.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, setDoc, updateDoc } = firestoreSdk;
      const rawDoc = doc(collection(db, collectionPath('wc-updatedoc-bypass')), 'd1');
      const { converter, toFirestoreCalls, fromFirestoreCalls, resetCalls } =
        createRecordedItemConverter();
      const typedDoc = rawDoc.withConverter(converter);

      await setDoc(typedDoc, { title: 'Seed', count: 2, tag: 'initial' });
      resetCalls();

      await updateDoc(typedDoc, { dbCount: 90 });
      await updateDoc(typedDoc, 'dbTag', 'patched-via-field-arg');
      const toCallsDuringUpdateDoc = toFirestoreCalls.length;
      const fromCallsDuringUpdateDoc = fromFirestoreCalls.length;

      const rawAfterUpdate = (await getDoc(rawDoc)).data() ?? null;
      const typedAfterUpdate = (await getDoc(typedDoc)).data() ?? null;

      return {
        toCallsDuringUpdateDoc,
        fromCallsDuringUpdateDoc,
        rawAfterUpdate,
        typedAfterUpdate,
      };
    });
  },
};
