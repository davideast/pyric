import type { Probe } from '../../rigs/types.ts';
import {
  buildIosRtdbPermissionAndQueryRules,
  runIosOracleProbe,
} from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseDatabase (firebase-ios-sdk) queryOrderedByKey and queryOrderedByValue with queryEqual(toValue:), queryStarting(atValue:), queryEnding(atValue:), and queryLimited(toLast:), plus permission-denied NSError domain and code on setValue, observeSingleEvent, and getData against run-scoped rules.',
  matrixRow: 'rtdb-swift#query-order-by-key',
  rowIds: [
    'rtdb-swift#write-set',
    'rtdb-swift#read-get',
    'rtdb-swift#listen-value',
    'rtdb-swift#query-order-by-key',
    'rtdb-swift#query-order-by-value',
    'rtdb-swift#query-equal-to',
    'rtdb-swift#query-range',
    'rtdb-swift#query-limit',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'rtdb-swift-queries-ranges-limits-and-permission-denied',
      mode: 'macos-rtdb-cli',
      rtdbRunRules: buildIosRtdbPermissionAndQueryRules(),
    });
  },
};
