import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseDatabase default/named getInstance and Firebase.database parity, DatabaseReference root/parent/key/path navigation, monotonic 20-char push() keys, ServerValue.TIMESTAMP, setPriority, setValue(value, priority), setValue(null) deletion, and DataSnapshot value/priority runtime classes under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'android-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'rtdb-kotlin-navigation-push-priorities-and-snapshots',
      needsDedicatedRtdb: true,
    });
  },
};
