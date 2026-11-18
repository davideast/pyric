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
    'CollectionReference.withConverter(converter) propagates onto doc(typedColl, id) and auto-id doc(typedColl) for writes and reads.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, setDoc } = firestoreSdk;
      const rawColl = collection(db, collectionPath('wc-coll-doc'));
      const { converter, toFirestoreCalls, fromFirestoreCalls } = createRecordedItemConverter();
      const typedColl = rawColl.withConverter(converter);

      const namedDoc = doc(typedColl, 'd1');
      const autoDoc = doc(typedColl);

      await setDoc(namedDoc, { title: 'Named', count: 2, tag: 'fixed' });
      await setDoc(autoDoc, { title: 'Auto', count: 4 });

      const rawNamedSnap = await getDoc(doc(rawColl, 'd1'));
      const typedNamedSnap = await getDoc(namedDoc);
      const typedAutoSnap = await getDoc(autoDoc);

      return {
        rawCollType: rawColl.type,
        typedCollType: typedColl.type,
        rawCollConverterIsNull: rawColl.converter === null,
        typedCollConverterMatches: typedColl.converter === converter,
        namedDocConverterMatches: namedDoc.converter === converter,
        autoDocConverterMatches: autoDoc.converter === converter,
        autoDocIdLength: autoDoc.id.length,
        rawNamedStored: rawNamedSnap.data() ?? null,
        typedNamedRead: typedNamedSnap.data() ?? null,
        typedAutoRead: typedAutoSnap.data() ?? null,
        toFirestoreCallCount: toFirestoreCalls.length,
        fromFirestoreCallCount: fromFirestoreCalls.length,
      };
    });
  },
};
