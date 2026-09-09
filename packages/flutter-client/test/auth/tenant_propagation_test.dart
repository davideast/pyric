import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import 'mock_bridge_helper.dart';

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricFirestorePlatform firestore;

  setUp(() async {
    setupMockFirebase();
    harness = MockBridgeHarness();
    client = harness.createClient();
    auth = PyricFirebaseAuthPlatform(bridgeClient: client);
    firestore = PyricFirestorePlatform(
      bridgeClient: client,
      credentialsProvider: auth,
    );

    final connectFuture = client.connect();
    await Future<void>.delayed(Duration.zero);
    harness.ackAttach(clientSessionId: 'sess-tenant-prop');
    await connectFuture;
  });

  tearDown(() async {
    await auth.dispose();
    await firestore.terminate();
    await harness.dispose();
  });

  group('R2-Flutter: Full-Lifecycle tenantId Propagation', () {
    test('auth.tenantId propagates through signInWithEmailAndPassword, user.tenantId, and downstream Firestore actAs lens', () async {
      auth.tenantId = 'tenant-acme';
      expect(auth.tenantId, equals('tenant-acme'));

      final signInFuture = auth.signInWithEmailAndPassword(
        'alice@acme.com',
        'secret123',
      );
      await pumpEventQueue();

      final signInOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      expect(signInOp['op']['tenantId'], equals('tenant-acme'));

      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {
          'user': {
            'uid': 'uid-acme-1',
            'email': 'alice@acme.com',
            'isAnonymous': false,
            'tenantId': 'tenant-acme',
          },
        },
      });

      final cred = await signInFuture;
      expect(cred.user?.tenantId, equals('tenant-acme'));
      expect(auth.currentUser?.tenantId, equals('tenant-acme'));

      final docRef = firestore.doc('orgs/acme/users/uid-acme-1');
      final getFuture = docRef.get();
      await pumpEventQueue();

      final getOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'getDoc',
      );
      expect(
        getOp['op']['actAs'],
        equals({
          'mode': 'as',
          'uid': 'uid-acme-1',
          'tenant': 'tenant-acme',
        }),
      );

      harness.sendToClient({
        'type': 'worker-res',
        'id': getOp['id'],
        'ok': true,
        'value': {
          'id': 'uid-acme-1',
          'path': 'orgs/acme/users/uid-acme-1',
          'exists': true,
          'data': {'json': '{"role":"admin"}'},
        },
      });

      final snap = await getFuture;
      expect(snap.exists, isTrue);
    });

    test('setTenantId propagates through createUserWithEmailAndPassword and signInAnonymously', () async {
      await auth.setTenantId('tenant-beta');
      expect(auth.tenantId, equals('tenant-beta'));

      final createFuture = auth.createUserWithEmailAndPassword(
        'bob@beta.com',
        'pass123',
      );
      await pumpEventQueue();

      final createOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.createUser',
      );
      expect(createOp['op']['tenantId'], equals('tenant-beta'));

      harness.sendToClient({
        'type': 'worker-res',
        'id': createOp['id'],
        'ok': true,
        'value': {
          'user': {
            'uid': 'uid-beta-1',
            'email': 'bob@beta.com',
            'isAnonymous': false,
            'tenantId': 'tenant-beta',
          },
        },
      });

      final cred = await createFuture;
      expect(cred.user?.tenantId, equals('tenant-beta'));
      expect(
        auth.currentAuthLens,
        equals(
          AuthLens.asUser(
            uid: 'uid-beta-1',
            tenant: 'tenant-beta',
          ),
        ),
      );
    });
  });
}
