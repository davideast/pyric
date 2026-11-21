import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseDatabase dedicated-instance setValue, updateChildren with ServerValue.increment, orderByChild + limitToFirst ordering, and removeValue under Robolectric.',
  matrixRow: 'rtdb-kotlin#write-set',
  rowIds: [
    'rtdb-kotlin#instance-url',
    'rtdb-kotlin#ref-path',
    'rtdb-kotlin#ref-child',
    'rtdb-kotlin#write-set',
    'rtdb-kotlin#write-update',
    'rtdb-kotlin#write-remove',
    'rtdb-kotlin#sentinel-increment',
    'rtdb-kotlin#read-get',
    'rtdb-kotlin#snap-exists',
    'rtdb-kotlin#snap-key',
    'rtdb-kotlin#snap-value',
    'rtdb-kotlin#snap-children',
    'rtdb-kotlin#snap-child-path',
    'rtdb-kotlin#query-order-by-child',
  ],
  rig: 'android-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'rtdb-kotlin-dedicated-crud-and-query-order',
      needsDedicatedRtdb: true,
    });
  },
};
