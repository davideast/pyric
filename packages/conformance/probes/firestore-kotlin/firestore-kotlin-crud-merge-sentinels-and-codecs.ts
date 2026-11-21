import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseFirestore document CRUD (collection.add, set, SetOptions.merge, SetOptions.mergeFields, update, delete), FieldValue sentinels (serverTimestamp, increment, arrayUnion, arrayRemove, delete), Source.SERVER/CACHE reads, and Timestamp/GeoPoint/Blob/DocumentReference codecs under Robolectric.',
  matrixRow: 'firestore-kotlin#15',
  rowIds: [
    'firestore-kotlin#5',
    'firestore-kotlin#14',
    'firestore-kotlin#15',
    'firestore-kotlin#16',
    'firestore-kotlin#18',
    'firestore-kotlin#19',
    'firestore-kotlin#37',
    'firestore-kotlin#38',
    'firestore-kotlin#39',
    'firestore-kotlin#40',
    'firestore-kotlin#41',
    'firestore-kotlin#43',
    'firestore-kotlin#54',
    'firestore-kotlin#55',
    'firestore-kotlin#56',
    'firestore-kotlin#57',
    'firestore-kotlin#58',
    'firestore-kotlin#59',
    'firestore-kotlin#60',
    'firestore-kotlin#61',
    'firestore-kotlin#62',
    'firestore-kotlin#63',
  ],
  rig: 'android-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-crud-merge-sentinels-and-codecs',
      needsFirestore: true,
    });
  },
};
