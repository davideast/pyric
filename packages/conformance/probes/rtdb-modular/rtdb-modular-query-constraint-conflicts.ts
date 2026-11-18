import type { DatabaseReference, Query } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';

export interface ConstraintConflictProbeSdk {
  query: typeof import('firebase/database').query;
  orderByChild: typeof import('firebase/database').orderByChild;
  orderByKey: typeof import('firebase/database').orderByKey;
  orderByValue: typeof import('firebase/database').orderByValue;
  orderByPriority: typeof import('firebase/database').orderByPriority;
  startAt: typeof import('firebase/database').startAt;
  startAfter: typeof import('firebase/database').startAfter;
  endAt: typeof import('firebase/database').endAt;
  endBefore: typeof import('firebase/database').endBefore;
  equalTo: typeof import('firebase/database').equalTo;
  limitToFirst: typeof import('firebase/database').limitToFirst;
  limitToLast: typeof import('firebase/database').limitToLast;
}

export interface ConstraintConflictOutcome {
  threw: boolean;
  errorMessage: string | null;
}

function runConstraintCheck(build: () => Query): ConstraintConflictOutcome {
  try {
    build();
    return { threw: false, errorMessage: null };
  } catch (err) {
    let errorMessage = String(err);
    if (err instanceof Error) {
      errorMessage = err.message;
    }
    return { threw: true, errorMessage };
  }
}

export function observeQueryConstraintConflicts(
  sdk: ConstraintConflictProbeSdk,
  baseRef: DatabaseReference,
): {
  orderByChildThenOrderByKey: ConstraintConflictOutcome;
  orderByKeyThenOrderByValue: ConstraintConflictOutcome;
  orderByValueThenOrderByPriority: ConstraintConflictOutcome;
  limitFirstThenLimitLast: ConstraintConflictOutcome;
  limitFirstThenLimitFirst: ConstraintConflictOutcome;
  startAtThenStartAfter: ConstraintConflictOutcome;
  startAtThenEqualTo: ConstraintConflictOutcome;
  startAtThenStartAt: ConstraintConflictOutcome;
  endAtThenEndBefore: ConstraintConflictOutcome;
  equalToThenEndAt: ConstraintConflictOutcome;
  endAtThenEndAt: ConstraintConflictOutcome;
  chainedDuplicateOrderBy: ConstraintConflictOutcome;
  chainedDuplicateLimit: ConstraintConflictOutcome;
  validRangeAndLimitControl: ConstraintConflictOutcome;
  validChainedRangeAndLimitControl: ConstraintConflictOutcome;
} {
  const {
    query,
    orderByChild,
    orderByKey,
    orderByValue,
    orderByPriority,
    startAt,
    startAfter,
    endAt,
    endBefore,
    equalTo,
    limitToFirst,
    limitToLast,
  } = sdk;

  return {
    orderByChildThenOrderByKey: runConstraintCheck(() =>
      query(baseRef, orderByChild('a'), orderByKey()),
    ),
    orderByKeyThenOrderByValue: runConstraintCheck(() =>
      query(baseRef, orderByKey(), orderByValue()),
    ),
    orderByValueThenOrderByPriority: runConstraintCheck(() =>
      query(baseRef, orderByValue(), orderByPriority()),
    ),
    limitFirstThenLimitLast: runConstraintCheck(() =>
      query(baseRef, limitToFirst(2), limitToLast(3)),
    ),
    limitFirstThenLimitFirst: runConstraintCheck(() =>
      query(baseRef, limitToFirst(2), limitToFirst(4)),
    ),
    startAtThenStartAfter: runConstraintCheck(() =>
      query(baseRef, orderByChild('a'), startAt(1), startAfter(2)),
    ),
    startAtThenEqualTo: runConstraintCheck(() =>
      query(baseRef, orderByChild('a'), startAt(1), equalTo(2)),
    ),
    startAtThenStartAt: runConstraintCheck(() =>
      query(baseRef, orderByChild('a'), startAt(1), startAt(2)),
    ),
    endAtThenEndBefore: runConstraintCheck(() =>
      query(baseRef, orderByChild('a'), endAt(5), endBefore(4)),
    ),
    equalToThenEndAt: runConstraintCheck(() =>
      query(baseRef, orderByChild('a'), equalTo(2), endAt(5)),
    ),
    endAtThenEndAt: runConstraintCheck(() =>
      query(baseRef, orderByChild('a'), endAt(5), endAt(6)),
    ),
    chainedDuplicateOrderBy: runConstraintCheck(() =>
      query(query(baseRef, orderByKey()), orderByChild('a')),
    ),
    chainedDuplicateLimit: runConstraintCheck(() =>
      query(query(baseRef, limitToFirst(1)), limitToLast(2)),
    ),
    validRangeAndLimitControl: runConstraintCheck(() =>
      query(baseRef, orderByChild('a'), startAt(1), endAt(5), limitToFirst(3)),
    ),
    validChainedRangeAndLimitControl: runConstraintCheck(() =>
      query(query(baseRef, orderByChild('a'), startAt(1)), endAt(5), limitToLast(2)),
    ),
  };
}

export async function probeQueryConstraintConflicts(): Promise<
  ReturnType<typeof observeQueryConstraintConflicts>
> {
  const [{ deleteApp, initializeApp }, rtdbSdk] = await Promise.all([
    import('firebase/app'),
    import('firebase/database'),
  ]);

  const app = initializeApp(
    {
      projectId: 'validation-only',
      databaseURL: 'https://validation-only-2.firebaseio.com',
    },
    `query-conflict-check-${Date.now()}`,
  );
  const db = rtdbSdk.getDatabase(app);
  rtdbSdk.goOffline(db);

  try {
    return observeQueryConstraintConflicts(rtdbSdk, rtdbSdk.ref(db, 'items'));
  } finally {
    await deleteApp(app);
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'RTDB modular synchronous query() constraint-conflict validation across duplicate orderBy*, duplicate limits, duplicate start/end bounds, equalTo() combinations, and chained query() calls.',
  async observe() {
    return probeQueryConstraintConflicts();
  },
};
