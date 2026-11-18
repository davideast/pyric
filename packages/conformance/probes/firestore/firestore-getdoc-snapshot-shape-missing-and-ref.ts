import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#16',
  rowIds: ['firestore#16', 'firestore#17', 'firestore#18', 'firestore#19'],
  description:
    'getDoc(ref) returns a DocumentSnapshot with id, exists() method, data() (undefined when missing), and a tagged snap.ref usable in follow-up updateDoc, getDoc, and deleteDoc calls.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { DocumentSnapshot, collection, deleteDoc, doc, getDoc, setDoc, updateDoc } =
        firestoreSdk;

      const items = collection(db, collectionPath('getdoc-shape'));
      const missingRef = doc(items, 'missing-doc');
      const missingSnap = await getDoc(missingRef);
      const missingObservation = {
        isDocumentSnapshot: missingSnap instanceof DocumentSnapshot,
        id: missingSnap.id,
        existsIsFunction: typeof missingSnap.exists === 'function',
        exists: missingSnap.exists(),
        dataIsUndefined: missingSnap.data() === undefined,
        refPathMatchesInput: missingSnap.ref.path === missingRef.path,
        refParentMatchesCollection: missingSnap.ref.parent.path === items.path,
      };

      const targetRef = doc(items, 'alpha-doc');
      await setDoc(targetRef, { title: 'Alpha', count: 3 });
      const hitSnap = await getDoc(targetRef);
      const hitObservation = {
        isDocumentSnapshot: hitSnap instanceof DocumentSnapshot,
        id: hitSnap.id,
        existsIsFunction: typeof hitSnap.exists === 'function',
        exists: hitSnap.exists(),
        data: hitSnap.data() ?? null,
        refPathMatchesInput: hitSnap.ref.path === targetRef.path,
        refParentMatchesCollection: hitSnap.ref.parent.path === items.path,
      };

      await updateDoc(hitSnap.ref, { count: 10 });
      const afterUpdateSnap = await getDoc(hitSnap.ref);
      const afterUpdateData = afterUpdateSnap.data() ?? null;

      await deleteDoc(hitSnap.ref);
      const afterDeleteSnap = await getDoc(hitSnap.ref);

      return {
        missingDoc: missingObservation,
        seededDoc: hitObservation,
        followUpViaSnapRef: {
          afterUpdateExists: afterUpdateSnap.exists(),
          afterUpdateData,
          afterDeleteExists: afterDeleteSnap.exists(),
          afterDeleteDataIsUndefined: afterDeleteSnap.data() === undefined,
        },
      };
    });
  },
};
