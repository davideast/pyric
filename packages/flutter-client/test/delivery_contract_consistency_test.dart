import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_database.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/pyric_firestore.dart'
    hide AuthLens, PyricAuthCredentialsProvider;

import 'auth/mock_bridge_helper.dart' show setupMockFirebase;
import 'helpers/fake_bridge.dart';
import 'helpers/rtdb_test_harness.dart' show MockRtdbCredentialsProvider;

class _ReplayingCredentialsProvider implements PyricAuthCredentialsProvider {
  AuthLens _lens;
  final StreamController<AuthLens> _controller =
      StreamController<AuthLens>.broadcast();

  _ReplayingCredentialsProvider(this._lens);

  @override
  AuthLens get currentAuthLens => _lens;

  @override
  Stream<AuthLens> get authLensChanges {
    return Stream<AuthLens>.multi((listener) {
      listener.add(_lens);
      final sub = _controller.stream.listen(
        listener.addSync,
        onError: listener.addErrorSync,
        onDone: listener.closeSync,
      );
      listener.onCancel = () {
        unawaited(sub.cancel());
      };
    }, isBroadcast: true);
  }

  void setLens(AuthLens next) {
    _lens = next;
    _controller.add(next);
  }

  Future<void> dispose() => _controller.close();
}

void main() {
  late FakeBridge bridge;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricDatabase db;

  setUp(() async {
    setupMockFirebase();
    bridge = FakeBridge();
    client = PyricBridgeClient(
      channelFactory: bridge.connect,
      reconnectDelay: (_) => Duration.zero,
    );
    auth = PyricFirebaseAuthPlatform(bridgeClient: client);
    db = PyricDatabase(bridgeClient: client, credentialsProvider: auth);
    await client.connect();
    await bridge.waitForSubTarget('authState');
    await bridge.waitForSubTarget('idToken');
  });

  tearDown(() async {
    await client.disconnect();
    await auth.dispose();
  });

  List<Map<String, dynamic>> liveSubsFor(String path) {
    final unsubbed = bridge.ofType('worker-unsub').map((f) => f['subId']).toSet();
    return bridge
        .subsFor(path)
        .where((f) => !unsubbed.contains(f['subId']))
        .toList();
  }

  group('F6, F7, F8 & F9 (D7/D9): lens, presence, and auth consistency', () {
    test('F6: authLensChanges, RTDB listener, and debug controller stay on impersonated lens', () async {
      auth.switchAuthLens(AuthLens.admin);
      expect(auth.currentAuthLens, AuthLens.admin);

      final lenses = <AuthLens>[];
      final lensGate = CountGate();
      final lensSub = auth.authLensChanges.listen((lens) {
        lenses.add(lens);
        lensGate.tick();
      });
      final debugController = PyricDebugController(
        authPlatform: auth,
        bridgeClient: client,
      );
      final rtdbSub = db.ref('rooms/b').onValue.listen((_) {}, onError: (_) {});
      await bridge.waitForSubsFor('/rooms/b', count: 1);
      await lensGate.atLeast(1);

      final authSubId = bridge
          .ofType('worker-sub')
          .firstWhere((f) => (f['sub'] as Map)['target'] == 'authState')['subId'];
      final authGate = CountGate();
      final authSub = auth.authStateChanges().skip(1).listen((_) => authGate.tick());
      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': authSubId,
        'value': {'uid': 'u1'},
      });
      await authGate.atLeast(1);
      await flushMicrotasks();

      expect(lenses, [AuthLens.admin]);
      expect(debugController.currentLens, AuthLens.admin);
      expect(bridge.subsFor('/rooms/b'), hasLength(1));
      expect(
        (liveSubsFor('/rooms/b').single['sub'] as Map)['actAs'],
        AuthLens.admin.toMap(),
      );

      debugController.dispose();
      await authSub.cancel();
      await rtdbSub.cancel();
      await lensSub.cancel();
    });

    test('F7: .info/connected delivers false and true before goOnline() returns and after rtdb.goOnline op', () async {
      final values = <Object?>[];
      final initialGate = CountGate();
      var armPresence = false;
      final sub = db.ref('.info/connected').onValue.listen((e) {
        values.add(e.snapshot.value);
        initialGate.tick();
        if (armPresence && e.snapshot.value == true) {
          db.ref('status/u1').onDisconnect().set('offline').ignore();
        }
      });
      await initialGate.atLeast(1);
      expect(values, [true]);
      values.clear();
      armPresence = true;

      bridge.onFrame = (frame) {
        if (frame['type'] == 'worker-op') {
          final socket = bridge.current;
          scheduleMicrotask(() => socket.deliver({
                'type': 'worker-res',
                'id': frame['id'],
                'ok': true,
                'value': null,
              }));
        }
      };

      db.goOffline().ignore();
      db.goOnline().ignore();
      final getter = db.connectionInfo.isConnected;
      final mark = values.length;
      await flushMicrotasks();

      expect(getter, isTrue);
      expect(values.take(mark).toList(), [false, true]);
      expect(values.skip(mark).toList(), isEmpty);

      final opMethods = bridge
          .ofType('worker-op')
          .map((f) => (f['op'] as Map)['method'] as String)
          .toList();
      expect(
        opMethods,
        containsAllInOrder(['rtdb.goOffline', 'rtdb.goOnline', 'rtdb.onDisconnectSet']),
      );
      await sub.cancel();
    });

    test('F8: stale authState and idToken observer frames after signOut do not regress currentUser', () async {
      final authSubId = bridge
          .ofType('worker-sub')
          .firstWhere((f) => (f['sub'] as Map)['target'] == 'authState')['subId'];
      final idTokenSubId = bridge
          .ofType('worker-sub')
          .firstWhere((f) => (f['sub'] as Map)['target'] == 'idToken')['subId'];
      final seenAuth = <String?>[];
      final seenGate = CountGate();
      final sub = auth.authStateChanges().listen((u) {
        seenAuth.add(u?.uid);
        seenGate.tick();
      });
      await seenGate.atLeast(1);

      final signIn = auth.signInAnonymously();
      final signInOp = (await bridge.waitForOpsNamed('auth.signInAnonymously')).last;
      bridge.current.deliver({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {'user': {'uid': 'u1'}},
      });
      await signIn;

      final signOut = auth.signOut();
      final signOutOp = (await bridge.waitForOpsNamed('auth.signOut')).last;
      bridge.current.deliver({
        'type': 'worker-res',
        'id': signOutOp['id'],
        'ok': true,
        'value': null,
      });
      await signOut;

      await seenGate.atLeast(3);
      expect(auth.currentUser, isNull);
      final mark = seenAuth.length;
      final gateBeforeStale = seenGate.count;

      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': authSubId,
        'value': {'uid': 'u1'},
      });
      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': idTokenSubId,
        'value': {'uid': 'u1'},
      });
      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': authSubId,
        'value': null,
      });
      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': idTokenSubId,
        'value': null,
      });
      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': authSubId,
        'value': {'uid': 'u2'},
      });
      await seenGate.atLeast(gateBeforeStale + 1);

      expect(seenAuth.skip(mark).toList(), ['u2']);
      expect(auth.currentUser?.uid, 'u2');
      await sub.cancel();
    });

    test('F8: reload() completing after signOut() does not restore signed-out user', () async {
      final signIn = auth.signInAnonymously();
      final signInOp = (await bridge.waitForOpsNamed('auth.signInAnonymously')).last;
      bridge.current.deliver({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {'user': {'uid': 'u1'}},
      });
      await signIn;
      final user = auth.currentUser!;

      final reloadFuture = user.reload();
      final reloadOp = (await bridge.waitForOpsNamed('auth.getCurrentUser')).last;

      final signOutFuture = auth.signOut();
      final signOutOp = (await bridge.waitForOpsNamed('auth.signOut')).last;
      bridge.current.deliver({
        'type': 'worker-res',
        'id': signOutOp['id'],
        'ok': true,
        'value': null,
      });
      await signOutFuture;
      expect(auth.currentUser, isNull);

      bridge.current.deliver({
        'type': 'worker-res',
        'id': reloadOp['id'],
        'ok': true,
        'value': {'uid': 'u1', 'displayName': 'Stale'},
      });
      await reloadFuture;
      expect(auth.currentUser, isNull);
    });

    test('F9: Firestore and RTDB handle both non-replaying and replaying credentials providers', () async {
      final nonReplaying = MockRtdbCredentialsProvider();
      final fsNonReplaying = PyricFirestorePlatform(
        bridgeClient: client,
        credentialsProvider: nonReplaying,
      );
      final sub1 = fsNonReplaying
          .doc('rooms/p')
          .snapshots(listenSource: ListenSource.defaultSource)
          .listen((_) {}, onError: (_) {});
      await bridge.waitForSubsFor('rooms/p', count: 1);

      nonReplaying.setLens(AuthLens.admin);
      await bridge.waitForSubsFor('rooms/p', count: 2);
      expect(
        (bridge.lastSubFor('rooms/p')['sub'] as Map)['actAs'],
        AuthLens.admin.toMap(),
      );
      await sub1.cancel();
      await nonReplaying.dispose();

      final replaying = _ReplayingCredentialsProvider(AuthLens.admin);
      final fsReplaying = PyricFirestorePlatform(
        bridgeClient: client,
        credentialsProvider: replaying,
      );
      final dbReplaying = PyricDatabase(
        bridgeClient: client,
        credentialsProvider: replaying,
      );
      final sub2 = fsReplaying
          .doc('rooms/q')
          .snapshots(listenSource: ListenSource.defaultSource)
          .listen((_) {}, onError: (_) {});
      final sub3 = dbReplaying.ref('rooms/q').onValue.listen((_) {}, onError: (_) {});
      await bridge.waitForSubsFor('rooms/q', count: 1);
      await bridge.waitForSubsFor('/rooms/q', count: 1);
      await flushMicrotasks();

      expect(bridge.subsFor('rooms/q'), hasLength(1));
      expect(bridge.subsFor('/rooms/q'), hasLength(1));

      await sub2.cancel();
      await sub3.cancel();
      await replaying.dispose();
    });
  });
}
