import type { Probe } from '../../rigs/types.ts';
import { runAndroidRobolectricProbe } from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseAuth default/named getInstance and Firebase.auth parity, app/tenantId/languageCode/useAppLanguage properties, anonymous linkWithCredential email upgrade, providerData UserInfo fields, FirebaseAuthUserCollisionException, reauthenticate, updatePassword, unlink, and Google/OAuth credential signInWithCredential behavior under Robolectric.',
  matrixRow: 'auth-kotlin#1',
  rowIds: [
    'auth-kotlin#1',
    'auth-kotlin#2',
    'auth-kotlin#3',
    'auth-kotlin#4',
    'auth-kotlin#19',
    'auth-kotlin#23',
    'auth-kotlin#32',
  ],
  rig: 'android-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'auth-kotlin-instance-linking-reauth-and-oauth-credentials',
      needsCustomToken: false,
    });
  },
};
