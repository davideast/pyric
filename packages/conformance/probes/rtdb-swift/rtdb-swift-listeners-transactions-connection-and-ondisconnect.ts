import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseDatabase (firebase-ios-sdk) .info/connected, .info/serverTimeOffset, and unknown .info key observations across goOffline()/goOnline(), observe(.value), observeSingleEvent(of:), and observe(.childAdded/.childChanged/.childMoved/.childRemoved) with previousSiblingKey plus removeObserver(withHandle:) silence, runTransactionBlock commit and abort, and two-app onDisconnectSetValue/onDisconnectUpdateChildValues/onDisconnectRemoveValue/cancelDisconnectOperations via headless macOS SwiftPM CLI.',
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'rtdb-swift-listeners-transactions-connection-and-ondisconnect',
      mode: 'macos-rtdb-cli',
    });
  },
};
