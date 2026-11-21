import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseAuthException subclass and errorCode outcomes for invalid email, weak password, duplicate email registration, wrong password, and missing user sign-in under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'android-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'auth-kotlin-error-codes-and-exceptions',
      needsDedicatedRtdb: false,
      needsCustomToken: false,
    });
  },
};
