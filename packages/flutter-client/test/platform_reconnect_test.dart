import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import 'auth/mock_bridge_helper.dart' show setupMockFirebase;
import 'helpers/fake_bridge.dart';

void main() {
  late FakeBridge bridge;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricFirestorePlatform firestore;

  setUp(() async {
    setupMockFirebase();
    bridge = FakeBridge();
    client = PyricBridgeClient(
      channelFactory: bridge.connect,
      reconnectDelay: (_) => Duration.zero,
    );
    auth = PyricFirebaseAuthPlatform(bridgeClient: client);
    firestore = PyricFirestorePlatform(
      bridgeClient: client,
      credentialsProvider: auth,
    );
    await client.connect();
  });

  tearDown(() async {
    await auth.dispose();
    await firestore.terminate();
    await client.disconnect();
  });

  Map<String, dynamic> lastSubForTarget(String target) => bridge
      .ofType('worker-sub')
      .lastWhere((frame) => (frame['sub'] as Map)['target'] == target);

  Map<String, dynamic> doc(String path, int n) =>
      {'path': path, 'exists': true, 'data': {'n': n}};

  test('a query listener with metadata changes reports the gap with fromCache, then the changes made during it', () async {
    final snapshots = <QuerySnapshotPlatform>[];
    final snapGate = CountGate();
    final sub = firestore
        .collection('rooms')
        .snapshots(includeMetadataChanges: true, listenSource: ListenSource.defaultSource)
        .listen((snap) {
      snapshots.add(snap);
      snapGate.tick();
    }, onError: (_) {});
    await bridge.waitForSubsFor('rooms', count: 1);
    final subId = bridge.lastSubFor('rooms')['subId'];
    bridge.current.deliver({
      'type': 'worker-snap',
      'subId': subId,
      'value': {'docs': [doc('rooms/a', 1)]},
    });
    await snapGate.atLeast(1);
    expect(snapshots[0].metadata.isFromCache, isFalse);

    bridge.current.drop();
    await snapGate.atLeast(2);
    final gap = snapshots[1];
    expect(gap.metadata.isFromCache, isTrue);
    expect(gap.metadata.hasPendingWrites, isFalse);
    expect(gap.docs.map((d) => d.id), ['a']);
    expect(gap.docChanges, isEmpty);

    await bridge.waitForSubsFor('rooms', count: 2);
    bridge.current.deliver({
      'type': 'worker-snap',
      'subId': subId,
      'value': {'docs': [doc('rooms/a', 1), doc('rooms/b', 1)]},
    });
    await snapGate.atLeast(3);
    final restored = snapshots[2];
    expect(restored.metadata.isFromCache, isFalse);
    expect(restored.docChanges.map((c) => (c.type, c.document.id)),
        [(DocumentChangeType.added, 'b')]);
    await sub.cancel();
  });

  test('a document listener without metadata changes sees no gap and no unchanged restored snapshot', () async {
    final snapshots = <DocumentSnapshotPlatform>[];
    final snapGate = CountGate();
    final sub = firestore
        .doc('rooms/a')
        .snapshots(listenSource: ListenSource.defaultSource)
        .listen((snap) {
      snapshots.add(snap);
      snapGate.tick();
    }, onError: (_) {});
    await bridge.waitForSubsFor('rooms/a', count: 1);
    final subId = bridge.lastSubFor('rooms/a')['subId'];
    bridge.current.deliver({'type': 'worker-snap', 'subId': subId, 'value': doc('rooms/a', 1)});
    await snapGate.atLeast(1);

    bridge.current.drop();
    await bridge.waitForSubsFor('rooms/a', count: 2);
    // Deliver unchanged snapshot followed by a changed sentinel snapshot on the
    // same ordered socket; seeing only 2 total snapshots proves the unchanged
    // restored snapshot and the drop gap were both suppressed.
    bridge.current.deliver({'type': 'worker-snap', 'subId': subId, 'value': doc('rooms/a', 1)});
    bridge.current.deliver({'type': 'worker-snap', 'subId': subId, 'value': doc('rooms/a', 2)});
    await snapGate.atLeast(2);
    expect(snapshots, hasLength(2));
    expect(snapshots[0].data(), {'n': 1});
    expect(snapshots[1].metadata.isFromCache, isFalse);
    expect(snapshots[1].data(), {'n': 2});
    await sub.cancel();
  });

  test('a replaced host restores the signed-in user before the Auth observers are re-sent', () async {
    await bridge.waitForSubTarget('authState', count: 1);
    await bridge.waitForSubTarget('idToken', count: 1);
    final authSubId = lastSubForTarget('authState')['subId'];
    final userGate = CountGate();
    final authSub = auth.authStateChanges().skip(1).listen((_) => userGate.tick());
    bridge.current.deliver({
      'type': 'worker-snap',
      'subId': authSubId,
      'value': {'uid': 'u1', 'tenantId': 'tenant-1'},
    });
    await userGate.atLeast(1);
    expect(auth.currentUser?.uid, 'u1');

    bridge.hostInstanceId = 'host-b';
    bridge.current.drop();
    final restore = (await bridge.waitForOpsNamed('auth.restorePortSession')).single;
    expect((restore['op'] as Map)['uid'], 'u1');
    expect((restore['op'] as Map)['tenantId'], 'tenant-1');
    final authSubsBeforeRestore = bridge.ofType('worker-sub')
        .where((f) => (f['sub'] as Map)['target'] == 'authState');
    expect(authSubsBeforeRestore, hasLength(1));

    bridge.current.deliver({'type': 'worker-res', 'id': restore['id'], 'ok': true, 'value': {'uid': 'u1'}});
    await bridge.waitForSubTarget('authState', count: 2);
    await authSub.cancel();
  });
}
