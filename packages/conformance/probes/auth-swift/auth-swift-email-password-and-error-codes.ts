import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseAuth (firebase-ios-sdk) createUser(withEmail:password:), signIn(withEmail:password:), and duplicate-email, wrong-password, invalid-email, and user-not-found AuthErrorCode/FIRAuthErrorDomain shapes on iOS Simulator.',
  matrixRow: 'auth-swift#6',
  rowIds: [
    'auth-swift#2',
    'auth-swift#6',
    'auth-swift#8',
    'auth-swift#12',
    'auth-swift#14',
    'auth-swift#25',
    'auth-swift#26',
    'auth-swift#30',
    'auth-swift#31',
    'auth-swift#42',
    'auth-swift#53',
    'auth-swift#54',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'auth-swift-email-password-and-error-codes',
      mode: 'ios-sim-auth',
      needsCustomToken: false,
    });
  },
};
