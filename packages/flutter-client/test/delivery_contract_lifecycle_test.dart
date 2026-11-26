import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_database.dart';
import 'package:pyric_firestore/pyric_firestore.dart'
    hide AuthLens, PyricAuthCredentialsProvider;

import 'auth/mock_bridge_helper.dart' show setupMockFirebase;
import 'helpers/fake_bridge.dart';

void main() {
  late FakeBridge bridge;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricFirestorePlatform firestore;
  late PyricDatabase db;

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

  Future<void> waitForState(BridgeConnectionState target) {
    if (client.connectionState == target) return Future.value();
    return client.connectionStates.firstWhere((s) => s == target).then((_) {});
  }

  group('F1 & F2 (D7/D10): immediate re-listen after cancel', () {
    test('F1: Firestore doc stream re-listened right after cancel still delivers', () async {
      final stream = firestore
          .doc('rooms/a')
          .snapshots(listenSource: ListenSource.defaultSource);
      final received = <DocumentSnapshotPlatform>[];
      final receivedGate = CountGate();

      var sub = stream.listen((_) {}, onError: (_) {});
      await bridge.waitForSubsFor('rooms/a', count: 1);

      sub.cancel().ignore();
      sub = stream.listen((snap) {
        received.add(snap);
        receivedGate.tick();
      }, onError: (_) {});
      await flushMicrotasks();

      final live = liveSubsFor('rooms/a');
      expect(live, hasLength(1));
      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': live.single['subId'],
        'value': {'path': 'rooms/a', 'exists': true, 'data': {'n': 1}},
      });
      await receivedGate.atLeast(1);
      expect(received.single.data(), {'n': 1});
      await sub.cancel();
    });

    test('F2: RTDB onValue re-listened after cancel delivers and leaves no leak on final cancel', () async {
      final stream = db.ref('rooms/a').onValue;
      final received = <PyricDatabaseEvent>[];
      final receivedGate = CountGate();

      var sub = stream.listen((_) {}, onError: (_) {});
      await bridge.waitForSubsFor('/rooms/a', count: 1);

      sub.cancel().ignore();
      sub = stream.listen((event) {
        received.add(event);
        receivedGate.tick();
      }, onError: (_) {});
      await flushMicrotasks();

      final live = liveSubsFor('/rooms/a');
      expect(live, hasLength(1));
      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': live.single['subId'],
        'value': {'key': 'a', 'exists': true, 'value': 1},
      });
      await receivedGate.atLeast(1);
      expect(received.single.snapshot.value, 1);

      await sub.cancel();
      await flushMicrotasks();
      expect(liveSubsFor('/rooms/a'), isEmpty);

      final beforeLensChange = bridge.subsFor('/rooms/a').length;
      auth.switchAuthLens(AuthLens.admin);
      await flushMicrotasks();
      expect(bridge.subsFor('/rooms/a'), hasLength(beforeLensChange));
      expect(liveSubsFor('/rooms/a'), isEmpty);
    });

    test('F2: RTDB onChildAdded re-listened then cancelled leaves no worker-sub live or restored', () async {
      final stream = db.ref('rooms').onChildAdded;
      var sub = stream.listen((_) {}, onError: (_) {});
      await bridge.waitForSubsFor('/rooms', count: 1);

      sub.cancel().ignore();
      sub = stream.listen((_) {}, onError: (_) {});
      await flushMicrotasks();
      await sub.cancel();
      await flushMicrotasks();
      expect(liveSubsFor('/rooms'), isEmpty);

      final reattached = waitForState(BridgeConnectionState.attached);
      bridge.current.drop();
      await bridge.waitForSocketCount(2);
      await reattached;
      final resent = bridge.current.sentOfType('worker-sub').where((f) {
        final target = (f['sub'] as Map)['target'];
        return target is Map && target['path'] == '/rooms';
      }).toList();
      expect(resent, isEmpty);
    });

    test('F2/D10: direct subscribeRtdb and onValue cancel while interrupted leave restore set synchronously', () async {
      final rawStream = db.subscribeRtdb('/rooms/raw');
      final rawValues = <dynamic>[];
      final rawGate = CountGate();

      var rawSub = rawStream.listen((_) {}, onError: (_) {});
      await bridge.waitForSubsFor('/rooms/raw', count: 1);

      rawSub.cancel().ignore();
      rawSub = rawStream.listen((v) {
        rawValues.add(v);
        rawGate.tick();
      }, onError: (_) {});
      await flushMicrotasks();

      expect(liveSubsFor('/rooms/raw'), hasLength(1));
      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': liveSubsFor('/rooms/raw').single['subId'],
        'value': {'exists': true, 'value': 'ok'},
      });
      await rawGate.atLeast(1);
      expect(rawValues, hasLength(1));

      final valueSub = db.ref('rooms/interrupted').onValue.listen((_) {}, onError: (_) {});
      await bridge.waitForSubsFor('/rooms/interrupted', count: 1);

      bridge.refuseConnections = true;
      final interrupted = waitForState(BridgeConnectionState.interrupted);
      bridge.current.drop();
      await interrupted;

      rawSub.cancel().ignore();
      valueSub.cancel().ignore();
      bridge.refuseConnections = false;
      final reattached = waitForState(BridgeConnectionState.attached);
      await bridge.waitForSocketCount(2);
      await reattached;

      final resent = bridge.current.sentOfType('worker-sub').where((f) {
        final target = (f['sub'] as Map)['target'];
        return target is Map &&
            (target['path'] == '/rooms/raw' ||
                target['path'] == '/rooms/interrupted');
      }).toList();
      expect(resent, isEmpty);
    });
  });

  group('F3, F4 & F5 (D6): close semantics', () {
    test('F3: live Firestore and RTDB listeners with onError raise no uncaught zone errors at disconnect', () async {
      final uncaught = <Object>[];
      final errors = <Object>[];
      await runZonedGuarded(() async {
        firestore
            .doc('rooms/a')
            .snapshots(listenSource: ListenSource.defaultSource)
            .listen((_) {}, onError: errors.add);
        db.ref('rooms/a').onValue.listen((_) {}, onError: errors.add);
        await bridge.waitForSubsFor('rooms/a', count: 1);
        await bridge.waitForSubsFor('/rooms/a', count: 1);

        await client.disconnect();
        await flushMicrotasks();
      }, (e, _) => uncaught.add(e));

      expect(errors, hasLength(2));
      expect(uncaught, isEmpty);
    });

    test('F4 & F5: every subscription ends once before disconnect() completes and delivers nothing after', () async {
      final ended = <String, int>{};
      final lateEvents = <String>[];
      var closed = false;

      void track(String name, Stream<dynamic> stream) {
        ended[name] = 0;
        stream.listen(
          (_) {
            if (closed) lateEvents.add('$name data');
          },
          onError: (_) {
            if (closed) lateEvents.add('$name error');
          },
          onDone: () {
            ended[name] = ended[name]! + 1;
            if (closed) lateEvents.add('$name done');
          },
        );
      }

      track('connectionStates', client.connectionStates);
      track('remoteLensStream', client.remoteLensStream);
      track('denialStream', client.denialStream);
      track('.info/connected', db.ref('.info/connected').onValue);
      track('rtdb onValue', db.ref('rooms/a').onValue);
      track('rtdb onChildAdded', db.ref('rooms').onChildAdded);
      track(
        'firestore doc',
        firestore
            .doc('rooms/a')
            .snapshots(listenSource: ListenSource.defaultSource),
      );
      track('authStateChanges', auth.authStateChanges());
      track('idTokenChanges', auth.idTokenChanges());
      track('userChanges', auth.userChanges());
      track('authLensChanges', auth.authLensChanges);

      await bridge.waitForSubsFor('rooms/a', count: 1);
      await bridge.waitForSubsFor('/rooms/a', count: 1);
      await bridge.waitForSubsFor('/rooms', count: 1);
      await flushMicrotasks();

      await client.disconnect();
      closed = true;
      await flushMicrotasks();

      expect(ended.values, everyElement(1), reason: 'ended counts: $ended');
      expect(lateEvents, isEmpty);
    });

    test('F4: Firestore listener created while network is disabled also ends before disconnect() returns', () async {
      await firestore.disableNetwork();
      var doneCount = 0;
      var closed = false;
      var lateDone = false;
      firestore
          .doc('rooms/offline')
          .snapshots(listenSource: ListenSource.defaultSource)
          .listen(
            (_) {},
            onError: (_) {},
            onDone: () {
              doneCount++;
              if (closed) lateDone = true;
            },
          );
      await flushMicrotasks();

      await client.disconnect();
      closed = true;
      await flushMicrotasks();

      expect(doneCount, 1);
      expect(lateDone, isFalse);
    });

    test('F4: policy close (1008) also ends every subscription once', () async {
      final ended = <String, int>{};
      final doneGate = CountGate();

      void track(String name, Stream<dynamic> stream) {
        ended[name] = 0;
        stream.listen(
          (_) {},
          onError: (_) {},
          onDone: () {
            ended[name] = ended[name]! + 1;
            doneGate.tick();
          },
        );
      }

      track('connectionStates', client.connectionStates);
      track('remoteLensStream', client.remoteLensStream);
      track('denialStream', client.denialStream);
      track('.info/connected', db.ref('.info/connected').onValue);
      track('rtdb onValue', db.ref('rooms/a').onValue);
      track(
        'firestore doc',
        firestore
            .doc('rooms/a')
            .snapshots(listenSource: ListenSource.defaultSource),
      );
      track('authStateChanges', auth.authStateChanges());
      track('authLensChanges', auth.authLensChanges);

      await bridge.waitForSubsFor('rooms/a', count: 1);
      await bridge.waitForSubsFor('/rooms/a', count: 1);

      bridge.current.drop(code: 1008);
      await doneGate.atLeast(ended.length);
      expect(ended.values, everyElement(1), reason: 'ended counts: $ended');
    });
  });

  group('F10 (D4) & D8: sink refusal hold and cross-subscription order', () {
    test('F10: a frame refused by a throwing sink is held and sent after re-attach', () async {
      final closing = bridge.current;
      closing.drop(code: 1006);

      Object? error;
      var settled = false;
      final opFuture = client.op('setDoc', {'path': 'rooms/a'});
      opFuture.then((_) => settled = true, onError: (Object e) {
        error = e;
        settled = true;
      });
      await flushMicrotasks(2);

      expect(
        closing.sentAfterClose.where((f) => f['type'] == 'worker-op'),
        hasLength(1),
      );
      expect(settled, isFalse, reason: 'refused frame must be held, not failed: $error');

      final sent = (await bridge.waitForOpsNamed('setDoc')).single;
      bridge.current.deliver({
        'type': 'worker-res',
        'id': sent['id'],
        'ok': true,
        'value': 'ok',
      });
      expect(await opFuture, 'ok');
    });

    test('F10: refused op fails with close error on policy close (1008)', () async {
      final closing = bridge.current;
      closing.drop(code: 1008);

      await expectLater(
        client.op('setDoc', {'path': 'rooms/policy'}),
        throwsA(
          isA<PyricBridgeException>()
              .having((e) => e.code, 'code', 'unavailable')
              .having((e) => e.message, 'message', contains('closed')),
        ),
      );
    });

    test('F10: refusal during sendHeld preserves FIFO admission order on the next attach', () async {
      bridge.refuseConnections = true;
      final interrupted = waitForState(BridgeConnectionState.interrupted);
      bridge.current.drop();
      await interrupted;

      final first = client.op('setDoc', {'path': 'rooms/1'});
      final second = client.op('setDoc', {'path': 'rooms/2'});

      // Drop socket 2 right when the first held op is attempted, forcing refusal.
      var droppedSecond = false;
      bridge.onFrame = (frame) {
        if (!droppedSecond &&
            bridge.sockets.length == 2 &&
            frame['type'] == 'worker-sub' &&
            (frame['sub'] as Map)['target'] == 'idToken') {
          droppedSecond = true;
          bridge.current.drop(code: 1006);
        }
      };

      bridge.refuseConnections = false;
      await bridge.waitForSocketCount(3);
      final sentOps = await bridge.waitForOpsNamed('setDoc', count: 2);
      expect(
        sentOps.map((f) => (f['op'] as Map)['path']).toList(),
        ['rooms/1', 'rooms/2'],
      );
      for (final frame in sentOps) {
        bridge.current.deliver({
          'type': 'worker-res',
          'id': frame['id'],
          'ok': true,
          'value': (frame['op'] as Map)['path'],
        });
      }
      expect(await Future.wait([first, second]), ['rooms/1', 'rooms/2']);
    });

    test('F10: jsonEncode failure is not treated as a transport refusal and fails immediately', () async {
      await expectLater(
        client.op('setDoc', {'bad': Object()}),
        throwsA(isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable')),
      );
    });

    test('F10: re-entrant disconnect inside throwing sink settles dispatch and sendHeld cleanly', () async {
      bridge.onFrame = (frame) {
        if (frame['type'] == 'worker-op') {
          unawaited(client.disconnect());
          throw StateError('sink closed during dispatch');
        }
      };
      await expectLater(
        client.op('setDoc', {'path': 'rooms/reentrant-dispatch'}),
        throwsA(isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable')),
      );

      final bridge2 = FakeBridge();
      final client2 = PyricBridgeClient(
        channelFactory: bridge2.connect,
        reconnectDelay: (_) => Duration.zero,
      );
      await client2.connect();
      bridge2.refuseConnections = true;
      final interrupted = Completer<void>();
      final stateSub = client2.connectionStates.listen((s) {
        if (s == BridgeConnectionState.interrupted && !interrupted.isCompleted) {
          interrupted.complete();
        }
      });
      bridge2.current.drop();
      await interrupted.future;
      await stateSub.cancel();

      final heldFuture = client2.op('setDoc', {'path': 'rooms/reentrant-held'});
      bridge2.onFrame = (frame) {
        if (frame['type'] == 'worker-op') {
          unawaited(client2.disconnect());
          throw StateError('sink closed during sendHeld');
        }
      };
      bridge2.refuseConnections = false;

      await expectLater(
        heldFuture,
        throwsA(isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable')),
      );
      await client2.disconnect();
    });

    test('D8: Auth, RTDB child, and Firestore doc keep frame arrival order across subscriptions', () async {
      auth.switchAuthLens(AuthLens.admin);
      final order = <String>[];
      final orderGate = CountGate();

      final childSub = db.ref('rooms').onChildAdded.listen((e) {
        order.add('rtdb child ${e.snapshot.key}');
        orderGate.tick();
      });
      final docSub = firestore
          .doc('rooms/a')
          .snapshots(listenSource: ListenSource.defaultSource)
          .listen((_) {
        order.add('firestore doc');
        orderGate.tick();
      });
      final authSub = auth.userChanges().skip(1).listen((u) {
        order.add('auth ${u?.uid}');
        orderGate.tick();
      });

      await bridge.waitForSubsFor('/rooms', count: 1);
      await bridge.waitForSubsFor('rooms/a', count: 1);
      await flushMicrotasks();

      final authSubId = bridge
          .ofType('worker-sub')
          .firstWhere((f) => (f['sub'] as Map)['target'] == 'authState')['subId'];

      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': authSubId,
        'value': {'uid': 'u1', 'displayName': 'n'},
      });
      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': liveSubsFor('/rooms').single['subId'],
        'value': {
          'key': 'rooms',
          'exists': true,
          'value': {'x': 1},
          'children': [
            {'key': 'x', 'exists': true, 'value': 1},
          ],
        },
      });
      bridge.current.deliver({
        'type': 'worker-snap',
        'subId': liveSubsFor('rooms/a').single['subId'],
        'value': {'path': 'rooms/a', 'exists': true, 'data': {'n': 1}},
      });

      await orderGate.atLeast(3);
      expect(order, ['auth u1', 'rtdb child x', 'firestore doc']);

      await childSub.cancel();
      await docSub.cancel();
      await authSub.cancel();
    });
  });
}
