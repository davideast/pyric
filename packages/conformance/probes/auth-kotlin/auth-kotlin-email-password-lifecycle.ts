import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseAuth email/password account creation, sign-out/sign-in, EmailAuthProvider credential sign-in, AdditionalUserInfo.isNewUser, and user.delete() lifecycle under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'android-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'auth-kotlin-email-password-lifecycle',
      needsDedicatedRtdb: false,
      needsCustomToken: false,
    });
  },
};
