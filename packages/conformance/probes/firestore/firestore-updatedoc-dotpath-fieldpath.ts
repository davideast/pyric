import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore #33',
  rowIds: ['firestore#33'],
  description:
    'updateDoc top-level dot-separated string keys parse as FieldPaths (nested write preserving siblings), not literal keys.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { doc, getDoc, setDoc, updateDoc } = firestoreSdk;
      const targetRef = doc(db, collectionPath('updatedoc-dotpath'), 'a');
      await setDoc(targetRef, { a: { b: 1, c: 3 }, top: 1 });
      await updateDoc(targetRef, { 'a.b': 2 });
      const data = (await getDoc(targetRef)).data() as {
        a: { b: number; c: number };
        top: number;
      };
      return {
        data,
        nestedUpdated: data.a.b,
        siblingPreserved: data.a.c,
        literalDotKeyPresent: 'a.b' in data,
      };
    });
  },
};
