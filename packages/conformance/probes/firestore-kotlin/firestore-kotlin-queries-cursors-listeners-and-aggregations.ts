import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseFirestore single-field queries (whereEqualTo, Filter.and range, Filter.or disjunction, whereIn, whereArrayContains, whereArrayContainsAny), orderBy + limit/limitToLast, value/DocumentSnapshot/documentId cursors, count/sum/average aggregations, and addSnapshotListener DocumentChange lifecycle under Robolectric.',
  matrixRow: 'firestore-kotlin#21',
  rowIds: [
    'firestore-kotlin#5',
    'firestore-kotlin#7',
    'firestore-kotlin#18',
    'firestore-kotlin#19',
    'firestore-kotlin#21',
    'firestore-kotlin#24',
    'firestore-kotlin#25',
    'firestore-kotlin#26',
    'firestore-kotlin#28',
    'firestore-kotlin#29',
    'firestore-kotlin#30',
    'firestore-kotlin#31',
    'firestore-kotlin#33',
    'firestore-kotlin#35',
    'firestore-kotlin#44',
    'firestore-kotlin#64',
  ],
  rig: 'android-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-queries-cursors-listeners-and-aggregations',
      needsFirestore: true,
    });
  },
};
