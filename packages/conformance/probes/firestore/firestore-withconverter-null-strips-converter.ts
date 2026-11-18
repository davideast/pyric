import type { Probe } from '../../rigs/types.ts';
import { createRecordedItemConverter } from '../../src/firestore-withconverter-probe-model.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#49',
  rowIds: ['firestore#49'],
  description:
    'DocumentReference.withConverter(null) strips the converter and returns an untyped DocumentData view.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, refEqual, setDoc } = firestoreSdk;
      const rawDoc = doc(collection(db, collectionPath('wc-strip-null')), 'd1');
      const { converter, toFirestoreCalls, fromFirestoreCalls, resetCalls } =
        createRecordedItemConverter();
      const typedDoc = rawDoc.withConverter(converter);
      await setDoc(typedDoc, { title: 'TypedFirst', count: 5, tag: 'init' });

      resetCalls();
      const strippedDoc = typedDoc.withConverter(null);
      const strippedSnap = await getDoc(strippedDoc);
      const strippedReadData = strippedSnap.data() ?? null;
      const fromCallsDuringStrippedRead = fromFirestoreCalls.length;

      await setDoc(strippedDoc, { rawField: 'untyped-overwrite', rawNum: 9 });
      const toCallsDuringStrippedWrite = toFirestoreCalls.length;
      const afterRawWriteSnap = await getDoc(rawDoc);

      return {
        strippedConverterIsNull: strippedDoc.converter === null,
        refEqualRawAndStripped: refEqual(rawDoc, strippedDoc),
        refEqualTypedAndStripped: refEqual(typedDoc, strippedDoc),
        strippedReadData,
        fromCallsDuringStrippedRead,
        toCallsDuringStrippedWrite,
        afterRawWriteStored: afterRawWriteSnap.data() ?? null,
      };
    });
  },
};
