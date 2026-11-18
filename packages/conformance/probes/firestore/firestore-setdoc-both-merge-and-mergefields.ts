import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { observeFirestoreWriteAttempt } from '../../src/firestore-setdoc-probe-helpers.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#29',
  rowIds: ['firestore#29'],
  description:
    'Observes setDoc(ref, data, options) when both merge and mergeFields are supplied on the options object ({ merge: true, mergeFields } and { merge: false, mergeFields }).',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('setdoc-both-flags'));

      const mergeTrueRef = doc(items, 'both-merge-true');
      await setDoc(mergeTrueRef, { existing: 'stay', masked: 'old', unmasked: 'old-unmasked' });
      const mergeTrueAttempt = await observeFirestoreWriteAttempt(
        () =>
          setDoc(
            mergeTrueRef,
            { masked: 'new-masked', unmasked: 'new-unmasked' },
            { merge: true, mergeFields: ['masked'] } as never,
          ),
        FirebaseError,
      );
      const mergeTrueSnap = await getDoc(mergeTrueRef);

      const mergeFalseRef = doc(items, 'both-merge-false');
      await setDoc(mergeFalseRef, { existing: 'stay', masked: 'old', unmasked: 'old-unmasked' });
      const mergeFalseAttempt = await observeFirestoreWriteAttempt(
        () =>
          setDoc(
            mergeFalseRef,
            { masked: 'new-masked', unmasked: 'new-unmasked' },
            { merge: false, mergeFields: ['masked'] } as never,
          ),
        FirebaseError,
      );
      const mergeFalseSnap = await getDoc(mergeFalseRef);

      return {
        mergeTrueAndMergeFields: {
          threw: mergeTrueAttempt.threw,
          errorName: mergeTrueAttempt.errorName,
          isFirebaseError: mergeTrueAttempt.isFirebaseError,
          code: mergeTrueAttempt.code,
          storedData: mergeTrueSnap.data() ?? null,
        },
        mergeFalseAndMergeFields: {
          threw: mergeFalseAttempt.threw,
          errorName: mergeFalseAttempt.errorName,
          isFirebaseError: mergeFalseAttempt.isFirebaseError,
          code: mergeFalseAttempt.code,
          storedData: mergeFalseSnap.data() ?? null,
        },
      };
    });
  },
};
