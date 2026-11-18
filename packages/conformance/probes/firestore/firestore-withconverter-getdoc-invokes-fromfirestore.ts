import type { Probe } from '../../rigs/types.ts';
import { createRecordedItemConverter } from '../../src/firestore-withconverter-probe-model.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#52',
  rowIds: ['firestore#52'],
  description:
    'getDoc through a converted DocumentReference invokes converter.fromFirestore(snapshot, options) on existing documents and returns undefined without invoking fromFirestore on missing documents.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('wc-getdoc-fromfirestore'));
      const { converter, fromFirestoreCalls, resetCalls } = createRecordedItemConverter();

      const missingTypedDoc = doc(items, 'missing').withConverter(converter);
      const missingSnap = await getDoc(missingTypedDoc);
      const callsAfterMissingGetDoc = fromFirestoreCalls.length;
      const missingRawValue = missingSnap.data();
      const missingDataIsUndefined = missingRawValue === undefined;
      const callsAfterMissingData = fromFirestoreCalls.length;

      const existingTypedDoc = doc(items, 'existing').withConverter(converter);
      await setDoc(existingTypedDoc, { title: 'Present', count: 8, tag: 'ok' });
      resetCalls();

      const existingSnap = await getDoc(existingTypedDoc);
      const callsAfterGetDocBeforeData = fromFirestoreCalls.length;
      const firstData = existingSnap.data() ?? null;
      const callsAfterFirstData = fromFirestoreCalls.length;
      const secondData = existingSnap.data() ?? null;
      const callsAfterSecondData = fromFirestoreCalls.length;

      return {
        missingExists: missingSnap.exists(),
        missingDataIsUndefined,
        callsAfterMissingGetDoc,
        callsAfterMissingData,
        existingExists: existingSnap.exists(),
        snapshotRefConverterMatches: existingSnap.ref.converter === converter,
        callsAfterGetDocBeforeData,
        callsAfterFirstData,
        callsAfterSecondData,
        firstData,
        secondData,
        recordedCalls: [...fromFirestoreCalls],
      };
    });
  },
};
