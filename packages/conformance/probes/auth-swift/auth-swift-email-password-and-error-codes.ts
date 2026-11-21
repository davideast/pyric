import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseAuth (firebase-ios-sdk) createUser(withEmail:password:), signIn(withEmail:password:), and duplicate-email, wrong-password, invalid-email, and user-not-found AuthErrorCode/FIRAuthErrorDomain shapes on iOS Simulator.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
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
