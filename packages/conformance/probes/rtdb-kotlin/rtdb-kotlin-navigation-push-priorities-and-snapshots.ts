import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseDatabase default/named getInstance and Firebase.database parity, DatabaseReference root/parent/key/path navigation, monotonic 20-char push() keys, ServerValue.TIMESTAMP, setPriority, setValue(value, priority), setValue(null) deletion, and DataSnapshot value/priority runtime classes under Robolectric.',
  matrixRow: 'rtdb-kotlin#ref-push',
  rowIds: [
    'rtdb-kotlin#instance-default',
    'rtdb-kotlin#ref-root',
    'rtdb-kotlin#ref-parent',
    'rtdb-kotlin#ref-root-prop',
    'rtdb-kotlin#ref-key',
    'rtdb-kotlin#ref-push',
    'rtdb-kotlin#ref-push-key-ordering',
    'rtdb-kotlin#write-set-null',
    'rtdb-kotlin#write-set-priority',
    'rtdb-kotlin#write-set-with-priority',
    'rtdb-kotlin#sentinel-timestamp',
  ],
  rig: 'android-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'rtdb-kotlin-navigation-push-priorities-and-snapshots',
      needsDedicatedRtdb: true,
    });
  },
};
