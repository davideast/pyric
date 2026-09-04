import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import 'mock_bridge_helper.dart';

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform authPlatform;
  late PyricFirestorePlatform firestorePlatform;

  setUp(() async {
    setupMockFirebase();
    harness = MockBridgeHarness();
    client = harness.createClient();

    // Auto-respond to attach
    harness.channel.toServerController.stream.listen((raw) {
      if (raw is String && raw.contains('"type":"attach"')) {
        harness.ackAttach(clientSessionId: 'test-session-stress');
      }
    });

    authPlatform = PyricFirebaseAuthPlatform(bridgeClient: client);
    firestorePlatform = PyricFirestorePlatform(
      bridgeClient: client,
      credentialsProvider: authPlatform,
    );

    await client.connect();
    await pumpEventQueue();
  });

  tearDown(() async {
    await authPlatform.dispose();
    await firestorePlatform.terminate();
    await harness.dispose();
  });

  group('Empirical Challenger: Rapid Auth State Switching', () {
    test('50 rapid sequential auth transitions maintain exact lens state', () async {
      // Auto-reply to auth operations
      harness.channel.toServerController.stream.listen((raw) {
        if (raw is! String) return;
        if (raw.contains('auth.signInAnonymously')) {
          final id = RegExp(r'"id":"([^"]+)"').firstMatch(raw)?.group(1);
          if (id != null) {
            harness.sendToClient({
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': {
                'user': {
                  'uid': 'anon-user-1',
                  'isAnonymous': true,
                },
                'token': 'mock-anon-token',
              },
            });
          }
        } else if (raw.contains('auth.signInEmail') || raw.contains('auth-sign-in-custom-token')) {
          final id = RegExp(r'"id":"([^"]+)"').firstMatch(raw)?.group(1);
          final uidMatch = RegExp(r'"password":"password-for-([^"]+)"').firstMatch(raw);
          final uid = uidMatch?.group(1) ?? 'custom-user';
          if (id != null) {
            harness.sendToClient({
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': {
                'user': {
                  'uid': uid,
                  'isAnonymous': false,
                  'email': '$uid@example.com',
                },
                'token': 'jwt-$uid',
              },
            });
          }
        } else if (raw.contains('auth.signOut')) {
          final id = RegExp(r'"id":"([^"]+)"').firstMatch(raw)?.group(1);
          if (id != null) {
            harness.sendToClient({
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': {'ok': true},
            });
          }
        }
      });

      final lensHistory = <AuthLens>[];
      final sub = authPlatform.authLensChanges.listen(lensHistory.add);

      for (var i = 0; i < 25; i++) {
        // Anon sign in
        await authPlatform.signInAnonymously();
        expect(authPlatform.currentAuthLens, isA<AsUserLens>());
        expect((authPlatform.currentAuthLens as AsUserLens).uid, equals('anon-user-1'));
        expect(firestorePlatform.effectiveAuthLens['mode'], equals('as'));
        expect(firestorePlatform.effectiveAuthLens['uid'], equals('anon-user-1'));

        // Email sign in (switch user)
        await authPlatform.signInWithEmailAndPassword('user$i@example.com', 'password-for-user-$i');
        expect(authPlatform.currentAuthLens, isA<AsUserLens>());
        expect((authPlatform.currentAuthLens as AsUserLens).uid, equals('user-$i'));
        expect(firestorePlatform.effectiveAuthLens['mode'], equals('as'));
        expect(firestorePlatform.effectiveAuthLens['uid'], equals('user-$i'));

        // Sign out
        await authPlatform.signOut();
        expect(authPlatform.currentAuthLens, equals(AuthLens.anon));
        expect(firestorePlatform.effectiveAuthLens, equals({'mode': 'anon'}));
      }

      await pumpEventQueue();
      await sub.cancel();

      expect(authPlatform.currentAuthLens, equals(AuthLens.anon));
      expect(firestorePlatform.effectiveAuthLens, equals({'mode': 'anon'}));
      expect(lensHistory.length, greaterThanOrEqualTo(50));
    });
  });

  group('Empirical Challenger: Concurrent Operations During Auth Transitions', () {
    test('Concurrent reads and writes never observe corrupt or undefined actAs', () async {
      // Auto-respond to all worker-ops with success
      harness.channel.toServerController.stream.listen((raw) {
        if (raw is! String) return;
        if (raw.contains('"type":"worker-op"')) {
          final id = RegExp(r'"id":"([^"]+)"').firstMatch(raw)?.group(1);
          if (id != null) {
            harness.sendToClient({
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': {'exists': true, 'data': {}},
            });
          }
        }
      });

      final validUids = {'anon-uid', 'alice-uid', 'bob-uid'};

      // Rapidly toggle auth state in background
      var authSwitchingActive = true;
      final authFuture = () async {
        var cycle = 0;
        while (authSwitchingActive) {
          cycle++;
          if (cycle % 3 == 0) {
            authPlatform.currentUser = null;
          } else if (cycle % 3 == 1) {
            authPlatform.currentUser = PyricUserPlatform.fromWire(
              auth: authPlatform,
              client: client,
              data: {'uid': 'alice-uid', 'email': 'alice@example.com', 'isAnonymous': false},
            );
          } else {
            authPlatform.currentUser = PyricUserPlatform.fromWire(
              auth: authPlatform,
              client: client,
              data: {'uid': 'bob-uid', 'email': 'bob@example.com', 'isAnonymous': false},
            );
          }
          await Future<void>.delayed(const Duration(milliseconds: 2));
        }
      }();

      // Launch 60 concurrent document operations
      final operations = <Future<void>>[];
      for (var i = 0; i < 60; i++) {
        final docRef = firestorePlatform.doc('stress_docs/doc_$i');
        if (i % 3 == 0) {
          operations.add(docRef.get());
        } else if (i % 3 == 1) {
          operations.add(docRef.set({'count': i}));
        } else {
          operations.add(docRef.delete());
        }
      }

      await Future.wait(operations);
      authSwitchingActive = false;
      await authFuture;

      // Validate all sent operations have valid actAs
      final docOps = harness.sentMessages
          .where((m) => m['type'] == 'worker-op')
          .map((m) => m['op'] as Map<String, dynamic>)
          .where((op) => op['method'] != 'attach')
          .toList();

      expect(docOps.length, greaterThanOrEqualTo(60));
      for (final op in docOps) {
        final actAs = op['actAs'] as Map<String, dynamic>?;
        expect(actAs, isNotNull, reason: 'actAs must never be null on operation ${op['method']}');
        final mode = actAs!['mode'] as String?;
        expect(mode, isIn(['anon', 'as', 'admin']), reason: 'mode must be valid');
        if (mode == 'as') {
          final uid = actAs['uid'] as String?;
          expect(uid, isNotNull);
          expect(validUids.contains(uid), isTrue, reason: 'UID must be one of the known valid UIDs');
        }
      }
    });
  });

  group('Empirical Challenger: Unsubscription Cleanup & Leak Detection', () {
    test('Dynamic snapshot re-subscription cleanly cancels prior bridge subscriptions', () async {
      final docRef = firestorePlatform.doc('leak_test/doc_1');

      // Start listening to snapshots
      final snapshotSub = docRef.snapshots(listenSource: ListenSource.defaultSource).listen((snap) {});
      await pumpEventQueue();

      // Perform 5 auth switches
      for (var i = 0; i < 5; i++) {
        authPlatform.sendAuthChangesEvent(
          'default',
          PyricUserPlatform.fromWire(
            auth: authPlatform,
            client: client,
            data: {'uid': 'leak-user-$i', 'email': 'user$i@example.com', 'isAnonymous': false},
          ),
        );
        await pumpEventQueue();
      }

      // Explicitly cancel snapshot subscription
      await snapshotSub.cancel();
      await pumpEventQueue();

      // Filter frames to only document subscriptions (excluding internal authState/idToken subs)
      final docSubFrames = harness.sentMessages
          .where((m) => m['type'] == 'worker-sub')
          .where((m) => (m['sub'] as Map)['target'] is Map && (m['sub']['target'] as Map)['__ref'] == 'doc')
          .toList();
      final unsubFrames = harness.sentMessages
          .where((m) => m['type'] == 'worker-unsub')
          .toList();

      final subscribedDocIds = docSubFrames.map((m) => m['subId'] as String).toSet();
      final unsubscribedIds = unsubFrames.map((m) => m['subId'] as String).toSet();

      // Every registered document snapshot bridge subscription MUST have been unsubscribed
      final leakedIds = subscribedDocIds.difference(unsubscribedIds);
      expect(
        leakedIds,
        isEmpty,
        reason: 'Leaked document subscription IDs without worker-unsub: $leakedIds',
      );
    });

    test('Immediate cancellation before handshake does not leak subscription', () async {
      final freshHarness = MockBridgeHarness();
      final freshClient = freshHarness.createClient();
      final freshFirestore = PyricFirestorePlatform(bridgeClient: freshClient);
      final docRef = freshFirestore.doc('leak_test/instant_cancel');

      // Listen and IMMEDIATELY cancel in the same microtask
      final sub = docRef.snapshots(listenSource: ListenSource.defaultSource).listen((_) {});
      await sub.cancel();

      // Connect bridge afterward and pump events
      freshHarness.ackAttach();
      await pumpEventQueue();
      await Future<void>.delayed(const Duration(milliseconds: 50));

      final subFrames = freshHarness.sentMessages
          .where((m) => m['type'] == 'worker-sub')
          .toList();
      final unsubFrames = freshHarness.sentMessages
          .where((m) => m['type'] == 'worker-unsub')
          .toList();

      final subscribedIds = subFrames.map((m) => m['subId'] as String).toSet();
      final unsubscribedIds = unsubFrames.map((m) => m['subId'] as String).toSet();

      final leakedIds = subscribedIds.difference(unsubscribedIds);
      expect(
        leakedIds,
        isEmpty,
        reason: 'Immediate cancel caused dangling subscription: $leakedIds',
      );

      await freshFirestore.terminate();
      await freshHarness.dispose();
    });
  });
}
