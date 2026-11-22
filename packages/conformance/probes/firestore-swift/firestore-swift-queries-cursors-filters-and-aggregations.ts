import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseFirestore (firebase-ios-sdk) single-field equality/range/in/arrayContains predicates, Filter.orFilter, order(by:descending:), limit(to:) / limit(toLast:), value and DocumentSnapshot cursors, addSnapshotListener diffs + remove(), and server-side count/sum/average aggregations on iOS Simulator.',
  matrixRow: 'firestore-swift#41',
  rowIds: [
    'firestore-swift#41',
    'firestore-swift#44',
    'firestore-swift#45',
    'firestore-swift#47',
    'firestore-swift#49',
    'firestore-swift#51',
    'firestore-swift#53',
    'firestore-swift#54',
    'firestore-swift#55',
    'firestore-swift#56',
    'firestore-swift#57',
    'firestore-swift#58',
    'firestore-swift#60',
    'firestore-swift#62',
    'firestore-swift#72',
    'firestore-swift#74',
    'firestore-swift#75',
    'firestore-swift#78',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'firestore-swift-queries-cursors-filters-and-aggregations',
      mode: 'ios-sim-firestore',
    });
  },
};
