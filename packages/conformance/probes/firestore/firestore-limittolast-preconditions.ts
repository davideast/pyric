import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore #61',
  rowIds: ['firestore#61'],
  description:
    'limitToLast without orderBy -- error class/code prod throws; with orderBy returns the trailing window.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { collection, doc, getDocs, limitToLast, orderBy, query, setDoc } = firestoreSdk;
      const items = collection(db, collectionPath('limittolast'));
      await setDoc(doc(items, 'a'), { pos: 1 });
      await setDoc(doc(items, 'b'), { pos: 2 });

      let noOrderByThrew = false;
      let code: string | null = null;
      let message: string | null = null;
      try {
        await getDocs(query(items, limitToLast(2)));
      } catch (e) {
        noOrderByThrew = true;
        code = (e as { code?: string }).code ?? null;
        if (e instanceof Error) {
          message = e.message;
        } else {
          message = String(e);
        }
      }

      const trailing = await getDocs(query(items, orderBy('pos'), limitToLast(1)));
      return {
        noOrderByThrew,
        code,
        message,
        trailingIds: trailing.docs.map((item) => item.id),
      };
    });
  },
};
