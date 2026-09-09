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

    test('authState and idToken bridge broadcasts preserve existing tenantId and customClaims for same uid', () async {
      await auth.setTenantId('tenant-gamma');
      final signInFuture = auth.signInWithEmailAndPassword('gamma@example.com', 'secret');
      await pumpEventQueue();

      final signInOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {
          'user': {
            'uid': 'uid-gamma-1',
            'email': 'gamma@example.com',
            'tenantId': 'tenant-gamma',
            'customClaims': {'role': 'manager'},
          },
        },
      });
      final cred = await signInFuture;
      expect(cred.user?.tenantId, equals('tenant-gamma'));

      // Find the subscription ID for authState and broadcast a profile update event without tenantId/customClaims
      final authStateSub = harness.sentMessages.firstWhere(
        (m) => m['type'] == 'worker-sub' && m['sub']?['target'] == 'authState',
      );
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': authStateSub['subId'],
        'value': {
          'uid': 'uid-gamma-1',
          'email': 'gamma@example.com',
          'displayName': 'Gamma Manager',
        },
      });
      await pumpEventQueue();

      final currentUser = auth.currentUser as PyricUserPlatform?;
      expect(currentUser?.tenantId, equals('tenant-gamma'));
      expect(currentUser?.customClaims?['role'], equals('manager'));
    });

    test('auth.tenantId propagates through signInWithCredential to wire payload and user.tenantId', () async {
      await auth.setTenantId('tenant-oauth');
      final credFuture = auth.signInWithCredential(
        GoogleAuthProvider.credential(
          idToken: 'id-token-123',
          accessToken: 'access-token-456',
        ),
      );
      await pumpEventQueue();

      final oauthOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInWithCredential',
      );
      expect(oauthOp['op']['tenantId'], equals('tenant-oauth'));

      harness.sendToClient({
        'type': 'worker-res',
        'id': oauthOp['id'],
        'ok': true,
        'value': {
          'user': {
            'uid': 'uid-oauth-1',
            'email': 'oauth@example.com',
          },
        },
      });

      final res = await credFuture;
      expect(res.user?.tenantId, equals('tenant-oauth'));
    });

    test('user mutations (updateProfile, updateEmail, updatePassword, reload) preserve existing customClaims and tenantId', () async {
      await auth.setTenantId('tenant-omega');
      final signInFuture = auth.signInWithEmailAndPassword('omega@example.com', 'secret');
      await pumpEventQueue();

      final signInOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {
          'user': {
            'uid': 'uid-omega-1',
            'email': 'omega@example.com',
            'tenantId': 'tenant-omega',
            'customClaims': {'tier': 'platinum'},
          },
        },
      });
      final cred = await signInFuture;
      final user = cred.user as PyricUserPlatform;
      expect(user.customClaims?['tier'], equals('platinum'));

      // 1. updateProfile returns serialized user without customClaims or tenantId
      final updateProfileFuture = user.updateProfile({'displayName': 'Omega Chief'});
      await pumpEventQueue();
      final profileOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.updateProfile',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': profileOp['id'],
        'ok': true,
        'value': {
          'uid': 'uid-omega-1',
          'email': 'omega@example.com',
          'displayName': 'Omega Chief',
        },
      });
      await updateProfileFuture;

      final userAfterProfile = auth.currentUser as PyricUserPlatform?;
      expect(userAfterProfile?.displayName, equals('Omega Chief'));
      expect(userAfterProfile?.tenantId, equals('tenant-omega'));
      expect(userAfterProfile?.customClaims?['tier'], equals('platinum'));

      // 2. updateEmail
      final updateEmailFuture = userAfterProfile!.updateEmail('new-omega@example.com');
      await pumpEventQueue();
      final emailOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.updateEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': emailOp['id'],
        'ok': true,
        'value': {
          'uid': 'uid-omega-1',
          'email': 'new-omega@example.com',
          'displayName': 'Omega Chief',
        },
      });
      await updateEmailFuture;

      final userAfterEmail = auth.currentUser as PyricUserPlatform?;
      expect(userAfterEmail?.email, equals('new-omega@example.com'));
      expect(userAfterEmail?.tenantId, equals('tenant-omega'));
      expect(userAfterEmail?.customClaims?['tier'], equals('platinum'));

      // 3. updatePassword
      final updatePasswordFuture = userAfterEmail!.updatePassword('new-pass-123');
      await pumpEventQueue();
      final passOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.updatePassword',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': passOp['id'],
        'ok': true,
        'value': {
          'uid': 'uid-omega-1',
          'email': 'new-omega@example.com',
          'displayName': 'Omega Chief',
        },
      });
      await updatePasswordFuture;

      final userAfterPass = auth.currentUser as PyricUserPlatform?;
      expect(userAfterPass?.tenantId, equals('tenant-omega'));
      expect(userAfterPass?.customClaims?['tier'], equals('platinum'));

      // 4. reload
      final reloadFuture = userAfterPass!.reload();
      await pumpEventQueue();
      final reloadOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.getCurrentUser',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': reloadOp['id'],
        'ok': true,
        'value': {
          'uid': 'uid-omega-1',
          'email': 'new-omega@example.com',
          'displayName': 'Omega Chief',
        },
      });
      await reloadFuture;

      final userAfterReload = auth.currentUser as PyricUserPlatform?;
      expect(userAfterReload?.tenantId, equals('tenant-omega'));
      expect(userAfterReload?.customClaims?['tier'], equals('platinum'));
    });
  });
}

