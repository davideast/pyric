import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseAuth (firebase-ios-sdk) createProfileChangeRequest (displayName and photoURL), reload(), getIDTokenResult(forcingRefresh: true) claims shape, and User.delete() session invalidation on iOS Simulator.',
  matrixRow: 'auth-swift#40',
  rowIds: [
    'auth-swift#2',
    'auth-swift#6',
    'auth-swift#8',
    'auth-swift#14',
    'auth-swift#25',
    'auth-swift#27',
    'auth-swift#28',
    'auth-swift#35',
    'auth-swift#38',
    'auth-swift#40',
    'auth-swift#41',
    'auth-swift#42',
    'auth-swift#44',
    'auth-swift#45',
    'auth-swift#46',
    'auth-swift#53',
    'auth-swift#54',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'auth-swift-profile-token-claims-and-delete-lifecycle',
      mode: 'ios-sim-auth',
      needsCustomToken: false,
    });
  },
};
