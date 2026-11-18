import { FirebaseError } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import {
  isFirestoreAutoIdShape,
  observeFirestoreConstructorCall,
} from '../../src/firestore-path-constructor-probe-helpers.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#11',
  rowIds: ['firestore#11'],
  description:
    'doc(coll) with zero relative segments mints a 20-character alphanumeric auto-ID DocumentReference under coll.path while doc(db) with zero path segments throws.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, setDoc } = firestoreSdk;

      const items = collection(db, 'items');
      const autoRefA = doc(items);
      const autoRefB = doc(items);
      const docDbNoPath = observeFirestoreConstructorCall(
        () => (doc as unknown as (parent: unknown) => unknown)(db),
        FirebaseError,
      );

      const liveColl = collection(db, collectionPath('pc-doc-autoid'));
      const liveAutoRef = doc(liveColl);
      await setDoc(liveAutoRef, { autoMinted: true });
      const liveSnap = await getDoc(doc(liveColl, liveAutoRef.id));

      return {
        type: autoRefA.type,
        idLength: autoRefA.id.length,
        idIsAlphanumeric20: isFirestoreAutoIdShape(autoRefA.id),
        secondIdIsAlphanumeric20: isFirestoreAutoIdShape(autoRefB.id),
        twoCallsDistinct: autoRefA.id !== autoRefB.id,
        pathMatchesCollectionAndId: autoRefA.path === `items/${autoRefA.id}`,
        parentPath: autoRefA.parent.path,
        docDbNoPathError: {
          threw: docDbNoPath.threw,
          isFirebaseError: docDbNoPath.isFirebaseError,
          isTypeError: docDbNoPath.isTypeError,
          code: docDbNoPath.code,
        },
        liveRoundtripData: liveSnap.data() ?? null,
      };
    });
  },
};
