import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseFirestore document CRUD (collection.add, set, SetOptions.merge, SetOptions.mergeFields, update, delete), FieldValue sentinels (serverTimestamp, increment, arrayUnion, arrayRemove, delete), Source.SERVER/CACHE reads, and Timestamp/GeoPoint/Blob/DocumentReference codecs under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'android-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-crud-merge-sentinels-and-codecs',
      needsFirestore: true,
    });
  },
};
