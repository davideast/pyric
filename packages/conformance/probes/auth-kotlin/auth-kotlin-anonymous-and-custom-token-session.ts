import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseAuth anonymous sign-in, custom-token claims exchange, invalid custom-token error code, and signOut transitions under Robolectric.',
  matrixRow: 'auth-kotlin#8',
  rowIds: [
    'auth-kotlin#8',
    'auth-kotlin#9',
    'auth-kotlin#10',
    'auth-kotlin#20',
    'auth-kotlin#22',
    'auth-kotlin#23',
    'auth-kotlin#24',
    'auth-kotlin#26',
    'auth-kotlin#31',
    'auth-kotlin#32',
  ],
  rig: 'android-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'auth-kotlin-anonymous-and-custom-token-session',
      needsDedicatedRtdb: false,
    });
  },
};
