import type { FirestoreDataConverter } from 'firebase/firestore';
import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

interface CounterModel {
  readonly label: string;
  readonly count: number;
}

const AUTO_ID_RE = /^[A-Za-z0-9]{20}$/;

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'addDoc on a converted CollectionReference returns a 20-char auto-ID DocumentReference carrying the parent converter, updateDoc bypasses converter hooks on partial writes, and deleteDoc removes the document so subsequent getDoc reports exists() === false.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { addDoc, collection, deleteDoc, doc, getDoc, updateDoc } = firestoreSdk;

      let toFirestoreCalls = 0;
      let fromFirestoreCalls = 0;

      const converter: FirestoreDataConverter<CounterModel> = {
        toFirestore(model: CounterModel) {
          toFirestoreCalls += 1;
          return { rawLabel: model.label, count: model.count };
        },
        fromFirestore(snapshot) {
          fromFirestoreCalls += 1;
          const raw = snapshot.data();
          return {
            label: String(raw.rawLabel).toUpperCase(),
            count: Number(raw.count),
          };
        },
      };

      const rawColl = collection(db, collectionPath('crud-converter-add-delete'));
      const typedColl = rawColl.withConverter(converter);

      const addedRef = await addDoc(typedColl, { label: 'alpha', count: 1 });
      const toCallsAfterAddDoc = toFirestoreCalls;

      const addedTypedSnap = await getDoc(addedRef);
      const fromCallsAfterInitialRead = fromFirestoreCalls;
      const rawStoredSnap = await getDoc(doc(rawColl, addedRef.id));

      await updateDoc(addedRef, { count: 7 });
      const toCallsAfterUpdateDoc = toFirestoreCalls;
      const fromCallsAfterUpdateDoc = fromFirestoreCalls;

      const updatedTypedSnap = await getDoc(addedRef);
      const fromCallsAfterUpdatedRead = fromFirestoreCalls;

      await deleteDoc(addedRef);
      const deletedSnap = await getDoc(addedRef);
      const fromCallsAfterDeletedRead = fromFirestoreCalls;

      return {
        addDocShape: {
          refType: addedRef.type,
          autoIdLength: addedRef.id.length,
          autoIdAlphanumeric: AUTO_ID_RE.test(addedRef.id),
          parentPathMatches: addedRef.parent.path === typedColl.path,
          converterPropagated: addedRef.converter === converter,
          toCallsAfterAddDoc,
          fromCallsAfterInitialRead,
          initialTypedData: addedTypedSnap.data() ?? null,
          rawStoredData: rawStoredSnap.data() ?? null,
        },
        updateDocBypass: {
          toCallsUnchanged: toCallsAfterUpdateDoc === toCallsAfterAddDoc,
          fromCallsUnchangedDuringWrite: fromCallsAfterUpdateDoc === fromCallsAfterInitialRead,
          updatedTypedData: updatedTypedSnap.data() ?? null,
          fromCallsAfterUpdatedRead,
        },
        deleteDocRemoval: {
          existsAfterDelete: deletedSnap.exists(),
          dataUndefinedAfterDelete: deletedSnap.data() === undefined,
          fromCallsUnchangedOnMissingRead:
            fromCallsAfterDeletedRead === fromCallsAfterUpdatedRead,
        },
      };
    });
  },
};
