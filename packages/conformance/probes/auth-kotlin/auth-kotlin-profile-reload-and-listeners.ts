import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseAuth UserProfileChangeRequest updateProfile, reload, cached vs forced getIdToken refresh, and AuthStateListener vs IdTokenListener transition counts under Robolectric.',
  matrixRow: 'auth-kotlin#27',
  rowIds: [
    'auth-kotlin#2',
    'auth-kotlin#13',
    'auth-kotlin#14',
    'auth-kotlin#17',
    'auth-kotlin#18',
    'auth-kotlin#25',
    'auth-kotlin#27',
    'auth-kotlin#28',
    'auth-kotlin#29',
  ],
  rig: 'android-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'auth-kotlin-profile-reload-and-listeners',
      needsDedicatedRtdb: false,
      needsCustomToken: false,
    });
  },
};
