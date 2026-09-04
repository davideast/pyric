import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_debug.dart';

import '../auth/mock_bridge_helper.dart';

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricDebugController controller;

  setUp(() async {
    setupMockFirebase();
    harness = MockBridgeHarness();
    client = harness.createClient();
    auth = PyricFirebaseAuthPlatform(bridgeClient: client);

    final connectFuture = client.connect();
    await Future<void>.delayed(Duration.zero);
    harness.ackAttach(clientSessionId: 'sess-debug-1');
    await connectFuture;

    controller = PyricDebugController(
      authPlatform: auth,
      bridgeClient: client,
    );
  });

  tearDown(() async {
    controller.dispose();
    await auth.dispose();
    await client.disconnect();
    await harness.dispose();
  });

  group('PyricDebugController Tests', () {
    test('refreshUsers fetches users via auth.listUsers and updates state', () async {
      final refreshFuture = controller.refreshUsers();
      await Future<void>.delayed(Duration.zero);

      final opFrame = harness.sentMessages.firstWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.listUsers',
      );
      final opId = opFrame['id'] as String;

      harness.sendToClient({
        'type': 'worker-res',
        'id': opId,
        'ok': true,
        'value': [
          {
            'uid': 'user-alice',
            'email': 'alice@example.com',
            'displayName': 'Alice Admin',
            'customClaims': {'role': 'admin'},
          },
          {
            'uid': 'user-bob',
            'email': 'bob@example.com',
            'tenantId': 'tenant-corp',
          },
        ],
      });

      await refreshFuture;

      expect(controller.users.length, 2);
      expect(controller.users[0].uid, 'user-alice');
      expect(controller.users[0].displayName, 'Alice Admin');
      expect(controller.users[1].uid, 'user-bob');
      expect(controller.users[1].tenantId, 'tenant-corp');
    });

    test('selectUser updates currentLens and AuthPlatform', () async {
      const user = SandboxUserRecord(
        uid: 'user-charlie',
        email: 'charlie@example.com',
        tenantId: 'tenant-beta',
        customClaims: {'editor': true},
      );

      controller.selectUser(user);
      await pumpEventQueue();

      expect(controller.currentLens.mode, 'as');
      expect(controller.currentLens.uid, 'user-charlie');
      expect(controller.currentLens.tenant, 'tenant-beta');
      expect(auth.currentAuthLens, controller.currentLens);
    });

    test('toggleAdminBypass switches between admin and reset', () async {
      expect(controller.isAdminBypass, isFalse);

      controller.toggleAdminBypass(true);
      await pumpEventQueue();

      expect(controller.isAdminBypass, isTrue);
      expect(controller.currentLens, AuthLens.admin);
      expect(auth.currentAuthLens, AuthLens.admin);

      controller.toggleAdminBypass(false);
      await pumpEventQueue();

      expect(controller.isAdminBypass, isFalse);
      expect(controller.currentLens.mode, 'anon');
    });

    test('receives pushed remote-lens events from bridge', () async {
      expect(controller.currentLens.mode, 'anon');

      harness.sendToClient({
        'type': 'worker-event',
        'event': 'remote-lens',
        'lens': {
          'mode': 'admin',
        },
      });

      await pumpEventQueue();

      expect(controller.currentLens, AuthLens.admin);
      expect(controller.isAdminBypass, isTrue);
      expect(auth.currentAuthLens, AuthLens.admin);

      harness.sendToClient({
        'type': 'worker-event',
        'event': 'remote-lens',
        'lens': {
          'mode': 'as',
          'uid': 'user-remote',
          'tenant': 'tenant-gamma',
          'token': {'role': 'viewer'},
        },
      });

      await pumpEventQueue();

      expect(controller.currentLens.mode, 'as');
      expect(controller.currentLens.uid, 'user-remote');
      expect(controller.currentLens.tenant, 'tenant-gamma');
      expect(auth.currentAuthLens.uid, 'user-remote');
    });

    test('records and flushes denial reports', () async {
      final report = RulesDenialReport(
        citation: 'firestore.rules:20:5',
        expression: 'allow read: if false;',
        reasons: ['Condition evaluated to false'],
      );

      controller.addDenial(report);
      await pumpEventQueue();

      expect(controller.denials.length, 1);
      expect(controller.latestDenial?.citation, 'firestore.rules:20:5');

      controller.clearDenials();
      await pumpEventQueue();

      expect(controller.denials, isEmpty);
      expect(controller.latestDenial, isNull);
    });
  });
}
