import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseFirestore (firebase-ios-sdk) single-field inequality and set filters (isNotEqualTo, isLessThan, isLessThanOrEqualTo, isGreaterThan, isGreaterThanOrEqualTo, arrayContainsAny, notIn), value and DocumentSnapshot cursor pagination (start/end at/after/before), scoped collectionGroup query, WriteBatch and Transaction merge/mergeFields/deleteDocument, and TransactionOptions.maxAttempts contention retry and exhaustion on iOS Simulator.',
  matrixRow: 'firestore-swift#9',
  rowIds: [
    'firestore-swift#9',
    'firestore-swift#11',
    'firestore-swift#12',
    'firestore-swift#42',
    'firestore-swift#43',
    'firestore-swift#44',
    'firestore-swift#45',
    'firestore-swift#46',
    'firestore-swift#48',
    'firestore-swift#50',
    'firestore-swift#56',
    'firestore-swift#57',
    'firestore-swift#58',
    'firestore-swift#59',
    'firestore-swift#80',
    'firestore-swift#81',
    'firestore-swift#86',
    'firestore-swift#87',
    'firestore-swift#88',
    'firestore-swift#90',
    'firestore-swift#91',
  ],
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
