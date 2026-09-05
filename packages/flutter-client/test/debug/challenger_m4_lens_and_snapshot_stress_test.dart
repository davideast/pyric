import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import '../auth/mock_bridge_helper.dart';

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricFirestorePlatform firestore;
  late PyricDebugController controller;

  setUp(() async {
    setupMockFirebase();
    harness = MockBridgeHarness();
    client = harness.createClient();

    // Auto-reply to attach
    harness.channel.toServerController.stream.listen((raw) {
      if (raw is String && raw.contains('"type":"attach"')) {
        harness.ackAttach(clientSessionId: 'sess-m4-challenger');
      }
    });

    auth = PyricFirebaseAuthPlatform(bridgeClient: client);
    firestore = PyricFirestorePlatform(
      bridgeClient: client,
      credentialsProvider: auth,
    );
    controller = PyricDebugController(
      authPlatform: auth,
      bridgeClient: client,
    );

    await client.connect();
    await pumpEventQueue();
  });

  tearDown(() async {
    controller.dispose();
    await auth.dispose();
    await firestore.terminate();
    await harness.dispose();
  });

  group('Milestone M4 Challenger: Flutter Reactive Lens Re-Subscription', () {
    test('switching to AuthLens.admin bypasses rules and updates snapshot listener', () async {
      final docRef = firestore.doc('vault/secret');
      final receivedData = <Map<String, dynamic>?>[];

      final sub = docRef.snapshots(listenSource: ListenSource.defaultSource).listen((snap) {
        receivedData.add(snap.data());
      });
      await pumpEventQueue();

      // 1. Initial subscription with mode: anon
      final sub1 = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      final subId1 = sub1['subId'] as String;
      expect(sub1['sub']['actAs'], equals({'mode': 'anon'}));

      // Reply with snapshot
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': subId1,
        'value': {
          'id': 'secret',
          'path': 'vault/secret',
          'exists': true,
          'data': {'level': 'public'},
        },
      });
      await pumpEventQueue();
      expect(receivedData.length, equals(1));
      expect(receivedData.first?['level'], equals('public'));

      // 2. Controller activates Admin Bypass
      controller.toggleAdminBypass(true);
      await pumpEventQueue();

      // Verify subId1 was unsubscribed and new sub sent with mode: admin
      final unsub1 = harness.sentMessages.firstWhere(
        (m) => m['type'] == 'worker-unsub' && m['subId'] == subId1,
      );
      expect(unsub1, isNotNull);

      final sub2 = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      final subId2 = sub2['subId'] as String;
      expect(subId2, isNot(equals(subId1)));
      expect(sub2['sub']['actAs'], equals({'mode': 'admin'}));

      // Reply with admin-bypass snapshot
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': subId2,
        'value': {
          'id': 'secret',
          'path': 'vault/secret',
          'exists': true,
          'data': {'level': 'top-secret-admin'},
        },
      });
      await pumpEventQueue();
      expect(receivedData.length, equals(2));
      expect(receivedData.last?['level'], equals('top-secret-admin'));

      // 3. Desktop Studio pushes remote-lens event with user identity and tenant
      harness.sendToClient({
        'type': 'worker-event',
        'event': 'remote-lens',
        'clientSessionId': 'sess-m4-challenger',
        'lens': {
          'mode': 'as',
          'uid': 'remote-auditor',
          'tenant': 'tenant-corp',
          'token': {'role': 'auditor'},
        },
      });
      await pumpEventQueue();

      // Verify subId2 was unsubscribed and new sub sent with mode: as
      final unsub2 = harness.sentMessages.firstWhere(
        (m) => m['type'] == 'worker-unsub' && m['subId'] == subId2,
      );
      expect(unsub2, isNotNull);

      final sub3 = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      final subId3 = sub3['subId'] as String;
      expect(subId3, isNot(equals(subId2)));
      expect(
        sub3['sub']['actAs'],
        equals({
          'mode': 'as',
          'uid': 'remote-auditor',
          'tenant': 'tenant-corp',
          'token': {'role': 'auditor'},
        }),
      );

      // Clean up
      await sub.cancel();
    });

    test('rapid alternating lens switches cancel every intermediate subscription with zero leaks', () async {
      final docRef = firestore.doc('vault/rapid');
      final sub = docRef.snapshots(listenSource: ListenSource.defaultSource).listen((_) {});
      await pumpEventQueue();

      // Rapidly oscillate 10 times between admin and user
      for (var i = 0; i < 10; i++) {
        if (i % 2 == 0) {
          controller.toggleAdminBypass(true);
        } else {
          controller.selectUser(
            SandboxUserRecord(
              uid: 'user-$i',
              tenantId: 'tenant-$i',
              customClaims: {'i': i},
            ),
          );
        }
        await pumpEventQueue();
      }

      await sub.cancel();
      await pumpEventQueue();

      final docSubFrames = harness.sentMessages
          .where((m) => m['type'] == 'worker-sub')
          .where((m) => (m['sub'] as Map)['target'] is Map && (m['sub']['target'] as Map)['__ref'] == 'doc')
          .toList();
      final unsubFrames = harness.sentMessages
          .where((m) => m['type'] == 'worker-unsub')
          .toList();

      final subscribedIds = docSubFrames.map((m) => m['subId'] as String).toSet();
      final unsubscribedIds = unsubFrames.map((m) => m['subId'] as String).toSet();

      expect(
        subscribedIds.difference(unsubscribedIds),
        isEmpty,
        reason: 'All intermediate snapshot listeners must be cleaned up on rapid lens transitions',
      );
    });
  });
}
