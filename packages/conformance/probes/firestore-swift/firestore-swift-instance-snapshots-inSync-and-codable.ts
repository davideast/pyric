import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseFirestore (firebase-ios-sdk) default and named Firestore.firestore() instances, FirestoreSettings, document and collection reference navigation, loadBundle and getQuery(named:), addSnapshotsInSyncListener, SnapshotListenOptions document and query listeners plus AsyncSequence snapshots, FieldValue.vector, updateData NOT_FOUND rejection, and @DocumentID / @ServerTimestamp Codable setData(from:) and data(as:) round-trips on iOS Simulator.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'firestore-swift-instance-snapshots-inSync-and-codable',
      mode: 'ios-sim-firestore',
    });
  },
};
