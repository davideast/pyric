import type { Probe } from '../../rigs/types.ts';
import {
  observeFirestoreCall,
  observeFirestoreIdQuery,
  type FirestoreSyncCallOutcome,
} from '../../src/firestore-probe-outcomes.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export async function probeClientZeroArgCompositeConstruction(): Promise<{
  orZeroArgs: FirestoreSyncCallOutcome;
  andZeroArgs: FirestoreSyncCallOutcome;
  queryWithOrZeroArgs: FirestoreSyncCallOutcome;
  queryWithAndZeroArgs: FirestoreSyncCallOutcome;
}> {
  const [{ deleteApp, initializeApp }, { and, collection, getFirestore, or, query }] =
    await Promise.all([import('firebase/app'), import('firebase/firestore')]);
  const app = initializeApp(
    { projectId: 'zero-arg-composite-check', apiKey: 'local-validation-only' },
    `zero-arg-composite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    const coll = collection(getFirestore(app), 'items');
    const orZero = or as () => ReturnType<typeof or>;
    const andZero = and as () => ReturnType<typeof and>;
    return {
      orZeroArgs: observeFirestoreCall(() => orZero()),
      andZeroArgs: observeFirestoreCall(() => andZero()),
      queryWithOrZeroArgs: observeFirestoreCall(() => query(coll, orZero())),
      queryWithAndZeroArgs: observeFirestoreCall(() => query(coll, andZero())),
    };
  } finally {
    await deleteApp(app);
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Zero-argument or() and and() behavior on client construction and live getDocs(query(coll, or())) / getDocs(query(coll, and())) execution.',
  async observe() {
    const clientConstruction = await probeClientZeroArgCompositeConstruction();
    const liveExecution = await withFirestoreProbeSession(
      async ({ db, firestoreSdk, collectionPath }) => {
        const { and, collection, doc, getDocs, or, query, setDoc } = firestoreSdk;
        const items = collection(db, collectionPath('composite-zero-arg'));
        await setDoc(doc(items, 'd1'), { score: 10 });
        await setDoc(doc(items, 'd2'), { score: 20 });

        const orZero = or as () => ReturnType<typeof or>;
        const andZero = and as () => ReturnType<typeof and>;

        return {
          getDocsWithOrZeroArgs: await observeFirestoreIdQuery(() =>
            getDocs(query(items, orZero())),
          ),
          getDocsWithAndZeroArgs: await observeFirestoreIdQuery(() =>
            getDocs(query(items, andZero())),
          ),
        };
      },
    );
    return {
      clientConstruction,
      liveExecution,
    };
  },
};
