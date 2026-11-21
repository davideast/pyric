import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseFirestore (firebase-ios-sdk) addDocument auto-ID, setData, setData(merge:), setData(mergeFields:), updateData with FieldValue sentinels (serverTimestamp, increment, arrayUnion, arrayRemove, delete), Timestamp/GeoPoint/Data/DocumentReference codecs, and delete on iOS Simulator.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'firestore-swift-crud-merge-sentinels-and-codecs',
      mode: 'ios-sim-firestore',
    });
  },
};
