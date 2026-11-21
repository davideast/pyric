import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseAuth (firebase-ios-sdk) default and named Auth.auth() instances, app/tenantID/languageCode/useAppLanguage properties, state and ID-token listeners plus AsyncSequence streams, anonymous link(with:) email upgrade, providerData UserInfo fields, link collision AuthErrorCode, reauthenticate(with:), updatePassword(to:), signIn(with:), unlink(fromProvider:), and Google/OAuth credential signIn(with:) rejection on iOS Simulator.',
  matrixRow: 'auth-swift#1',
  rowIds: [
    'auth-swift#1',
    'auth-swift#2',
    'auth-swift#4',
    'auth-swift#6',
    'auth-swift#8',
    'auth-swift#10',
    'auth-swift#12',
    'auth-swift#15',
    'auth-swift#16',
    'auth-swift#17',
    'auth-swift#18',
    'auth-swift#21',
    'auth-swift#22',
    'auth-swift#25',
    'auth-swift#26',
    'auth-swift#29',
    'auth-swift#30',
    'auth-swift#32',
    'auth-swift#33',
    'auth-swift#34',
    'auth-swift#36',
    'auth-swift#42',
    'auth-swift#43',
    'auth-swift#47',
    'auth-swift#53',
    'auth-swift#54',
    'auth-swift#55',
    'auth-swift#56',
    'auth-swift#57',
  ],
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
