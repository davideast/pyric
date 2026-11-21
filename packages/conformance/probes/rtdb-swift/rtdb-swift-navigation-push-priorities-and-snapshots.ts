import type { Probe } from '../../rigs/types.ts';
import {
  buildIosRtdbNavigationAndChildQueryRules,
  runIosOracleProbe,
} from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseDatabase (firebase-ios-sdk) default, URL, and named Database instances, DatabaseReference root/parent/key/url/reference(fromURL:) navigation, monotonic 20-char childByAutoId() keys, DataSnapshot value/priority/valueInExportFormat()/NSNull runtime shapes, setPriority, setValue(_:andPriority:), setValue(nil) deletion, and queryOrdered(byChild:) 1-arg/2-arg queryEqual, inclusive/exclusive ranges, and limits via headless macOS SwiftPM CLI.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
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
