import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseFirestore (firebase-ios-sdk) addDocument auto-ID, setData, setData(merge:), setData(mergeFields:), updateData with FieldValue sentinels (serverTimestamp, increment, arrayUnion, arrayRemove, delete), Timestamp/GeoPoint/Data/DocumentReference codecs, and delete on iOS Simulator.',
  matrixRow: 'firestore-swift#26',
  rowIds: [
    'firestore-swift#26',
    'firestore-swift#27',
    'firestore-swift#28',
    'firestore-swift#29',
    'firestore-swift#30',
    'firestore-swift#31',
    'firestore-swift#40',
    'firestore-swift#64',
    'firestore-swift#67',
    'firestore-swift#68',
    'firestore-swift#73',
    'firestore-swift#92',
    'firestore-swift#93',
    'firestore-swift#94',
    'firestore-swift#95',
    'firestore-swift#96',
    'firestore-swift#98',
    'firestore-swift#99',
    'firestore-swift#100',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'firestore-swift-crud-merge-sentinels-and-codecs',
      mode: 'ios-sim-firestore',
    });
  },
};
