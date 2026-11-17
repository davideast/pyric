import type { Probe } from '../../rigs/types.ts';
import {
  observeFirestoreCall,
  type FirestoreSyncCallOutcome,
} from '../../src/firestore-probe-outcomes.ts';

export async function probeClientNonFilterCompositeRejection(): Promise<{
  orWithOrderBy: FirestoreSyncCallOutcome;
  orWithLimit: FirestoreSyncCallOutcome;
  orWithLimitToLast: FirestoreSyncCallOutcome;
  andWithOrderBy: FirestoreSyncCallOutcome;
  andWithLimit: FirestoreSyncCallOutcome;
  andWithStartAt: FirestoreSyncCallOutcome;
}> {
  const { and, limit, limitToLast, or, orderBy, startAt } = await import('firebase/firestore');
  const orUntyped = or as (...args: unknown[]) => unknown;
  const andUntyped = and as (...args: unknown[]) => unknown;
  return {
    orWithOrderBy: observeFirestoreCall(() => orUntyped(orderBy('score'))),
    orWithLimit: observeFirestoreCall(() => orUntyped(limit(1))),
    orWithLimitToLast: observeFirestoreCall(() => orUntyped(limitToLast(1))),
    andWithOrderBy: observeFirestoreCall(() => andUntyped(orderBy('score'))),
    andWithLimit: observeFirestoreCall(() => andUntyped(limit(1))),
    andWithStartAt: observeFirestoreCall(() => andUntyped(startAt(1))),
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Passing non-filter constraints (orderBy, limit, limitToLast, startAt) into or() or and() throws FirebaseError invalid-argument vs TypeError.',
  async observe() {
    return probeClientNonFilterCompositeRejection();
  },
};
