import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseAuth (firebase-ios-sdk) default and named Auth.auth() instances, app/tenantID/languageCode/useAppLanguage properties, state and ID-token listeners plus AsyncSequence streams, anonymous link(with:) email upgrade, providerData UserInfo fields, link collision AuthErrorCode, reauthenticate(with:), updatePassword(to:), signIn(with:), unlink(fromProvider:), and Google/OAuth credential signIn(with:) rejection on iOS Simulator.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'auth-swift-instance-linking-reauth-and-oauth-credentials',
      mode: 'ios-sim-auth',
      needsCustomToken: false,
    });
  },
};
