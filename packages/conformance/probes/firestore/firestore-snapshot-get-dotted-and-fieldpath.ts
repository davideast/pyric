import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'DocumentSnapshot.get(fieldPath) resolves dotted string paths and FieldPath instances (including literal-dot keys and falsy scalar values), returning undefined on missing documents or absent fields.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { FieldPath, collection, doc, getDoc, getDocs, setDoc } = firestoreSdk;

      const items = collection(db, collectionPath('snapshot-get'));
      const missingSnap = await getDoc(doc(items, 'absent-doc'));
      const missingDocReads = {
        dottedIsUndefined: missingSnap.get('profile.handle') === undefined,
        fieldPathIsUndefined: missingSnap.get(new FieldPath('profile', 'handle')) === undefined,
      };

      const targetRef = doc(items, 'rich-doc');
      await setDoc(targetRef, {
        profile: {
          handle: 'ada',
          stats: { wins: 7 },
        },
        'a.b': 'literal-dot-value',
        a: { b: 'nested-b-value' },
        zeroVal: 0,
        falseVal: false,
        nullVal: null,
      });

      const docSnap = await getDoc(targetRef);
      const readFromSnapshot = (snap: typeof docSnap) => ({
        dottedNestedHandle: snap.get('profile.handle'),
        dottedDeepWins: snap.get('profile.stats.wins'),
        fieldPathDeepWins: snap.get(new FieldPath('profile', 'stats', 'wins')),
        dottedAB: snap.get('a.b'),
        fieldPathLiteralDotAB: snap.get(new FieldPath('a.b')),
        fieldPathTwoSegmentAB: snap.get(new FieldPath('a', 'b')),
        zeroVal: snap.get('zeroVal'),
        falseVal: snap.get('falseVal'),
        nullVal: snap.get('nullVal'),
        absentDottedIsUndefined: snap.get('profile.nonexistent') === undefined,
        absentFieldPathIsUndefined:
          snap.get(new FieldPath('profile', 'nonexistent')) === undefined,
      });

      const docSnapValues = readFromSnapshot(docSnap);
      const querySnap = await getDocs(items);
      const queryDocValues = readFromSnapshot(querySnap.docs[0]);

      const converter = {
        toFirestore(value: Record<string, unknown>) {
          return value;
        },
        fromFirestore(snapshot: { data(): Record<string, unknown> }) {
          return { wrapped: true, rawKeysCount: Object.keys(snapshot.data()).length };
        },
      };
      const typedSnap = await getDoc(targetRef.withConverter(converter));

      return {
        missingDocReads,
        docSnapValues,
        queryDocMatchesDocSnap:
          JSON.stringify(queryDocValues) === JSON.stringify(docSnapValues),
        withConverterSnapshot: {
          convertedDataWrapped: typedSnap.data()?.wrapped === true,
          getStillReadsStoredField: typedSnap.get('profile.handle'),
          getAbsentStillUndefined: typedSnap.get('profile.missing') === undefined,
        },
      };
    });
  },
};
