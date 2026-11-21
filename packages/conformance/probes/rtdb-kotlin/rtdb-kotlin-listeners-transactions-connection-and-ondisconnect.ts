import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseDatabase .info/connected and .info/serverTimeOffset listeners across goOffline/goOnline, ValueEventListener and ChildEventListener add/change/move/remove delivery plus removeEventListener silence, runTransaction commit and abort, and two-app OnDisconnect setValue/removeValue/cancel under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'android-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'rtdb-kotlin-listeners-transactions-connection-and-ondisconnect',
      needsDedicatedRtdb: true,
    });
  },
};
