import type { Probe } from '../../rigs/types.ts';
import {
  observeFirestoreCall,
  observeFirestoreIdQuery,
  type FirestoreSyncCallOutcome,
} from '../../src/firestore-probe-outcomes.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export async function probeClientTopLevelCompositeFilterMixing(): Promise<{
  orWithOrderByAndLimit: FirestoreSyncCallOutcome;
  wherePlusOrSameCall: FirestoreSyncCallOutcome;
  orPlusWhereSameCall: FirestoreSyncCallOutcome;
  orPlusOrSameCall: FirestoreSyncCallOutcome;
  andWrappingWhereAndOr: FirestoreSyncCallOutcome;
  chainedWhereThenOr: FirestoreSyncCallOutcome;
}> {
  const [{ deleteApp, initializeApp }, { and, collection, getFirestore, limit, or, orderBy, query, where }] =
    await Promise.all([import('firebase/app'), import('firebase/firestore')]);
  const app = initializeApp(
    { projectId: 'composite-mixing-check', apiKey: 'local-validation-only' },
    `composite-mixing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    const coll = collection(getFirestore(app), 'items');
    const queryUntyped = query as (...args: unknown[]) => unknown;
    return {
      orWithOrderByAndLimit: observeFirestoreCall(() =>
        query(
          coll,
          or(where('score', '==', 10), where('score', '==', 30)),
          orderBy('score', 'desc'),
          limit(2),
        ),
      ),
      wherePlusOrSameCall: observeFirestoreCall(() =>
        queryUntyped(
          coll,
          where('group', '==', 'alpha'),
          or(where('score', '==', 10), where('score', '==', 40)),
        ),
      ),
      orPlusWhereSameCall: observeFirestoreCall(() =>
        queryUntyped(
          coll,
          or(where('score', '==', 10), where('score', '==', 40)),
          where('group', '==', 'alpha'),
        ),
      ),
      orPlusOrSameCall: observeFirestoreCall(() =>
        queryUntyped(coll, or(where('score', '==', 10)), or(where('score', '==', 40))),
      ),
      andWrappingWhereAndOr: observeFirestoreCall(() =>
        query(
          coll,
          and(
            where('group', '==', 'alpha'),
            or(where('score', '==', 10), where('score', '==', 40)),
          ),
        ),
      ),
      chainedWhereThenOr: observeFirestoreCall(() =>
        query(
          query(coll, where('group', '==', 'alpha')),
          or(where('score', '==', 10), where('score', '==', 40)),
        ),
      ),
    };
  } finally {
    await deleteApp(app);
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  matrixRow: 'firestore#62',
  rowIds: ['firestore#62'],
  description:
    'or(...) composite filter combined with orderBy(...), limit(...), nested and(...), chained query(...), and top-level multi-filter validation in query(coll, ...).',
  async observe() {
    const clientTopLevelMixing = await probeClientTopLevelCompositeFilterMixing();
    const live = await withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { and, collection, doc, getDocs, limit, or, orderBy, query, setDoc, where } =
        firestoreSdk;
      const items = collection(db, collectionPath('composite-or-orderby-limit'));
      await setDoc(doc(items, 'd1'), { score: 10, group: 'alpha' });
      await setDoc(doc(items, 'd2'), { score: 20, group: 'beta' });
      await setDoc(doc(items, 'd3'), { score: 30, group: 'alpha' });
      await setDoc(doc(items, 'd4'), { score: 40, group: 'alpha' });

      return {
        orWithOrderByDescLimitTwo: await observeFirestoreIdQuery(() =>
          getDocs(
            query(
              items,
              or(where('score', '==', 10), where('score', '==', 30), where('score', '==', 40)),
              orderBy('score', 'desc'),
              limit(2),
            ),
          ),
        ),
        andWrappingWhereAndOr: await observeFirestoreIdQuery(() =>
          getDocs(
            query(
              items,
              and(
                where('group', '==', 'alpha'),
                or(where('score', '==', 10), where('score', '==', 40)),
              ),
            ),
          ),
        ),
        chainedWhereThenOr: await observeFirestoreIdQuery(() =>
          getDocs(
            query(
              query(items, where('group', '==', 'alpha')),
              or(where('score', '==', 10), where('score', '==', 40)),
            ),
          ),
        ),
      };
    });
    return {
      clientTopLevelMixing,
      live,
    };
  },
};
