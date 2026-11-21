import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseAuth (firebase-ios-sdk) createProfileChangeRequest (displayName and photoURL), reload(), getIDTokenResult(forcingRefresh: true) claims shape, and User.delete() session invalidation on iOS Simulator.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
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
