import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseAuth default/named getInstance and Firebase.auth parity, app/tenantId/languageCode/useAppLanguage properties, anonymous linkWithCredential email upgrade, providerData UserInfo fields, FirebaseAuthUserCollisionException, reauthenticate, updatePassword, unlink, and Google/OAuth credential signInWithCredential behavior under Robolectric.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'android-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'auth-kotlin-instance-linking-reauth-and-oauth-credentials',
      needsCustomToken: false,
    });
  },
};
