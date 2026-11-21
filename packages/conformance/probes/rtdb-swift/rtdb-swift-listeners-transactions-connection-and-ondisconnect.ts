import type { Probe } from '../../rigs/types.ts';
import { runIosOracleProbe } from '../../src/ios-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream FirebaseDatabase (firebase-ios-sdk) .info/connected, .info/serverTimeOffset, and unknown .info key observations across goOffline()/goOnline(), observe(.value), observeSingleEvent(of:), and observe(.childAdded/.childChanged/.childMoved/.childRemoved) with previousSiblingKey plus removeObserver(withHandle:) silence, runTransactionBlock commit and abort, and two-app onDisconnectSetValue/onDisconnectUpdateChildValues/onDisconnectRemoveValue/cancelDisconnectOperations via headless macOS SwiftPM CLI.',
  matrixRow: 'rtdb-swift#tx-run',
  rowIds: [
    'rtdb-swift#connection-toggle',
    'rtdb-swift#info-connected',
    'rtdb-swift#listen-value',
    'rtdb-swift#listen-child-added',
    'rtdb-swift#listen-child-changed',
    'rtdb-swift#listen-child-removed',
    'rtdb-swift#listen-cancel',
    'rtdb-swift#query-order-by-value',
    'rtdb-swift#tx-run',
    'rtdb-swift#tx-abort',
    'rtdb-swift#ondisconnect-set-remove',
    'rtdb-swift#ondisconnect-cancel',
  ],
  rig: 'ios-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  async observe(): Promise<Record<string, unknown>> {
    return runIosOracleProbe({
      probeId: 'rtdb-swift-listeners-transactions-connection-and-ondisconnect',
      mode: 'macos-rtdb-cli',
    });
  },
};
