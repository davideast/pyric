import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseFirestore single-field queries (whereEqualTo, Filter.and range, Filter.or disjunction, whereIn, whereArrayContains, whereArrayContainsAny), orderBy + limit/limitToLast, value/DocumentSnapshot/documentId cursors, count/sum/average aggregations, and addSnapshotListener DocumentChange lifecycle under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'android-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-queries-cursors-listeners-and-aggregations',
      needsFirestore: true,
    });
  },
};
