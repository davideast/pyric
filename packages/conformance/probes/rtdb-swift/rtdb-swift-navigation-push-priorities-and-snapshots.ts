import type { Probe } from '../../rigs/types.ts';
import {
  buildIosRtdbNavigationAndChildQueryRules,
  runIosOracleProbe,
} from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseDatabase (firebase-ios-sdk) default, URL, and named Database instances, DatabaseReference root/parent/key/url/reference(fromURL:) navigation, monotonic 20-char childByAutoId() keys, DataSnapshot value/priority/valueInExportFormat()/NSNull runtime shapes, setPriority, setValue(_:andPriority:), setValue(nil) deletion, and queryOrdered(byChild:) 1-arg/2-arg queryEqual, inclusive/exclusive ranges, and limits via headless macOS SwiftPM CLI.',
  matrixRow: 'rtdb-swift#ref-push',
  rowIds: [
    'rtdb-swift#instance-default',
    'rtdb-swift#instance-url',
    'rtdb-swift#ref-root',
    'rtdb-swift#ref-child',
    'rtdb-swift#ref-parent',
    'rtdb-swift#ref-root-prop',
    'rtdb-swift#ref-key',
    'rtdb-swift#ref-push',
    'rtdb-swift#ref-push-key-ordering',
    'rtdb-swift#write-set-null',
    'rtdb-swift#write-set-priority',
    'rtdb-swift#write-set-with-priority',
    'rtdb-swift#sentinel-timestamp',
    'rtdb-swift#snap-exists',
    'rtdb-swift#snap-children',
    'rtdb-swift#snap-child-path',
    'rtdb-swift#query-order-by-child',
    'rtdb-swift#query-equal-to',
    'rtdb-swift#query-range',
    'rtdb-swift#query-limit',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'rtdb-swift-navigation-push-priorities-and-snapshots',
      mode: 'macos-rtdb-cli',
      rtdbRunRules: buildIosRtdbNavigationAndChildQueryRules(),
    });
  },
};
