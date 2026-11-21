import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseFirestore (firebase-ios-sdk) WriteBatch atomic commit, runTransaction commit and NSErrorPointer rollback, updateData notFound rejection, disableNetwork/Source.cache/enableNetwork/waitForPendingWrites offline mutation flush, unscoped Security Rules permissionDenied rejection, and terminate/clearPersistence lifecycle on iOS Simulator.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'firestore-swift-batches-transactions-offline-and-errors',
      mode: 'ios-sim-firestore',
    });
  },
};
