import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/src/transport/bridge_client.dart';

import 'helpers/fake_bridge.dart';

// ADR-0019 decision 7, as amended 2026-10-14: an operation issued while the
// client is not attached is held, then sent once after the whole restore, or
// fails once when the hold deadline passes.
const _notRestored =
    'The bridge connection was not restored within 10 seconds. The request was not sent.';

void main() {
  late FakeBridge bridge;
  final clients = <PyricBridgeClient>[];

  PyricBridgeClient createClient({
    bool retryInitialConnection = false,
    Duration retryDelay = Duration.zero,
    Duration attachTimeout = const Duration(seconds: 5),
    Duration? heartbeatInterval,
    Duration? livenessTimeout,
  }) {
    final client = PyricBridgeClient(
      channelFactory: bridge.connect,
      retryInitialConnection: retryInitialConnection,
      reconnectDelay: (_) => retryDelay,
      attachTimeout: attachTimeout,
    );
    if (heartbeatInterval != null) client.heartbeatInterval = heartbeatInterval;
    if (livenessTimeout != null) client.livenessTimeout = livenessTimeout;
    clients.add(client);
    return client;
  }

  /// Attached, then dropped with the bridge refusing new connections: the
  /// client is `interrupted` until the test sets `refuseConnections` back.
  Future<PyricBridgeClient> attachedThenDropped() async {
    final client = createClient();
    await client.connect();
    bridge.refuseConnections = true;
    bridge.current.drop();
    await until(() => client.connectionState == BridgeConnectionState.interrupted);
    return client;
  }

  Iterable<Map<String, dynamic>> opsNamed(String method) =>
      bridge.ofType('worker-op').where((f) => (f['op'] as Map)['method'] == method);

  void reply(Map<String, dynamic> frame, dynamic value) => bridge.current
      .deliver({'type': 'worker-res', 'id': frame['id'], 'ok': true, 'value': value});

  setUp(() {
    bridge = FakeBridge();
  });

  tearDown(() async {
    for (final client in clients) {
      await client.disconnect();
    }
    clients.clear();
  });

  test('a pending operation fails once with unavailable on a drop and is never re-sent', () async {
    final client = createClient();
    await client.connect();

    final pending = client.op('setDoc', {'path': 'rooms/a'});
    final failure = expectLater(
      pending,
      throwsA(isA<PyricBridgeException>()
          .having((e) => e.code, 'code', 'unavailable')
          .having((e) => e.message, 'message', contains('connection was lost'))),
    );
    await settle();
    final sentId = bridge.opNamed('setDoc')['id'];

    bridge.current.drop();
    await failure;
    await until(() => client.isConnected);

    final resent = bridge.ofType('worker-op').where((f) => f['id'] == sentId);
    expect(resent, hasLength(1));
  });

  test('re-attaches with the session id from the first attach-ack and re-sends live listens', () async {
    final client = createClient();
    final values = <dynamic>[];
    final errors = <Object>[];
    var closed = false;
    client
        .subscribe({'__ref': 'doc', 'path': 'rooms/a'})
        .listen(values.add, onError: errors.add, onDone: () => closed = true);
    await until(() => bridge.ofType('worker-sub').isNotEmpty);

    final firstSub = bridge.lastSubFor('rooms/a');
    bridge.current.deliver({
      'type': 'worker-snap',
      'subId': firstSub['subId'],
      'value': {'path': 'rooms/a', 'exists': true, 'data': {'n': 1}},
    });
    await until(() => values.length == 1);

    bridge.current.drop();
    await until(() => bridge.ofType('attach').length == 2);
    await until(() => client.isConnected);

    final reattach = bridge.ofType('attach').last;
    expect(reattach['clientSessionId'], 'session-1');
    final restoredSub = bridge.lastSubFor('rooms/a');
    expect(restoredSub['subId'], firstSub['subId']);
    expect(identical(restoredSub, firstSub), isFalse);

    bridge.current.deliver({
      'type': 'worker-snap',
      'subId': restoredSub['subId'],
      'value': {'path': 'rooms/a', 'exists': true, 'data': {'n': 2}},
    });
    await until(() => values.length == 2);
    expect((values.last as Map)['data'], {'n': 2});
    expect(errors, isEmpty);
    expect(closed, isFalse);
  });

  test('a restored value equal to the last one is not raised to a listener without metadata changes', () async {
    final client = createClient();
    final values = <dynamic>[];
    client.subscribeRaw({'target': 'authState'}).listen(values.add, onError: (_) {});
    await until(() => bridge.ofType('worker-sub').isNotEmpty);
    final subId = bridge.ofType('worker-sub').last['subId'];
    bridge.current.deliver({'type': 'worker-snap', 'subId': subId, 'value': {'uid': 'u1'}});
    await until(() => values.length == 1);

    bridge.current.drop();
    await until(() => bridge.ofType('worker-sub').length == 2);
    bridge.current.deliver({'type': 'worker-snap', 'subId': subId, 'value': {'uid': 'u1'}});
    await settle();
    expect(values, hasLength(1));

    bridge.current.deliver({'type': 'worker-snap', 'subId': subId, 'value': {'uid': 'u2'}});
    await until(() => values.length == 2);
  });

  test('a listener with metadata changes receives a gap marker on the drop and the restored snapshot after', () async {
    final client = createClient();
    final values = <dynamic>[];
    client
        .subscribe({'__ref': 'query', 'path': 'rooms'}, includeMetadataChanges: true)
        .listen(values.add, onError: (_) {});
    await until(() => bridge.ofType('worker-sub').isNotEmpty);
    final subId = bridge.lastSubFor('rooms')['subId'];
    final snapshot = {'docs': [{'path': 'rooms/a', 'exists': true, 'data': {'n': 1}}]};
    bridge.current.deliver({'type': 'worker-snap', 'subId': subId, 'value': snapshot});
    await until(() => values.length == 1);

    bridge.current.drop();
    await until(() => values.length == 2);
    expect(values[1], isA<BridgeSubscriptionGap>());

    await until(() => bridge.ofType('worker-sub').length == 2);
    bridge.current.deliver({'type': 'worker-snap', 'subId': subId, 'value': snapshot});
    await until(() => values.length == 3);
    expect(values[2], snapshot);
  });

  test('the first connection retries when asked to; an operation issued during a failed attempt is held and sent once', () async {
    bridge.refuseConnections = true;
    final client = createClient(retryInitialConnection: true);
    final values = <dynamic>[];
    client.subscribe({'__ref': 'doc', 'path': 'rooms/a'}).listen(values.add, onError: (_) {});

    final write = client.op('setDoc', {'path': 'rooms/a'});
    await until(() => bridge.connectCalls >= 2);
    expect(client.isDisposed, isFalse);
    expect(bridge.ofType('worker-op'), isEmpty);

    bridge.refuseConnections = false;
    await until(() => opsNamed('setDoc').isNotEmpty);
    reply(bridge.opNamed('setDoc'), 'done');
    expect(await write, 'done');
    expect(opsNamed('setDoc'), hasLength(1));

    final sub = bridge.lastSubFor('rooms/a');
    bridge.current.deliver({
      'type': 'worker-snap',
      'subId': sub['subId'],
      'value': {'path': 'rooms/a', 'exists': false},
    });
    await until(() => values.length == 1);
  });

  test('without retryInitialConnection the first failed attempt closes the client', () async {
    bridge.refuseConnections = true;
    final client = createClient();
    await expectLater(
      client.connect(),
      throwsA(isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable')),
    );
    expect(client.isDisposed, isTrue);
    expect(bridge.sockets, isEmpty);
  });

  test('a policy close (1008) closes the client instead of reconnecting', () async {
    final client = createClient();
    await client.connect();
    bridge.current.drop(code: 1008);
    await until(() => client.isDisposed);
    await settle();
    expect(bridge.ofType('attach'), hasLength(1));
  });

  test('a replaced host runs the Auth restore before any listen is re-sent', () async {
    final client = createClient();
    final restoredWith = <String>[];
    client.restoreAuth = (op) async {
      restoredWith.add('called');
      await op('auth.restorePortSession', {'uid': 'u1', 'tenantId': null});
    };
    client.subscribe({'__ref': 'doc', 'path': 'rooms/a'}).listen((_) {}, onError: (_) {});
    await until(() => bridge.ofType('worker-sub').isNotEmpty);

    bridge.current.drop();
    await until(() => bridge.ofType('worker-sub').length == 2);
    expect(restoredWith, isEmpty, reason: 'same host keeps the session user');

    bridge.hostInstanceId = 'host-b';
    bridge.current.drop();
    await until(() => bridge.ofType('worker-op')
        .any((f) => (f['op'] as Map)['method'] == 'auth.restorePortSession'));
    final restoreOp = bridge.opNamed('auth.restorePortSession');
    expect((restoreOp['op'] as Map)['uid'], 'u1');
    expect(bridge.ofType('worker-sub'), hasLength(2),
        reason: 'listens wait for the Auth restore');

    bridge.current.deliver({'type': 'worker-res', 'id': restoreOp['id'], 'ok': true, 'value': {'uid': 'u1'}});
    await until(() => bridge.ofType('worker-sub').length == 3);
    final frames = bridge.frames;
    expect(
      frames.indexOf(restoreOp) < frames.indexOf(bridge.ofType('worker-sub').last),
      isTrue,
    );
  });

  test('reconnect delays follow the bounded jittered schedule', () {
    final low = math.Random(1);
    final expectedBase = [250, 500, 1000, 2000, 4000, 5000, 5000, 5000];
    for (var attempt = 0; attempt < expectedBase.length; attempt++) {
      final base = expectedBase[attempt];
      for (var sample = 0; sample < 20; sample++) {
        final delay = bridgeReconnectDelay(attempt, low).inMilliseconds;
        expect(delay, greaterThanOrEqualTo(base));
        expect(delay, lessThanOrEqualTo(math.min(5000, base + math.min(250, base ~/ 10))));
      }
    }
    expect(bridgeReconnectDelay(60, low).inMilliseconds, lessThanOrEqualTo(5000));
  });

  test('before the first attach, an operation waits for the next scheduled attempt instead of starting one', () async {
    bridge.refuseConnections = true;
    final client = createClient(
      retryInitialConnection: true,
      retryDelay: const Duration(milliseconds: 150),
    );
    await expectLater(client.connect(), throwsA(isA<PyricBridgeException>()));
    expect(bridge.connectCalls, 1);

    final queued = client.op('getDoc', {'path': 'rooms/a'});
    await settle();
    expect(bridge.connectCalls, 1, reason: 'the operation must not start an attempt early');

    bridge.refuseConnections = false;
    await until(() => bridge.ofType('worker-op').isNotEmpty);
    expect(bridge.connectCalls, 2);
    final sent = bridge.opNamed('getDoc');
    bridge.current.deliver({'type': 'worker-res', 'id': sent['id'], 'ok': true, 'value': null});
    await queued;
  });

  test('every first-connection attempt reports connecting', () async {
    bridge.refuseConnections = true;
    final client = createClient(
      retryInitialConnection: true,
      retryDelay: const Duration(milliseconds: 20),
    );
    final states = <BridgeConnectionState>[];
    client.connectionStates.listen(states.add);
    client.connect().ignore();
    await until(() => bridge.connectCalls >= 2);
    bridge.refuseConnections = false;
    await until(() => client.isConnected);
    final firstAttached = states.indexOf(BridgeConnectionState.attached);
    final beforeAttach = states.sublist(0, firstAttached);
    expect(beforeAttach.where((s) => s == BridgeConnectionState.connecting).length,
        greaterThanOrEqualTo(2));
    expect(beforeAttach.last, BridgeConnectionState.connecting);
  });

  test('an attempt that is not acknowledged within the attach timeout fails', () async {
    bridge.autoAck = false;
    final client = createClient(attachTimeout: const Duration(milliseconds: 50));
    await expectLater(
      client.connect(),
      throwsA(isA<PyricBridgeException>()
          .having((e) => e.code, 'code', 'unavailable')
          .having((e) => e.message, 'message', contains('Timed out'))),
    );
  });
  group('operations issued while not attached', () {
    test('an operation issued while interrupted reaches the host exactly once after re-attach', () async {
      final client = await attachedThenDropped();
      final read = client.op('getDoc', {'path': 'rooms/a'});
      await settle();
      expect(opsNamed('getDoc'), isEmpty);

      bridge.refuseConnections = false;
      await until(() => opsNamed('getDoc').isNotEmpty);
      reply(bridge.opNamed('getDoc'), {'path': 'rooms/a', 'exists': false});
      expect(await read, {'path': 'rooms/a', 'exists': false});
      expect(opsNamed('getDoc'), hasLength(1));
    });

    test('on a replaced host, an operation issued during the Auth restore is sent after it and after the listener replay', () async {
      final client = createClient();
      client.restoreAuth = (op) async {
        await op('auth.restorePortSession', {'uid': 'u1', 'tenantId': null});
      };
      client.subscribe({'__ref': 'doc', 'path': 'rooms/a'}).listen((_) {}, onError: (_) {});
      await until(() => bridge.subsFor('rooms/a').isNotEmpty);

      bridge.hostInstanceId = 'host-b';
      bridge.current.drop();
      await until(() => opsNamed('auth.restorePortSession').isNotEmpty);
      final write = client.op('setDoc', {'path': 'rooms/a'});
      await settle();
      expect(opsNamed('setDoc'), isEmpty, reason: 'held until the restore finishes');

      reply(bridge.opNamed('auth.restorePortSession'), {'uid': 'u1'});
      await until(() => opsNamed('setDoc').isNotEmpty);
      final frames = bridge.frames;
      final restoredAuth = frames.indexOf(bridge.opNamed('auth.restorePortSession'));
      final resubscribed = frames.indexOf(bridge.lastSubFor('rooms/a'));
      final held = frames.indexOf(bridge.opNamed('setDoc'));
      expect(resubscribed, greaterThan(restoredAuth));
      expect(held, greaterThan(resubscribed));

      reply(bridge.opNamed('setDoc'), 'done');
      expect(await write, 'done');
      expect(opsNamed('setDoc'), hasLength(1));
    });

    test('an operation held past the deadline fails once, saying it was not sent, and a later attach never sends it', () async {
      final client = await attachedThenDropped();
      client.holdDeadline = const Duration(milliseconds: 100);
      var rejections = 0;
      final write = client.op('setDoc', {'path': 'rooms/a'}).catchError((Object error) {
        rejections++;
        throw error;
      });
      await expectLater(
        write,
        throwsA(isA<PyricBridgeException>()
            .having((e) => e.code, 'code', 'unavailable')
            .having((e) => e.message, 'message', _notRestored)),
      );

      bridge.refuseConnections = false;
      await until(() => client.isConnected);
      final later = client.op('getDoc', {'path': 'rooms/b'});
      await until(() => opsNamed('getDoc').isNotEmpty);
      reply(bridge.opNamed('getDoc'), null);
      await later;
      expect(opsNamed('setDoc'), isEmpty);
      expect(rejections, 1);
    });

    test('a failed Auth restore on a replaced host fails held operations without sending them', () async {
      final client = await attachedThenDropped();
      client.restoreAuth = (op) async {
        await op('auth.restorePortSession', {'uid': 'u1', 'tenantId': null});
      };
      final write = client.op('setDoc', {'path': 'rooms/a'});
      final failure = expectLater(
        write,
        throwsA(isA<PyricBridgeException>()
            .having((e) => e.code, 'code', 'unavailable')
            .having((e) => e.message, 'message',
                'The bridge connection was restored, but the signed-in user could not be restored on the new host. The request was not sent.')),
      );

      bridge.hostInstanceId = 'host-b';
      bridge.refuseConnections = false;
      await until(() => opsNamed('auth.restorePortSession').isNotEmpty);
      bridge.current.deliver({
        'type': 'worker-res',
        'id': bridge.opNamed('auth.restorePortSession')['id'],
        'ok': false,
        'error': {'code': 'internal', 'message': 'restore failed'},
      });
      await failure;
      await until(() => client.isConnected);
      await settle();
      expect(opsNamed('setDoc'), isEmpty);
    });

    test('an operation issued while held operations are being sent goes after them', () async {
      final client = await attachedThenDropped();
      final a = client.op('setDoc', {'path': 'rooms/a'});
      final b = client.op('setDoc', {'path': 'rooms/b'});
      Future<dynamic>? c;
      bridge.onFrame = (frame) {
        final isHeldA = frame['type'] == 'worker-op' && (frame['op'] as Map)['path'] == 'rooms/a';
        if (isHeldA) c = client.op('setDoc', {'path': 'rooms/c'});
      };

      bridge.refuseConnections = false;
      await until(() => opsNamed('setDoc').length == 3);
      expect(opsNamed('setDoc').map((f) => (f['op'] as Map)['path']),
          ['rooms/a', 'rooms/b', 'rooms/c']);
      for (final frame in opsNamed('setDoc')) {
        reply(frame, 'done');
      }
      expect(await Future.wait([a, b, c!]), ['done', 'done', 'done']);
    });

    test('disconnect while holding fails held operations once and sends none', () async {
      final client = await attachedThenDropped();
      final settled = <String>[];
      final first = client.op('setDoc', {'path': 'rooms/a'});
      final second = client.op('getDoc', {'path': 'rooms/b'});
      first.then((_) {}, onError: (_) => settled.add('first')).ignore();
      second.then((_) {}, onError: (_) => settled.add('second')).ignore();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(settled, isEmpty, reason: 'held, neither sent nor failed');

      await client.disconnect();
      final closed = throwsA(isA<PyricBridgeException>()
          .having((e) => e.code, 'code', 'unavailable')
          .having((e) => e.message, 'message', 'PyricBridgeClient disconnected.'));
      await expectLater(first, closed);
      await expectLater(second, closed);
      bridge.refuseConnections = false;
      await settle();
      expect(settled, ['first', 'second']);
      expect(bridge.ofType('worker-op'), isEmpty);
    });

    test('without retryInitialConnection, an operation issued before the first attach fails once when the attempt fails', () async {
      bridge.refuseConnections = true;
      final client = createClient();
      await expectLater(
        client.op('getDoc', {'path': 'rooms/a'}),
        throwsA(isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable')),
      );
      expect(client.isDisposed, isTrue);
      expect(bridge.ofType('worker-op'), isEmpty);
    });
  });

  group('a drop during the Auth restore on a replaced host', () {
    /// Attaches to host-a, then re-attaches to a replaced host-b whose Auth
    /// restore is in flight.
    Future<PyricBridgeClient> replacedHostRestoring() async {
      final client = createClient();
      client.restoreAuth = (op) async {
        await op('auth.restorePortSession', {'uid': 'u1', 'tenantId': null});
      };
      await client.connect();
      bridge.hostInstanceId = 'host-b';
      bridge.current.drop();
      await until(() => opsNamed('auth.restorePortSession').isNotEmpty);
      return client;
    }

    test('restores Auth on the next attach to that host', () async {
      final client = await replacedHostRestoring();
      bridge.current.drop();

      await until(() => opsNamed('auth.restorePortSession').length == 2);
      final retried = bridge.opNamed('auth.restorePortSession');
      expect((retried['op'] as Map)['uid'], 'u1');
      reply(retried, {'uid': 'u1'});
      await until(() => client.isConnected);
    });

    test('an operation held across it is sent once, after the restore completes', () async {
      final client = await replacedHostRestoring();
      final write = client.op('setDoc', {'path': 'rooms/b'});
      await settle();
      bridge.current.drop();

      await until(() => opsNamed('auth.restorePortSession').length == 2);
      await settle();
      expect(opsNamed('setDoc'), isEmpty, reason: 'held until the restore finishes');

      final restore = bridge.opNamed('auth.restorePortSession');
      reply(restore, {'uid': 'u1'});
      await until(() => opsNamed('setDoc').isNotEmpty);
      final frames = bridge.frames;
      expect(frames.indexOf(bridge.opNamed('setDoc')), greaterThan(frames.indexOf(restore)));
      reply(bridge.opNamed('setDoc'), 'done');
      expect(await write, 'done');
      await settle();
      expect(opsNamed('setDoc'), hasLength(1));
    });

    test('a resume to the same host after a completed restore does not restore Auth again', () async {
      final client = await replacedHostRestoring();
      reply(bridge.opNamed('auth.restorePortSession'), {'uid': 'u1'});
      await until(() => client.isConnected);

      bridge.current.drop();
      await until(() => bridge.ofType('attach').length == 3);
      await until(() => client.isConnected);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(opsNamed('auth.restorePortSession'), hasLength(1));
    });
  });

  // ADR-0019, heartbeat amendment: a ping at attach and every interval, and a
  // socket that delivers no frame for the liveness timeout is a drop.
  group('heartbeat', () {
    const interval = Duration(milliseconds: 20);
    const timeout = Duration(milliseconds: 100);

    test('a ping is sent at attach and at each interval', () async {
      final client = createClient(
        heartbeatInterval: interval,
        livenessTimeout: const Duration(seconds: 10),
      );
      await client.connect();
      expect(bridge.current.sentOfType('ping'), hasLength(1),
          reason: 'the ping at attach starts the host watch');

      await until(() => bridge.current.sentOfType('ping').length >= 3);
      final ids = bridge.ofType('ping').map((frame) => frame['id']).toList();
      expect(ids.toSet(), hasLength(ids.length));
      expect(client.connectionState, BridgeConnectionState.attached);
    });

    test('a silent socket is a drop: the operation in flight fails once and the client re-attaches', () async {
      final client = createClient(heartbeatInterval: interval, livenessTimeout: timeout);
      await client.connect();
      final states = <BridgeConnectionState>[];
      client.connectionStates.listen(states.add);

      final pending = client.op('setDoc', {'path': 'rooms/a'});
      final failure = expectLater(
        pending,
        throwsA(isA<PyricBridgeException>()
            .having((e) => e.code, 'code', 'unavailable')
            .having((e) => e.message, 'message', contains('connection was lost'))),
      );
      await settle();
      final sentId = bridge.opNamed('setDoc')['id'];
      final silent = bridge.current;
      silent.silence();

      await failure;
      await until(() => client.isConnected && bridge.sockets.length == 2);
      expect(states, containsAllInOrder([
        BridgeConnectionState.interrupted,
        BridgeConnectionState.attached,
      ]));
      expect(silent.isOpen, isFalse, reason: 'the client closes the silent socket');
      expect(bridge.ofType('attach').last['clientSessionId'], 'session-1');
      expect(bridge.ofType('worker-op').where((f) => f['id'] == sentId), hasLength(1));
      expect(bridge.current.sentOfType('ping'), isNotEmpty,
          reason: 'the heartbeat starts again on the new attach');
    });

    test('an operation issued after a silent drop is held and sent once after re-attach', () async {
      final client = createClient(heartbeatInterval: interval, livenessTimeout: timeout);
      await client.connect();
      bridge.refuseConnections = true;
      bridge.current.silence();
      await until(() => client.connectionState == BridgeConnectionState.interrupted);

      final read = client.op('getDoc', {'path': 'rooms/a'});
      await settle();
      expect(opsNamed('getDoc'), isEmpty);

      bridge.refuseConnections = false;
      await until(() => opsNamed('getDoc').isNotEmpty);
      reply(bridge.opNamed('getDoc'), {'path': 'rooms/a', 'exists': false});
      expect(await read, {'path': 'rooms/a', 'exists': false});
      expect(opsNamed('getDoc'), hasLength(1));
    });

    test('pongs keep the client attached past the liveness timeout', () async {
      final client = createClient(
        heartbeatInterval: const Duration(milliseconds: 25),
        livenessTimeout: const Duration(milliseconds: 250),
      );
      final states = <BridgeConnectionState>[];
      client.connectionStates.listen(states.add);
      await client.connect();

      await Future<void>.delayed(const Duration(milliseconds: 800));
      expect(states, isNot(contains(BridgeConnectionState.interrupted)));
      expect(client.connectionState, BridgeConnectionState.attached);
      expect(bridge.connectCalls, 1);
      expect(bridge.current.sentOfType('ping').length, greaterThanOrEqualTo(4));
    });

    test('no ping is sent after a drop or after disconnect', () async {
      final client = createClient(
        heartbeatInterval: interval,
        livenessTimeout: const Duration(seconds: 10),
      );
      await client.connect();
      final first = bridge.current;
      await until(() => first.sentOfType('ping').length >= 2);

      bridge.refuseConnections = true;
      first.drop();
      await until(() => client.connectionState == BridgeConnectionState.interrupted);
      final pingsAtDrop = bridge.ofType('ping').length;
      await Future<void>.delayed(interval * 5);
      expect(bridge.ofType('ping'), hasLength(pingsAtDrop),
          reason: 'nothing is pinged while interrupted');

      bridge.refuseConnections = false;
      await until(() => client.isConnected);
      final second = bridge.current;
      await until(() => second.sentOfType('ping').length >= 2);

      await client.disconnect();
      final pingsAtDisconnect = bridge.ofType('ping').length;
      await Future<void>.delayed(interval * 5);
      expect(bridge.ofType('ping'), hasLength(pingsAtDisconnect));
      for (final socket in bridge.sockets) {
        final latePings = socket.sentAfterClose.where((f) => f['type'] == 'ping');
        expect(latePings, isEmpty, reason: 'an old socket is never pinged');
      }
    });
  });
}
