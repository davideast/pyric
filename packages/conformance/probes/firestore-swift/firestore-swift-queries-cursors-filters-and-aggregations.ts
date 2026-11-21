import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseFirestore (firebase-ios-sdk) single-field equality/range/in/arrayContains predicates, Filter.orFilter, order(by:descending:), limit(to:) / limit(toLast:), value and DocumentSnapshot cursors, addSnapshotListener diffs + remove(), and server-side count/sum/average aggregations on iOS Simulator.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'firestore-swift-queries-cursors-filters-and-aggregations',
      mode: 'ios-sim-firestore',
    });
  },
};
