import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseDatabase (firebase-ios-sdk) dedicated-instance setValue, updateChildValues with ServerValue.increment, queryOrdered(byChild:) + queryLimited(toFirst:) ordering, and removeValue via headless macOS SwiftPM CLI.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'rtdb-swift-dedicated-crud-and-query-order',
      mode: 'macos-rtdb-cli',
    });
  },
};
