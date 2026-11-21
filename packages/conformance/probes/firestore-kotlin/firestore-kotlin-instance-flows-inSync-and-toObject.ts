import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseFirestore default/KTX getInstance, FirebaseFirestoreSettings (persistent/memory cache, host/sslEnabled, post-start immutability), document(path), DocumentReference.update(map) + NOT_FOUND on missing doc, addSnapshotsInSyncListener, DocumentReference/Query snapshots(MetadataChanges) coroutine Flows, and DocumentSnapshot.toObject<T>() under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'android-sdk-probes',
  requires: ['web-config', 'firestore-rules', 'admin-auth', 'admin-firestore'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'firestore-kotlin-instance-flows-inSync-and-toObject',
      needsFirestore: true,
    });
  },
};
