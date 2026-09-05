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
    harness.ackAttach(clientSessionId: 'sess-challenger-1');
    await connectFuture;
  });

  tearDown(() async {
    await auth.dispose();
    await client.disconnect();
    harness.dispose();
  });

  group('Challenger: Auth State and ID Token Streams Lifecycle', () {
    test(
        'emits lifecycle: initial null -> sign in user -> token change -> sign out null',
        () async {
      final authEvents = <String?>[];
      final idTokenEvents = <String?>[];

      final authSub = auth.authStateChanges().listen((u) => authEvents.add(u?.uid));
      final tokenSub = auth.idTokenChanges().listen((u) => idTokenEvents.add(u?.uid));

      await pumpEventQueue();

      // 1. Initial event must be null
      expect(authEvents, equals([null]));
      expect(idTokenEvents, equals([null]));

      // 2. Sign in as Alice
      final signInFuture = auth.signInWithEmailAndPassword('alice@example.com', 'pass123');
      await pumpEventQueue();

      final signInOp = harness.sentMessages.firstWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {
          'user': {
            'uid': 'user-alice',
            'email': 'alice@example.com',
            'displayName': 'Alice',
            'isAnonymous': false,
          },
          'operationType': 'signIn',
        },
      });
      await signInFuture;
      await pumpEventQueue();

      expect(authEvents, equals([null, 'user-alice']));
      expect(idTokenEvents, equals([null, 'user-alice']));

      // 3. ID Token change event arrives from bridge
      final idTokenSubMsg = harness.sentMessages.firstWhere(
        (m) => m['type'] == 'worker-sub' && m['sub']?['target'] == 'idToken',
      );
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': idTokenSubMsg['subId'],
        'value': {
          'uid': 'user-alice',
          'email': 'alice@example.com',
          'displayName': 'Alice',
          'isAnonymous': false,
          'token': 'refreshed-jwt-token-777',
        },
      });
      await pumpEventQueue();

      // authStateChanges does NOT emit duplicate on token refresh
      expect(authEvents, equals([null, 'user-alice']));
      // idTokenChanges DOES emit on token refresh
      expect(idTokenEvents, equals([null, 'user-alice', 'user-alice']));

      // 4. Sign out
      final signOutFuture = auth.signOut();
      await pumpEventQueue();

      final signOutOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signOut',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signOutOp['id'],
        'ok': true,
        'value': null,
      });
      await signOutFuture;
      await pumpEventQueue();

      expect(authEvents, equals([null, 'user-alice', null]));
      expect(idTokenEvents, equals([null, 'user-alice', 'user-alice', null]));

      await authSub.cancel();
      await tokenSub.cancel();
    });
  });

  group('Challenger: Snapshot Stream Re-evaluations Across Auth Transitions', () {
    test('document snapshot re-subscribes with mode: as on signIn and mode: anon on signOut', () async {
      final docRef = firestore.doc('users/alice');
      final receivedData = <Map<String, dynamic>?>[];

      final sub = docRef.snapshots(listenSource: ListenSource.defaultSource).listen((snap) {
        receivedData.add(snap.data());
      });
      await pumpEventQueue();

      // 1. Initial subscription sent with actAs: { mode: 'anon' }
      final initialSub = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-sub',
      );
      final initialSubId = initialSub['subId'] as String;
      expect(initialSub['sub']['actAs'], equals({'mode': 'anon'}));

      // Simulate snapshot reply for anon
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': initialSubId,
        'value': {
          'id': 'alice',
          'path': 'users/alice',
          'exists': true,
          'data': {'public': 'data'},
        },
      });
      await pumpEventQueue();
      expect(receivedData.length, equals(1));
      expect(receivedData.first?['public'], equals('data'));

      // 2. Sign in as Alice
      final signInFuture = auth.signInWithEmailAndPassword('alice@example.com', 'pass123');
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
            'uid': 'user-alice',
            'email': 'alice@example.com',
            'displayName': 'Alice',
          },
        },
      });
      await signInFuture;
      await pumpEventQueue();

      // Verify previous sub unsubscribed and new sub established with mode: as
      final unsubFrame = harness.sentMessages.firstWhere(
        (m) => m['type'] == 'worker-unsub' && m['subId'] == initialSubId,
      );
      expect(unsubFrame, isNotNull);

      final newSub = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-sub' && m['subId'] != initialSubId,
      );
      final newSubId = newSub['subId'] as String;
      expect(newSub['sub']['actAs'], equals({'mode': 'as', 'uid': 'user-alice'}));

      // Reply with authenticated snapshot
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': newSubId,
        'value': {
          'id': 'alice',
          'path': 'users/alice',
          'exists': true,
          'data': {'secret': 'alice-private'},
        },
      });
      await pumpEventQueue();
      expect(receivedData.length, equals(2));
      expect(receivedData.last?['secret'], equals('alice-private'));

      // 3. Sign out
      final signOutFuture = auth.signOut();
      await pumpEventQueue();
      final signOutOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signOut',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signOutOp['id'],
        'ok': true,
        'value': null,
      });
      await signOutFuture;
      await pumpEventQueue();

      final postSignOutSub = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-sub' && m['subId'] != newSubId,
      );
      expect(postSignOutSub['sub']['actAs'], equals({'mode': 'anon'}));

      await sub.cancel();
    });
  });
}
