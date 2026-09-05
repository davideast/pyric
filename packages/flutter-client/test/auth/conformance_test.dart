import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

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
    PyricFirebaseAuthPlatform.registerWith(bridgeClient: client);

    final connectFuture = client.connect();
    await Future<void>.delayed(Duration.zero);
    harness.ackAttach(clientSessionId: 'sess-auth-conf');
    await connectFuture;
  });

  tearDown(() async {
    await auth.dispose();
    await client.disconnect();
    await harness.dispose();
  });

  // ── 1. Instance & Lifecycle ───────────────────────────────────────────────
  group('1. FirebaseAuthPlatform: Instance & Lifecycle', () {
    test('auth-flutter#1: FirebaseAuthPlatform.instance returns default platform', () {
      PyricFirebaseAuthPlatform.registerWith(bridgeClient: client);
      expect(FirebaseAuthPlatform.instance, isA<PyricFirebaseAuthPlatform>());
    });

    test('auth-flutter#2: FirebaseAuthPlatform.instanceFor returns platform for app', () {
      final appAuth = FirebaseAuthPlatform.instanceFor(app: auth.app, pluginConstants: const {});
      expect(appAuth, isA<FirebaseAuthPlatform>());
    });

    test('auth-flutter#3: FirebaseAuthPlatform.delegateFor creates app delegate', () {
      final delegated = auth.delegateFor(app: auth.app);
      expect(delegated, isA<PyricFirebaseAuthPlatform>());
    });

    test('auth-flutter#4: PyricFirebaseAuthPlatform.registerWith sets instance singleton', () {
      PyricFirebaseAuthPlatform.registerWith(bridgeClient: client);
      expect(FirebaseAuthPlatform.instance, isA<PyricFirebaseAuthPlatform>());
    });

    test('auth-flutter#5: FirebaseAuthPlatform.dispose closes resources', () async {
      await expectLater(auth.dispose(), completes);
    });
  });

  // ── 2. User Authentication ────────────────────────────────────────────────
  group('2. FirebaseAuthPlatform: User Authentication', () {
    test('auth-flutter#6: FirebaseAuthPlatform.signInWithEmailAndPassword authenticates user', () async {
      final future = auth.signInWithEmailAndPassword('alice@example.com', 'secret');
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signInEmail');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': true, 'value': {'user': sampleUserMap, 'operationType': 'signIn'}});
      final cred = await future;
      expect(cred.user?.uid, equals('user-123'));
      expect(auth.currentUser?.uid, equals('user-123'));
    });

    test('auth-flutter#7: FirebaseAuthPlatform.createUserWithEmailAndPassword registers user', () async {
      final future = auth.createUserWithEmailAndPassword('new@example.com', 'secret');
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.createUser');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': true, 'value': {'user': sampleUserMap, 'operationType': 'signIn'}});
      final cred = await future;
      expect(cred.additionalUserInfo?.isNewUser, isTrue);
    });

    test('auth-flutter#8: FirebaseAuthPlatform.signInAnonymously establishes session', () async {
      final anonMap = Map<String, dynamic>.from(sampleUserMap)..['isAnonymous'] = true..['email'] = null;
      final future = auth.signInAnonymously();
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signInAnonymously');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': true, 'value': {'user': anonMap, 'operationType': 'signIn'}});
      final cred = await future;
      expect(cred.user?.isAnonymous, isTrue);
    });

    test('auth-flutter#9: FirebaseAuthPlatform.signOut clears user session', () async {
      auth.currentUser = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
      expect(auth.currentUser, isNotNull);
      final future = auth.signOut();
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signOut');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': true, 'value': null});
      await future;
      expect(auth.currentUser, isNull);
    });

    test('auth-flutter#10: FirebaseAuthPlatform.currentUser returns cached user or null', () {
      expect(auth.currentUser, isNull);
      auth.currentUser = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
      expect(auth.currentUser?.uid, equals('user-123'));
    });
  });

  // ── 3. Reactive State Streams ─────────────────────────────────────────────
  group('3. FirebaseAuthPlatform: Reactive State Streams', () {
    test('auth-flutter#11: FirebaseAuthPlatform.authStateChanges emits on transitions', () async {
      final emitted = <String?>[];
      final sub = auth.authStateChanges().listen((u) => emitted.add(u?.uid));
      await pumpEventQueue();
      expect(emitted, [null]);
      auth.sendAuthChangesEvent(auth.app.name, PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client));
      await pumpEventQueue();
      expect(emitted, [null, 'user-123']);
      await sub.cancel();
    });

    test('auth-flutter#12: FirebaseAuthPlatform.idTokenChanges emits on token changes', () async {
      final emitted = <String?>[];
      final sub = auth.idTokenChanges().listen((u) => emitted.add(u?.uid));
      await pumpEventQueue();
      expect(emitted, [null]);
      auth.sendAuthChangesEvent(auth.app.name, PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client));
      await pumpEventQueue();
      expect(emitted, [null, 'user-123']);
      await sub.cancel();
    });

    test('auth-flutter#13: FirebaseAuthPlatform.userChanges emits on user updates', () async {
      final emitted = <String?>[];
      final sub = auth.userChanges().listen((u) => emitted.add(u?.uid));
      await pumpEventQueue();
      expect(emitted, [null]);
      auth.sendAuthChangesEvent(auth.app.name, PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client));
      await pumpEventQueue();
      expect(emitted, [null, 'user-123']);
      await sub.cancel();
    });

    test('auth-flutter#14: FirebaseAuthPlatform.sendAuthChangesEvent dispatches updates', () async {
      final emitted = <UserPlatform?>[];
      final sub = auth.authStateChanges().listen(emitted.add);
      await pumpEventQueue();
      final user = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
      auth.sendAuthChangesEvent(auth.app.name, user);
      await pumpEventQueue();
      expect(emitted.last?.uid, equals('user-123'));
      await sub.cancel();
    });
  });

  // ── 4. Multi-Tenancy & AuthLens Integration ──────────────────────────────
  group('4. Multi-Tenancy & AuthLens Integration', () {
    test('auth-flutter#15: PyricAuthCredentialsProvider.currentAuthLens derives active lens', () {
      expect(auth.currentAuthLens, equals(AuthLens.anon));
      auth.currentUser = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
      final lens = auth.currentAuthLens as AsUserLens;
      expect(lens.uid, equals('user-123'));
      expect(lens.tenant, equals('tenant-corp'));
    });

    test('auth-flutter#16: PyricAuthCredentialsProvider.authLensChanges emits transitions', () async {
      final events = <AuthLens>[];
      final sub = auth.authLensChanges.listen(events.add);
      await pumpEventQueue();
      auth.currentUser = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
      auth.sendAuthChangesEvent(auth.app.name, auth.currentUser);
      await pumpEventQueue();
      expect(events.length, greaterThanOrEqualTo(1));
      await sub.cancel();
    });

    test('auth-flutter#17: AuthLens.asUser tenant claim isolation in rules', () {
      final lens = AuthLens.asUser(uid: 'u-corp', tenant: 'tenant-enterprise');
      final map = lens.toMap();
      expect(map['tenant'], equals('tenant-enterprise'));
    });

    test('auth-flutter#18: AuthLens deep equality semantics', () {
      final l1 = AuthLens.asUser(uid: 'u1', token: {'role': 'admin'});
      final l2 = AuthLens.asUser(uid: 'u1', token: {'role': 'admin'});
      final l3 = AuthLens.asUser(uid: 'u1', token: {'role': 'user'});
      expect(l1, equals(l2));
      expect(l1, isNot(equals(l3)));
    });

    test('auth-flutter#19: Firestore snapshot re-subscription supervisor', () async {
      final firestore = PyricFirestorePlatform(bridgeClient: client, credentialsProvider: auth);
      final snaps = <DocumentSnapshotPlatform>[];
      final sub = firestore.doc('users/alice').snapshots(listenSource: ListenSource.defaultSource).listen(snaps.add);
      await pumpEventQueue();
      final subFrame = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      expect(subFrame['sub']['actAs'], equals({'mode': 'anon'}));
      await sub.cancel();
      await firestore.terminate();
    });
  });

  // ── 5. UserPlatform: Identity Properties & Metadata ───────────────────────
  group('5. UserPlatform: Identity Properties & Metadata', () {
    late PyricUserPlatform user;
    setUp(() {
      user = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
    });

    test('auth-flutter#20: UserPlatform.uid returns user identifier', () => expect(user.uid, equals('user-123')));
    test('auth-flutter#21: UserPlatform.email returns primary email', () => expect(user.email, equals('alice@example.com')));
    test('auth-flutter#22: UserPlatform.displayName returns profile display name', () => expect(user.displayName, equals('Alice')));
    test('auth-flutter#23: UserPlatform.photoURL returns photo URL string', () => expect(user.photoURL, equals('https://example.com/alice.png')));
    test('auth-flutter#24: UserPlatform.phoneNumber returns phone number', () => expect(user.phoneNumber, equals('+15551234567')));
    test('auth-flutter#25: UserPlatform.isAnonymous reports account type', () => expect(user.isAnonymous, isFalse));
    test('auth-flutter#26: UserPlatform.emailVerified indicates verification', () => expect(user.isEmailVerified, isTrue));
    test('auth-flutter#27: UserPlatform.tenantId exposes tenant identity', () => expect(user.tenantId, equals('tenant-corp')));
    test('auth-flutter#28: UserPlatform.providerData lists provider details', () => expect(user.providerData.length, equals(1)));
    test('auth-flutter#29: UserPlatform.metadata provides timestamps', () => expect(user.metadata.creationTime, isNotNull));
  });

  // ── 6. UserPlatform: Tokens & Security Context ────────────────────────────
  group('6. UserPlatform: Tokens & Security Context', () {
    late PyricUserPlatform user;
    setUp(() {
      user = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
      auth.currentUser = user;
    });

    test('auth-flutter#30: UserPlatform.getIdToken returns valid JWT string', () async {
      final future = user.getIdToken(true);
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.getIdToken');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': true, 'value': 'tok-123'});
      final token = await future;
      expect(token, equals('tok-123'));
    });

    test('auth-flutter#31: UserPlatform.getIdTokenResult returns structured claims', () async {
      final future = user.getIdTokenResult(false);
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.getIdTokenResult');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': true, 'value': {'token': 'tok-res', 'claims': {'role': 'admin'}}});
      final res = await future;
      expect(res.claims?['role'], equals('admin'));
    });

    test('auth-flutter#32: UserPlatform.customClaims exposes token claims', () {
      final userWithClaims = PyricUserPlatform.fromWire(auth: auth, data: {...sampleUserMap, 'customClaims': {'role': 'admin'}}, client: client);
      expect(userWithClaims.customClaims, equals({'role': 'admin'}));
    });

    test('auth-flutter#33: UserPlatform forced token refresh event dispatch', () async {
      final future = user.getIdTokenResult(true);
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.getIdTokenResult');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': true, 'value': {'token': 'tok-ref', 'claims': {'tier': 'vip'}}});
      await future;
      expect(user.customClaims?['tier'], equals('vip'));
    });
  });

  // ── 7. UserPlatform: Profile & Account Mutations ──────────────────────────
  group('7. UserPlatform: Profile & Account Mutations', () {
    late PyricUserPlatform user;
    setUp(() {
      user = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
      auth.currentUser = user;
    });

    test('auth-flutter#34: UserPlatform.updateProfile mutates profile', () async {
      final future = user.updateProfile({'displayName': 'Alice Updated'});
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.updateProfile');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': true, 'value': {...sampleUserMap, 'displayName': 'Alice Updated'}});
      await future;
      expect(auth.currentUser?.displayName, equals('Alice Updated'));
    });

    test('auth-flutter#35: UserPlatform.reload refreshes user profile', () async {
      final future = user.reload();
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.getCurrentUser');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': true, 'value': {...sampleUserMap, 'displayName': 'Alice Reloaded'}});
      await future;
      expect(auth.currentUser?.displayName, equals('Alice Reloaded'));
    });

    test('auth-flutter#36: UserPlatform.delete deletes account', () async {
      final future = user.delete();
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.deleteUser');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': true, 'value': null});
      await future;
      expect(auth.currentUser, isNull);
    });

    test('auth-flutter#37: UserPlatform.updateEmail updates email address', () {
      fail('Red at birth: auth-flutter#37 UserPlatform.updateEmail not implemented yet');
    });

    test('auth-flutter#38: UserPlatform.updatePassword updates password', () {
      fail('Red at birth: auth-flutter#38 UserPlatform.updatePassword not implemented yet');
    });
  });

  // ── 8. UserCredentialPlatform & Supporting Models ─────────────────────────
  group('8. UserCredentialPlatform & Supporting Models', () {
    test('auth-flutter#39: UserCredentialPlatform.user exposes user', () {
      final user = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
      final cred = PyricUserCredentialPlatform(auth: auth, user: user);
      expect(cred.user?.uid, equals('user-123'));
    });

    test('auth-flutter#40: UserCredentialPlatform.additionalUserInfo exposes new user flag', () {
      final cred = PyricUserCredentialPlatform(auth: auth, user: null, additionalUserInfo: AdditionalUserInfo(isNewUser: true));
      expect(cred.additionalUserInfo?.isNewUser, isTrue);
    });

    test('auth-flutter#41: InternalUserDetails wire deserializer parses payload', () {
      final user = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
      expect(user.providerData.first.providerId, equals('password'));
    });
  });

  // ── 9. Advanced Auth & Platform Extensions ────────────────────────────────
  group('9. Advanced Auth & Platform Extensions', () {
    test('auth-flutter#42: MultiFactorPlatform interface contract stub exists', () {
      final user = PyricUserPlatform.fromWire(auth: auth, data: sampleUserMap, client: client);
      expect(user.multiFactor, isA<MultiFactorPlatform>());
    });

    test('auth-flutter#43: FirebaseAuthPlatform.setLanguageCode configures locale', () {
      fail('Red at birth: auth-flutter#43 FirebaseAuthPlatform.setLanguageCode not implemented yet');
    });

    test('auth-flutter#44: FirebaseAuthPlatform.useAuthEmulator configures emulator', () {
      fail('Red at birth: auth-flutter#44 FirebaseAuthPlatform.useAuthEmulator not implemented yet');
    });

    test('auth-flutter#45: FirebaseAuthPlatform.setPersistence configures persistence', () {
      fail('Red at birth: auth-flutter#45 FirebaseAuthPlatform.setPersistence not implemented yet');
    });
  });

  // ── 10. Error Handling & Wire Codecs ──────────────────────────────────────
  group('10. Error Handling & Wire Codecs', () {
    test('auth-flutter#46: FirebaseAuthException translation maps codes', () async {
      final future = auth.signInWithEmailAndPassword('a@b.com', 'bad');
      await Future<void>.delayed(Duration.zero);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signInEmail');
      harness.sendToClient({'type': 'worker-res', 'id': op['id'], 'ok': false, 'error': {'code': 'user-not-found', 'message': 'Not found'}});
      expect(() => future, throwsA(isA<FirebaseAuthException>().having((e) => e.code, 'code', equals('user-not-found'))));
    });

    test('auth-flutter#47: Bridge auth operation codecs encode and decode RPCs', () async {
      final future = client.authSignInEmail('a@b.com', 'secret');
      await Future<void>.delayed(Duration.zero);
      final msg = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op');
      expect(msg['op']['method'], equals('auth.signInEmail'));
      expect(msg['op']['email'], equals('a@b.com'));
      expect(msg['op']['password'], equals('secret'));
      harness.sendToClient({
        'type': 'worker-res',
        'id': msg['id'],
        'ok': true,
        'value': {'user': sampleUserMap},
      });
      await future;
    });

    test('auth-flutter#48: Remote client session isolation connects with sessionId', () {
      expect(client.clientSessionId, equals('sess-auth-conf'));
    });
  });
}
