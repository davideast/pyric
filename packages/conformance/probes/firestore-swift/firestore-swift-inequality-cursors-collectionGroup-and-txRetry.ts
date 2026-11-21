import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseFirestore (firebase-ios-sdk) single-field inequality and set filters (isNotEqualTo, isLessThan, isLessThanOrEqualTo, isGreaterThan, isGreaterThanOrEqualTo, arrayContainsAny, notIn), value and DocumentSnapshot cursor pagination (start/end at/after/before), scoped collectionGroup query, WriteBatch and Transaction merge/mergeFields/deleteDocument, and TransactionOptions.maxAttempts contention retry and exhaustion on iOS Simulator.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'firestore-swift-inequality-cursors-collectionGroup-and-txRetry',
      mode: 'ios-sim-firestore',
      needsCollectionGroupRule: true,
    });
  },
};
