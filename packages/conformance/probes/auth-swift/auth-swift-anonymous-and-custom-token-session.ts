import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseAuth (firebase-ios-sdk) anonymous sign-in, custom-token claims exchange, invalid custom-token AuthErrorCode/FIRAuthErrorDomain rejection, and signOut session clearing on iOS Simulator.',
  matrixRow: 'auth-swift#10',
  rowIds: [
    'auth-swift#2',
    'auth-swift#10',
    'auth-swift#12',
    'auth-swift#14',
    'auth-swift#25',
    'auth-swift#30',
    'auth-swift#35',
    'auth-swift#38',
    'auth-swift#42',
    'auth-swift#45',
    'auth-swift#53',
    'auth-swift#54',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'auth-swift-anonymous-and-custom-token-session',
      mode: 'ios-sim-auth',
    });
  },
};
