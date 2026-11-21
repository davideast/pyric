import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseDatabase (firebase-ios-sdk) dedicated-instance setValue, updateChildValues with ServerValue.increment, queryOrdered(byChild:) + queryLimited(toFirst:) ordering, and removeValue via headless macOS SwiftPM CLI.',
  matrixRow: 'rtdb-swift#write-set',
  rowIds: [
    'rtdb-swift#instance-url',
    'rtdb-swift#ref-path',
    'rtdb-swift#ref-child',
    'rtdb-swift#write-set',
    'rtdb-swift#write-update',
    'rtdb-swift#write-remove',
    'rtdb-swift#sentinel-increment',
    'rtdb-swift#read-get',
    'rtdb-swift#snap-exists',
    'rtdb-swift#snap-key',
    'rtdb-swift#snap-children',
    'rtdb-swift#query-order-by-child',
    'rtdb-swift#query-limit',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'rtdb-swift-dedicated-crud-and-query-order',
      mode: 'macos-rtdb-cli',
    });
  },
};
