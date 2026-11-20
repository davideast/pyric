import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseAuth (firebase-ios-sdk) anonymous sign-in, custom-token claims exchange, invalid custom-token AuthErrorCode/FIRAuthErrorDomain rejection, and signOut session clearing on iOS Simulator.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'auth-swift-anonymous-and-custom-token-session',
      mode: 'ios-sim-auth',
    });
  },
};
