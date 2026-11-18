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
    'setDoc through a converted DocumentReference invokes converter.toFirestore(data) on full writes and converter.toFirestore(data, options) on merge and mergeFields writes.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, setDoc } = firestoreSdk;
      const rawDoc = doc(collection(db, collectionPath('wc-setdoc-tofirestore')), 'd1');
      const { converter, toFirestoreCalls } = createRecordedItemConverter();
      const typedDoc = rawDoc.withConverter(converter);

      await setDoc(typedDoc, { title: 'Initial', count: 1, tag: 'base' });
      const afterFullWrite = (await getDoc(rawDoc)).data() ?? null;

      await setDoc(typedDoc, { count: 7 }, { merge: true });
      const afterMergeTrue = (await getDoc(rawDoc)).data() ?? null;

      await setDoc(
        typedDoc,
        { title: 'IgnoredByMask', count: 99, tag: 'masked-tag' },
        { mergeFields: ['dbTag'] },
      );
      const afterMergeFields = (await getDoc(rawDoc)).data() ?? null;

      return {
        toFirestoreCalls: [...toFirestoreCalls],
        afterFullWrite,
        afterMergeTrue,
        afterMergeFields,
      };
    });
  },
};
