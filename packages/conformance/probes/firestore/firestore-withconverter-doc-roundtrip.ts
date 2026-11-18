import type { Probe } from '../../rigs/types.ts';
import { createRecordedItemConverter } from '../../src/firestore-withconverter-probe-model.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#46',
  rowIds: ['firestore#46'],
  description:
    'DocumentReference.withConverter(converter) returns a typed reference that runs toFirestore on writes and fromFirestore on reads.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('wc-doc-roundtrip'));
      const rawDoc = doc(items, 'd1');
      const { converter, toFirestoreCalls, fromFirestoreCalls } = createRecordedItemConverter();
      const typedDoc = rawDoc.withConverter(converter);

      await setDoc(typedDoc, { title: 'Alpha', count: 3, tag: 'v1' });

      const rawSnap = await getDoc(rawDoc);
      const typedSnap = await getDoc(typedDoc);

      return {
        hasTopLevelWithConverterExport: 'withConverter' in firestoreSdk,
        hasDocWithConverterMethod: typeof rawDoc.withConverter === 'function',
        rawDocType: rawDoc.type,
        typedDocType: typedDoc.type,
        rawConverterIsNull: rawDoc.converter === null,
        typedConverterMatches: typedDoc.converter === converter,
        typedParentConverterMatches: typedDoc.parent.converter === converter,
        rawStoredData: rawSnap.data() ?? null,
        typedReadData: typedSnap.data() ?? null,
        toFirestoreCallCount: toFirestoreCalls.length,
        fromFirestoreCallCount: fromFirestoreCalls.length,
      };
    });
  },
};
