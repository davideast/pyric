import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseAuth UserProfileChangeRequest updateProfile, reload, cached vs forced getIdToken refresh, and AuthStateListener vs IdTokenListener transition counts under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
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
