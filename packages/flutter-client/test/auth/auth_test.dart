import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';

import 'mock_bridge_helper.dart';

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;

  final sampleUserMap = <String, dynamic>{
    'uid': 'user-123',
    'email': 'alice@example.com',
    'displayName': 'Alice',
    'photoURL': 'https://example.com/alice.png',
    'phoneNumber': '+15551234567',
    'isAnonymous': false,
    'emailVerified': true,
    'providerId': 'password',
    'tenantId': 'tenant-corp',
    'refreshToken': 'refresh-token-abc',
    'creationTimestamp': 1725400000000,
    'lastSignInTimestamp': 1725400050000,
    'providerData': [
      {
        'uid': 'alice@example.com',
        'email': 'alice@example.com',
        'displayName': 'Alice',
        'photoURL': 'https://example.com/alice.png',
        'phoneNumber': '+15551234567',
        'providerId': 'password',
      }
    ],
  };

  setUp(() async {
    setupMockFirebase();
    harness = MockBridgeHarness();
    client = harness.createClient();
    auth = PyricFirebaseAuthPlatform(bridgeClient: client);

    // Trigger handshake and auto-ack
    final connectFuture = client.connect();
    await Future<void>.delayed(Duration.zero);
    harness.ackAttach(clientSessionId: 'sess-test-1');
    await connectFuture;
  });

  tearDown(() async {
    await auth.dispose();
    await client.disconnect();
    await harness.dispose();
  });

  group('PyricFirebaseAuthPlatform: Registration & Delegate', () {
    test('registerWith sets FirebaseAuthPlatform.instance', () {
      PyricFirebaseAuthPlatform.registerWith(bridgeClient: client);
      expect(FirebaseAuthPlatform.instance, isA<PyricFirebaseAuthPlatform>());
    });

    test('delegateFor returns a PyricFirebaseAuthPlatform instance', () {
      final delegated = auth.delegateFor(app: auth.app);
      expect(delegated, isA<PyricFirebaseAuthPlatform>());
      expect(
        (delegated as PyricFirebaseAuthPlatform).bridgeClient,
        same(client),
      );
    });
  });

  group('PyricFirebaseAuthPlatform: Authentication Operations', () {
    test('signInWithEmailAndPassword dispatches op and updates currentUser',
        () async {
      final future = auth.signInWithEmailAndPassword('alice@example.com', 'secret123');

      // Wait for outbound op
      await Future<void>.delayed(Duration.zero);
      final opMsg = harness.sentMessages.firstWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      expect(opMsg['op']['email'], equals('alice@example.com'));
      expect(opMsg['op']['password'], equals('secret123'));

      // Reply with user
      harness.sendToClient({
        'type': 'worker-res',
        'id': opMsg['id'],
        'ok': true,
        'value': {'user': sampleUserMap, 'operationType': 'signIn'},
      });

      final cred = await future;
      expect(cred.user, isNotNull);
      expect(cred.user!.uid, equals('user-123'));
      expect(cred.user!.email, equals('alice@example.com'));
      expect(cred.user!.displayName, equals('Alice'));
      expect(cred.user!.tenantId, equals('tenant-corp'));
      expect(cred.user!.isAnonymous, isFalse);
      expect(cred.user!.isEmailVerified, isTrue);
      expect(cred.user!.providerData.length, equals(1));
      expect(auth.currentUser, equals(cred.user));
    });

    test('createUserWithEmailAndPassword marks isNewUser: true', () async {
      final future = auth.createUserWithEmailAndPassword(
        'alice@example.com',
        'secret123',
      );

      await Future<void>.delayed(Duration.zero);
      final opMsg = harness.sentMessages.firstWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.createUser',
      );
      expect(opMsg['op']['email'], equals('alice@example.com'));

      harness.sendToClient({
        'type': 'worker-res',
        'id': opMsg['id'],
        'ok': true,
        'value': {'user': sampleUserMap, 'operationType': 'signIn'},
      });

      final cred = await future;
      expect(cred.user!.uid, equals('user-123'));
      expect(cred.additionalUserInfo?.isNewUser, isTrue);
    });

    test('signInAnonymously sets anonymous identity', () async {
      final anonMap = Map<String, dynamic>.from(sampleUserMap)
        ..['uid'] = 'anon-999'
        ..['isAnonymous'] = true
        ..['email'] = null;

      final future = auth.signInAnonymously();

      await Future<void>.delayed(Duration.zero);
      final opMsg = harness.sentMessages.firstWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInAnonymously',
      );

      harness.sendToClient({
        'type': 'worker-res',
        'id': opMsg['id'],
        'ok': true,
        'value': {'user': anonMap, 'operationType': 'signIn'},
      });

      final cred = await future;
      expect(cred.user!.uid, equals('anon-999'));
      expect(cred.user!.isAnonymous, isTrue);
      expect(cred.user!.email, isNull);
    });

    test('signOut clears currentUser and emits null on streams', () async {
      // First sign in
      final signInFuture = auth.signInWithEmailAndPassword('a@b.com', 'p');
      await Future<void>.delayed(Duration.zero);
      final signInOp = harness.sentMessages.firstWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {'user': sampleUserMap},
      });
      await signInFuture;
      expect(auth.currentUser, isNotNull);

      // Now sign out
      final signOutFuture = auth.signOut();
      await Future<void>.delayed(Duration.zero);
      final signOutOp = harness.sentMessages.firstWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signOut',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signOutOp['id'],
        'ok': true,
        'value': null,
      });
      await signOutFuture;
      expect(auth.currentUser, isNull);
    });
  });

  group('PyricFirebaseAuthPlatform: Reactive Streams', () {
    test('authStateChanges emits initial null and updates on sign in and out',
        () async {
      final emitted = <String?>[];
      final sub = auth.authStateChanges().listen((u) => emitted.add(u?.uid));

      // Initial state is null
      await pumpEventQueue();
      expect(emitted, equals([null]));

      // Sign in
      final signInFuture = auth.signInWithEmailAndPassword('a@b.com', 'p');
      await pumpEventQueue();
      final signInOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {'user': sampleUserMap},
      });
      await signInFuture;
      await pumpEventQueue();

      expect(emitted, equals([null, 'user-123']));

      // Sign out
      final signOutFuture = auth.signOut();
      await pumpEventQueue();
      final signOutOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signOut',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signOutOp['id'],
        'ok': true,
        'value': null,
      });
      await signOutFuture;
      await pumpEventQueue();

      expect(emitted, equals([null, 'user-123', null]));
      await sub.cancel();
    });

    test('userChanges emits on profile update', () async {
      // Sign in
      final signInFuture = auth.signInWithEmailAndPassword('a@b.com', 'p');
      await Future<void>.delayed(Duration.zero);
      final signInOp = harness.sentMessages.firstWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {'user': sampleUserMap},
      });
      await signInFuture;

      final names = <String?>[];
      final sub = auth.userChanges().listen((u) => names.add(u?.displayName));
      await Future<void>.delayed(Duration.zero);
      expect(names, equals(['Alice']));

      // Update profile
      final updatedMap = Map<String, dynamic>.from(sampleUserMap)
        ..['displayName'] = 'Alice Cooper';
      final updateFuture =
          auth.currentUser!.updateProfile({'displayName': 'Alice Cooper'});
      await Future<void>.delayed(Duration.zero);
      final updateOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.updateProfile',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': updateOp['id'],
        'ok': true,
        'value': updatedMap,
      });
      await updateFuture;
      await pumpEventQueue();

      expect(names, equals(['Alice', 'Alice Cooper']));
      expect(auth.currentUser!.displayName, equals('Alice Cooper'));
      await sub.cancel();
    });
  });

  group('PyricUserPlatform: Token & Profile Operations', () {
    setUp(() async {
      final signInFuture = auth.signInWithEmailAndPassword('a@b.com', 'p');
      await Future<void>.delayed(Duration.zero);
      final signInOp = harness.sentMessages.firstWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {'user': sampleUserMap},
      });
      await signInFuture;
    });

    test('getIdToken returns JWT string', () async {
      final future = auth.currentUser!.getIdToken(true);
      await Future<void>.delayed(Duration.zero);
      final opMsg = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.getIdToken',
      );
      expect(opMsg['op']['forceRefresh'], isTrue);

      harness.sendToClient({
        'type': 'worker-res',
        'id': opMsg['id'],
        'ok': true,
        'value': 'mock-jwt-token-xyz',
      });

      final token = await future;
      expect(token, equals('mock-jwt-token-xyz'));
    });

    test('getIdTokenResult returns structured token claims and timestamps',
        () async {
      final future = auth.currentUser!.getIdTokenResult(false);
      await Future<void>.delayed(Duration.zero);
      final opMsg = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.getIdTokenResult',
      );

      harness.sendToClient({
        'type': 'worker-res',
        'id': opMsg['id'],
        'ok': true,
        'value': {
          'token': 'jwt-result-abc',
          'claims': {'admin': true, 'tier': 'premium'},
          'authTime': '2026-09-04T12:00:00.000Z',
          'expirationTime': '2026-09-04T13:00:00.000Z',
          'issuedAtTime': '2026-09-04T12:00:00.000Z',
          'signInProvider': 'password',
        },
      });

      final result = await future;
      expect(result.token, equals('jwt-result-abc'));
      expect(result.claims?['admin'], isTrue);
      expect(result.claims?['tier'], equals('premium'));
      expect(result.signInProvider, equals('password'));
      expect(result.authTime, isNotNull);
      expect(result.expirationTime, isNotNull);
    });

    test('reload fetches latest user profile', () async {
      final future = auth.currentUser!.reload();
      await Future<void>.delayed(Duration.zero);
      final opMsg = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.getCurrentUser',
      );

      final reloadedMap = Map<String, dynamic>.from(sampleUserMap)
        ..['displayName'] = 'Reloaded Alice';
      harness.sendToClient({
        'type': 'worker-res',
        'id': opMsg['id'],
        'ok': true,
        'value': reloadedMap,
      });

      await future;
      expect(auth.currentUser!.displayName, equals('Reloaded Alice'));
    });
  });

  group('PyricFirebaseAuthPlatform: Custom Claims & Lens Equality', () {
    test('signIn stores customClaims and currentAuthLens contains token', () async {
      final future = auth.signInWithEmailAndPassword('admin@example.com', 'adminpass');
      await Future<void>.delayed(Duration.zero);
      final opMsg = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );

      harness.sendToClient({
        'type': 'worker-res',
        'id': opMsg['id'],
        'ok': true,
        'value': {
          'user': sampleUserMap,
          'claims': {'role': 'admin', 'tier': 'enterprise'},
        },
      });

      final cred = await future;
      final pyricUser = cred.user! as PyricUserPlatform;
      expect(pyricUser.customClaims, equals({'role': 'admin', 'tier': 'enterprise'}));

      final lens = auth.currentAuthLens;
      expect(lens, isA<AsUserLens>());
      final asUser = lens as AsUserLens;
      expect(asUser.uid, equals('user-123'));
      expect(asUser.tenant, equals('tenant-corp'));
      expect(asUser.token, equals({'role': 'admin', 'tier': 'enterprise'}));
      expect(asUser.toMap(), equals({
        'mode': 'as',
        'uid': 'user-123',
        'tenant': 'tenant-corp',
        'token': {'role': 'admin', 'tier': 'enterprise'},
      }));
    });

    test('AsUserLens deep collection equality distinguishes token claim changes', () {
      final lensA = AuthLens.asUser(
        uid: 'user-1',
        tenant: 'tenant-1',
        token: {'role': 'member', 'groups': ['eng', 'dev']},
      );
      final lensB = AuthLens.asUser(
        uid: 'user-1',
        tenant: 'tenant-1',
        token: {'role': 'member', 'groups': ['eng', 'dev']},
      );
      final lensC = AuthLens.asUser(
        uid: 'user-1',
        tenant: 'tenant-1',
        token: {'role': 'admin', 'groups': ['eng', 'dev']},
      );

      expect(lensA, equals(lensB));
      expect(lensA.hashCode, equals(lensB.hashCode));
      expect(lensA, isNot(equals(lensC)));
      expect(lensA.hashCode, isNot(equals(lensC.hashCode)));
    });

    test('authLensChanges emits when token claims are refreshed', () async {
      final lensEvents = <AuthLens>[];
      final sub = auth.authLensChanges.listen(lensEvents.add);
      await Future<void>.delayed(Duration.zero);

      // Initially anon
      expect(lensEvents, [AuthLens.anon]);

      // Sign in
      final signInFuture = auth.signInWithEmailAndPassword('alice@example.com', 'pwd');
      await Future<void>.delayed(Duration.zero);
      final opMsg = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': opMsg['id'],
        'ok': true,
        'value': {
          'user': sampleUserMap,
          'claims': {'role': 'reader'},
        },
      });
      await signInFuture;
      await Future<void>.delayed(Duration.zero);

      expect(lensEvents.length, equals(2));
      expect((lensEvents[1] as AsUserLens).token, equals({'role': 'reader'}));

      // Refresh ID token with updated claims
      final tokenResultFuture = auth.currentUser!.getIdTokenResult(true);
      await Future<void>.delayed(Duration.zero);
      final tokenOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.getIdTokenResult',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': tokenOp['id'],
        'ok': true,
        'value': {
          'token': 'refreshed-jwt',
          'claims': {'role': 'admin'},
          'expirationTime': '2026-09-04T18:00:00Z',
          'authTime': '2026-09-04T16:00:00Z',
          'issuedAtTime': '2026-09-04T17:00:00Z',
        },
      });
      await tokenResultFuture;
      await Future<void>.delayed(Duration.zero);

      expect(lensEvents.length, equals(3));
      expect((lensEvents[2] as AsUserLens).token, equals({'role': 'admin'}));

      await sub.cancel();
    });
  });

  group('PyricFirebaseAuthPlatform: Error Mapping', () {
    test('maps bridge error to FirebaseAuthException', () async {
      final future = auth.signInWithEmailAndPassword('a@b.com', 'wrong');
      await Future<void>.delayed(Duration.zero);
      final opMsg = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );

      harness.sendToClient({
        'type': 'worker-res',
        'id': opMsg['id'],
        'ok': false,
        'error': {
          'code': 'wrong-password',
          'message': 'The password is invalid.',
        },
      });

      expect(
        () => future,
        throwsA(
          isA<FirebaseAuthException>()
              .having((e) => e.code, 'code', equals('wrong-password'))
              .having((e) => e.message, 'message',
                  equals('The password is invalid.')),
        ),
      );
    });
  });
}
