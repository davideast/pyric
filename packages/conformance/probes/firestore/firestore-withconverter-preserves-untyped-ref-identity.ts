import type { Probe } from '../../rigs/types.ts';
import { createRecordedItemConverter } from '../../src/firestore-withconverter-probe-model.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#50',
  rowIds: ['firestore#50'],
  description:
    'Original untyped DocumentReference keeps its identity and untyped view after withConverter(converter) creates a typed view on the same path.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDoc, refEqual, setDoc } = firestoreSdk;
      const untypedDoc = doc(collection(db, collectionPath('wc-untyped-identity')), 'd1');
      const { converter, toFirestoreCalls, fromFirestoreCalls, resetCalls } =
        createRecordedItemConverter();
      const typedDoc = untypedDoc.withConverter(converter);

      await setDoc(untypedDoc, { dbTitle: 'RawSeed', dbCount: 60, dbTag: 'raw' });
      const toCallsDuringUntypedWrite = toFirestoreCalls.length;

      resetCalls();
      const typedSnap = await getDoc(typedDoc);
      const typedReadData = typedSnap.data() ?? null;
      const fromCallsDuringTypedRead = fromFirestoreCalls.length;

      resetCalls();
      const untypedSnap = await getDoc(untypedDoc);
      const untypedReadData = untypedSnap.data() ?? null;
      const fromCallsDuringUntypedRead = fromFirestoreCalls.length;

      return {
        sameObjectIdentity: (untypedDoc as unknown) === (typedDoc as unknown),
        samePath: untypedDoc.path === typedDoc.path,
        sameId: untypedDoc.id === typedDoc.id,
        untypedConverterRemainsNull: untypedDoc.converter === null,
        typedConverterMatches: typedDoc.converter === converter,
        refEqualUntypedAndTyped: refEqual(untypedDoc, typedDoc),
        toCallsDuringUntypedWrite,
        typedReadData,
        fromCallsDuringTypedRead,
        untypedReadData,
        fromCallsDuringUntypedRead,
      };
    });
  },
};
