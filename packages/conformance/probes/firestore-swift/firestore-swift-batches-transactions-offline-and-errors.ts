import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseFirestore (firebase-ios-sdk) WriteBatch atomic commit, runTransaction commit and NSErrorPointer rollback, updateData notFound rejection, disableNetwork/Source.cache/enableNetwork/waitForPendingWrites offline mutation flush, unscoped Security Rules permissionDenied rejection, and terminate/clearPersistence lifecycle on iOS Simulator.',
  matrixRow: 'firestore-swift#10',
  rowIds: [
    'firestore-swift#10',
    'firestore-swift#13',
    'firestore-swift#15',
    'firestore-swift#16',
    'firestore-swift#17',
    'firestore-swift#18',
    'firestore-swift#26',
    'firestore-swift#30',
    'firestore-swift#64',
    'firestore-swift#67',
    'firestore-swift#73',
    'firestore-swift#79',
    'firestore-swift#82',
    'firestore-swift#83',
    'firestore-swift#84',
    'firestore-swift#85',
    'firestore-swift#89',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'firestore-swift-batches-transactions-offline-and-errors',
      mode: 'ios-sim-firestore',
    });
  },
};
