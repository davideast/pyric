import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseFirestore single-field inequality and negative-membership filters (whereNotEqualTo, whereLessThan, whereLessThanOrEqualTo, whereGreaterThan, whereGreaterThanOrEqualTo, whereNotIn), value and DocumentSnapshot pagination cursors (startAt, startAfter, endAt, endBefore), scoped collectionGroup(id), Transaction.delete, and TransactionOptions contention retry / maxAttempts exhaustion under Robolectric.',
  matrixRow: 'firestore-kotlin#8',
  rowIds: [
    'firestore-kotlin#6',
    'firestore-kotlin#8',
    'firestore-kotlin#22',
    'firestore-kotlin#23',
    'firestore-kotlin#27',
    'firestore-kotlin#32',
    'firestore-kotlin#34',
    'firestore-kotlin#52',
    'firestore-kotlin#53',
  ],
  rig: 'android-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-inequality-cursors-collectionGroup-and-txRetry',
      needsFirestore: true,
      needsFirestoreCollectionGroup: true,
    });
  },
};
