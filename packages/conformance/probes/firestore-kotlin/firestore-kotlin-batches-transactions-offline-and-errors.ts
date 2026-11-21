import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseFirestore WriteBatch commit, runTransaction read-modify-write and abort rollback, disableNetwork/enableNetwork/waitForPendingWrites offline mutation replay, PERMISSION_DENIED FirebaseFirestoreException.Code mapping, and terminate/clearPersistence lifecycle under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'android-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-batches-transactions-offline-and-errors',
      needsFirestore: true,
    });
  },
};
