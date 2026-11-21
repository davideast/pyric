import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseDatabase (firebase-ios-sdk) updateChildValues partial merge, removeValue child deletion, childByAutoId monotonic 20-char push keys, ServerValue.increment and ServerValue.timestamp, and runTransactionBlock commit and abort via headless macOS SwiftPM CLI.',
  matrixRow: 'rtdb-swift#write-update',
  rowIds: [
    'rtdb-swift#ref-push',
    'rtdb-swift#ref-push-key-ordering',
    'rtdb-swift#write-update',
    'rtdb-swift#write-remove',
    'rtdb-swift#sentinel-timestamp',
    'rtdb-swift#sentinel-increment',
    'rtdb-swift#snap-child-path',
    'rtdb-swift#tx-run',
    'rtdb-swift#tx-abort',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'rtdb-swift-writes-autoid-servervalue-and-transactions',
      mode: 'macos-rtdb-cli',
    });
  },
};
