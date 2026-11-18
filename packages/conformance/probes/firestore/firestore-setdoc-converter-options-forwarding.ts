import type { Probe } from '../../rigs/types.ts';
import { createSetDocOptionsRecorder } from '../../src/firestore-setdoc-probe-helpers.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'setDoc on a converted DocumentReference invokes converter.toFirestore before writing, passing 1 arg on full writes and forwarding SetOptions as arg 2 on merge/mergeFields writes.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('setdoc-converter-opts'));
      const rawRef = doc(items, 'item-1');
      const { converter, calls } = createSetDocOptionsRecorder();
      const typedRef = rawRef.withConverter(converter as never);

      await setDoc(typedRef, { label: 'First', units: 2, note: 'init' });
      const afterFullRaw = (await getDoc(rawRef)).data() ?? null;

      await setDoc(typedRef, { units: 6 }, { merge: true });
      const afterMergeTrueRaw = (await getDoc(rawRef)).data() ?? null;

      await setDoc(
        typedRef,
        { label: 'MaskedLabel', note: 'IgnoredByMask' },
        { mergeFields: ['dbLabel'] },
      );
      const afterMergeFieldsRaw = (await getDoc(rawRef)).data() ?? null;
      const afterMergeFieldsTyped = (await getDoc(typedRef)).data() ?? null;

      return {
        toFirestoreCalls: calls,
        afterFullRaw,
        afterMergeTrueRaw,
        afterMergeFieldsRaw,
        afterMergeFieldsTyped,
      };
    });
  },
};
