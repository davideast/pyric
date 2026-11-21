import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseFirestore single-field inequality and negative-membership filters (whereNotEqualTo, whereLessThan, whereLessThanOrEqualTo, whereGreaterThan, whereGreaterThanOrEqualTo, whereNotIn), value and DocumentSnapshot pagination cursors (startAt, startAfter, endAt, endBefore), scoped collectionGroup(id), Transaction.delete, and TransactionOptions contention retry / maxAttempts exhaustion under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
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
