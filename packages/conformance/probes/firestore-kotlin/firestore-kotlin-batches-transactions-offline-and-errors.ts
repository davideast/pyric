import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseFirestore WriteBatch commit, runTransaction read-modify-write and abort rollback, disableNetwork/enableNetwork/waitForPendingWrites offline mutation replay, PERMISSION_DENIED FirebaseFirestoreException.Code mapping, and terminate/clearPersistence lifecycle under Robolectric.',
  matrixRow: 'firestore-kotlin#48',
  rowIds: [
    'firestore-kotlin#5',
    'firestore-kotlin#7',
    'firestore-kotlin#9',
    'firestore-kotlin#10',
    'firestore-kotlin#11',
    'firestore-kotlin#12',
    'firestore-kotlin#14',
    'firestore-kotlin#15',
    'firestore-kotlin#19',
    'firestore-kotlin#39',
    'firestore-kotlin#43',
    'firestore-kotlin#45',
    'firestore-kotlin#46',
    'firestore-kotlin#47',
    'firestore-kotlin#48',
    'firestore-kotlin#49',
    'firestore-kotlin#50',
    'firestore-kotlin#51',
  ],
  rig: 'android-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-batches-transactions-offline-and-errors',
      needsFirestore: true,
    });
  },
};
