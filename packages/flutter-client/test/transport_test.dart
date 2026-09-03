import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/src/transport/bridge_client.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// In-memory mock WebSocket channel enabling full bidirectional protocol simulation.
class MockWebSocketChannel extends StreamChannelMixin<dynamic>
    implements WebSocketChannel {
  final StreamController<dynamic> toServerController;
  final StreamController<dynamic> toClientController;

  MockWebSocketChannel({
    StreamController<dynamic>? toServer,
    StreamController<dynamic>? toClient,
  })  : toServerController = toServer ?? StreamController<dynamic>.broadcast(),
        toClientController = toClient ?? StreamController<dynamic>.broadcast();

  @override
  Stream<dynamic> get stream => toClientController.stream;

  @override
  WebSocketSink get sink => _MockWebSocketSink(toServerController);

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  Future<void> get ready => Future.value();
}

class _MockWebSocketSink implements WebSocketSink {
  final StreamController<dynamic> _controller;

  _MockWebSocketSink(this._controller);

  @override
  void add(dynamic data) => _controller.add(data);

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      _controller.addError(error, stackTrace);

  @override
  Future<void> addStream(Stream<dynamic> stream) => _controller.addStream(stream);

  @override
  Future<void> close([int? closeCode, String? closeReason]) => _controller.close();

  @override
  Future<void> get done => _controller.done;
}

void main() {
  late MockWebSocketChannel mockChannel;
  late List<Map<String, dynamic>> sentMessages;
  late StreamSubscription<dynamic> serverSubscription;

  setUp(() {
    mockChannel = MockWebSocketChannel();
    sentMessages = [];
    serverSubscription = mockChannel.toServerController.stream.listen((raw) {
      if (raw is String) {
        sentMessages.add(jsonDecode(raw) as Map<String, dynamic>);
      }
    });
  });

  tearDown(() async {
    await serverSubscription.cancel();
    await mockChannel.toServerController.close();
    await mockChannel.toClientController.close();
  });

  PyricBridgeClient createClient({Duration? timeout}) {
    return PyricBridgeClient(
      defaultOpTimeout: timeout ?? const Duration(seconds: 35),
      channelFactory: (uri, headers) async => mockChannel,
    );
  }

  group('PyricBridgeClient: Connection Handshake', () {
    test('sends attach and resolves connect on peerConnected: true', () async {
      final client = createClient();

      final connectFuture = client.connect();

      // Verify client sent attach frame
      await Future<void>.delayed(Duration.zero);
      expect(sentMessages.length, equals(1));
      expect(sentMessages.first['type'], equals('attach'));
      expect(sentMessages.first['protocol'], equals(1));

      // Simulate bridge attach-ack response
      mockChannel.toClientController.add(
        jsonEncode({
          'type': 'attach-ack',
          'protocol': 1,
          'bridgeVersion': '0.1.0',
          'peerConnected': true,
        }),
      );

      await connectFuture;
      expect(client.isConnected, isTrue);
      expect(client.isDisposed, isFalse);

      await client.disconnect();
    });

    test('throws unavailable exception on peerConnected: false (no browser tab)', () async {
      final client = createClient();

      final connectFuture = client.connect();

      await Future<void>.delayed(Duration.zero);
      expect(sentMessages.first['type'], equals('attach'));

      // Simulate attach-ack with peerConnected: false
      mockChannel.toClientController.add(
        jsonEncode({
          'type': 'attach-ack',
          'protocol': 1,
          'bridgeVersion': '0.1.0',
          'peerConnected': false,
        }),
      );

      expect(
        () => connectFuture,
        throwsA(
          isA<PyricBridgeException>().having(
            (e) => e.code,
            'code',
            equals('unavailable'),
          ),
        ),
      );
    });

    test('responds to keepalive ping with pong', () async {
      final client = createClient();
      final connectFuture = client.connect();

      await Future<void>.delayed(Duration.zero);
      mockChannel.toClientController.add(
        jsonEncode({
          'type': 'attach-ack',
          'protocol': 1,
          'peerConnected': true,
        }),
      );
      await connectFuture;

      // Server sends ping
      mockChannel.toClientController.add(
        jsonEncode({'type': 'ping', 'id': 'ping-999'}),
      );

      await Future<void>.delayed(Duration.zero);
      final pongs = sentMessages.where((m) => m['type'] == 'pong').toList();
      expect(pongs.length, equals(1));
      expect(pongs.first['id'], equals('ping-999'));

      await client.disconnect();
    });

    test('concurrent connect() calls join the in-flight handshake', () async {
      var channelFactoryCalls = 0;
      final client = PyricBridgeClient(
        channelFactory: (uri, headers) {
          channelFactoryCalls++;
          return Future.value(mockChannel);
        },
      );

      final connect1 = client.connect();
      final connect2 = client.connect();

      expect(channelFactoryCalls, equals(1));

      await Future<void>.delayed(Duration.zero);
      mockChannel.toClientController.add(
        jsonEncode({'type': 'attach-ack', 'peerConnected': true}),
      );

      await Future.wait([connect1, connect2]);
      expect(client.isConnected, isTrue);

      await client.disconnect();
    });
  });

  group('PyricBridgeClient: One-Shot Operations (worker-op / worker-res)', () {
    test('correlates worker-res by ID and resolves result value', () async {
      final client = createClient();
      final connectFuture = client.connect();
      await Future<void>.delayed(Duration.zero);
      mockChannel.toClientController.add(
        jsonEncode({'type': 'attach-ack', 'peerConnected': true}),
      );
      await connectFuture;

      final opFuture = client.op(
        'getDoc',
        {'path': 'users/alice'},
        actAs: {'mode': 'admin'},
      );

      await Future<void>.delayed(Duration.zero);
      final opFrame = sentMessages.last;
      expect(opFrame['type'], equals('worker-op'));
      expect(opFrame['id'], isA<String>());
      final reqId = opFrame['id'] as String;
      expect(
        opFrame['op'],
        equals({
          'method': 'getDoc',
          'path': 'users/alice',
          'actAs': {'mode': 'admin'},
        }),
      );

      // Server responds with success
      mockChannel.toClientController.add(
        jsonEncode({
          'type': 'worker-res',
          'id': reqId,
          'ok': true,
          'value': {
            'id': 'alice',
            'exists': true,
            'data': {'json': '{"name":"Alice"}'},
          },
        }),
      );

      final result = await opFuture as Map<String, dynamic>;
      expect(result['id'], equals('alice'));
      expect(result['exists'], isTrue);

      await client.disconnect();
    });

    test('propagates error with code and denialContext on ok: false', () async {
      final client = createClient();
      final connectFuture = client.connect();
      await Future<void>.delayed(Duration.zero);
      mockChannel.toClientController.add(
        jsonEncode({'type': 'attach-ack', 'peerConnected': true}),
      );
      await connectFuture;

      final opFuture = client.op('deleteDoc', {'path': 'restricted/secret'});

      await Future<void>.delayed(Duration.zero);
      final reqId = sentMessages.last['id'] as String;

      // Server responds with rejection
      mockChannel.toClientController.add(
        jsonEncode({
          'type': 'worker-res',
          'id': reqId,
          'ok': false,
          'error': {
            'code': 'permission-denied',
            'message': 'Missing or insufficient permissions.',
            'denialContext': {
              'rule': {'line': 42},
            },
          },
        }),
      );

      try {
        await opFuture;
        fail('Expected op to throw PyricBridgeException');
      } catch (e) {
        expect(e, isA<PyricBridgeException>());
        final bridgeErr = e as PyricBridgeException;
        expect(bridgeErr.code, equals('permission-denied'));
        expect(bridgeErr.message, contains('Missing or insufficient permissions'));
        expect(bridgeErr.denialContext, equals({'rule': {'line': 42}}));
      }

      await client.disconnect();
    });

    test('times out and throws deadline-exceeded if response is unhandled', () async {
      final client = createClient(timeout: const Duration(milliseconds: 50));
      final connectFuture = client.connect();
      await Future<void>.delayed(Duration.zero);
      mockChannel.toClientController.add(
        jsonEncode({'type': 'attach-ack', 'peerConnected': true}),
      );
      await connectFuture;

      final opFuture = client.op('hangingOp', {'foo': 'bar'});

      await expectLater(
        opFuture,
        throwsA(
          isA<PyricBridgeException>().having(
            (e) => e.code,
            'code',
            equals('deadline-exceeded'),
          ),
        ),
      );

      await client.disconnect();
    });
  });

  group('PyricBridgeClient: Subscriptions (worker-sub / worker-snap / worker-unsub)', () {
    test('streams snapshots and sends worker-unsub when listener cancels', () async {
      final client = createClient();
      final connectFuture = client.connect();
      await Future<void>.delayed(Duration.zero);
      mockChannel.toClientController.add(
        jsonEncode({'type': 'attach-ack', 'peerConnected': true}),
      );
      await connectFuture;

      final snapshots = <dynamic>[];
      final target = {'__ref': 'doc', 'path': 'chats/room1'};
      final stream = client.subscribe(target);

      final subscription = stream.listen((snap) => snapshots.add(snap));

      await Future<void>.delayed(Duration.zero);
      final subFrame = sentMessages.last;
      expect(subFrame['type'], equals('worker-sub'));
      expect(subFrame['subId'], isA<String>());
      final subId = subFrame['subId'] as String;
      expect(subFrame['sub']['target'], equals(target));

      // Deliver 2 snapshots from bridge
      mockChannel.toClientController.add(
        jsonEncode({
          'type': 'worker-snap',
          'subId': subId,
          'value': {'id': 'room1', 'messageCount': 1},
        }),
      );
      mockChannel.toClientController.add(
        jsonEncode({
          'type': 'worker-snap',
          'subId': subId,
          'value': {'id': 'room1', 'messageCount': 2},
        }),
      );

      await Future<void>.delayed(Duration.zero);
      expect(snapshots.length, equals(2));
      expect(snapshots[0]['messageCount'], equals(1));
      expect(snapshots[1]['messageCount'], equals(2));

      // Cancel stream
      await subscription.cancel();
      await Future<void>.delayed(Duration.zero);

      final unsubFrame = sentMessages.last;
      expect(unsubFrame['type'], equals('worker-unsub'));
      expect(unsubFrame['subId'], equals(subId));

      await client.disconnect();
    });

    test('terminates subscription stream on __error snap and auto-unsubscribes', () async {
      final client = createClient();
      final connectFuture = client.connect();
      await Future<void>.delayed(Duration.zero);
      mockChannel.toClientController.add(
        jsonEncode({'type': 'attach-ack', 'peerConnected': true}),
      );
      await connectFuture;

      final target = {'__ref': 'doc', 'path': 'forbidden/doc'};
      final stream = client.subscribe(target);

      dynamic receivedError;
      var isClosed = false;

      final sub = stream.listen(
        (_) {},
        onError: (err) => receivedError = err,
        onDone: () => isClosed = true,
      );

      await Future<void>.delayed(Duration.zero);
      final subId = sentMessages.last['subId'] as String;

      // Deliver terminal error snap
      mockChannel.toClientController.add(
        jsonEncode({
          'type': 'worker-snap',
          'subId': subId,
          'value': {
            '__error': {
              'code': 'permission-denied',
              'message': 'Listener denied by security rules.',
            },
          },
        }),
      );

      await Future<void>.delayed(Duration.zero);
      expect(receivedError, isA<PyricBridgeException>());
      expect((receivedError as PyricBridgeException).code, equals('permission-denied'));
      expect(isClosed, isTrue);

      // Verify worker-unsub was sent
      final unsubs = sentMessages.where((m) => m['type'] == 'worker-unsub').toList();
      expect(unsubs.length, equals(1));
      expect(unsubs.first['subId'], equals(subId));

      await sub.cancel();
      await client.disconnect();
    });
  });

  group('PyricBridgeClient: Teardown & Lifecycle', () {
    test('disconnect terminates pending ops and active subscriptions', () async {
      final client = createClient();
      final connectFuture = client.connect();
      await Future<void>.delayed(Duration.zero);
      mockChannel.toClientController.add(
        jsonEncode({'type': 'attach-ack', 'peerConnected': true}),
      );
      await connectFuture;

      final pendingOp = client.op('slowOp', {});
      final stream = client.subscribe({'__ref': 'collection', 'path': 'items'});
      var streamClosed = false;
      dynamic streamError;
      stream.listen(
        (_) {},
        onError: (e) => streamError = e,
        onDone: () => streamClosed = true,
      );

      final pendingOpExpectation = expectLater(
        pendingOp,
        throwsA(
          isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable'),
        ),
      );

      await client.disconnect();

      expect(client.isConnected, isFalse);
      expect(client.isDisposed, isTrue);

      await pendingOpExpectation;

      expect(streamClosed, isTrue);
      expect(streamError, isA<PyricBridgeException>());

      // Further calls fail immediately
      expect(
        () => client.op('anotherOp', {}),
        throwsA(
          isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable'),
        ),
      );
    });

    test('disconnect dispatches PyricBridgeException error to all active subscriptions', () async {
      final client = createClient();
      final connectFuture = client.connect();
      await Future<void>.delayed(Duration.zero);
      mockChannel.toClientController.add(
        jsonEncode({'type': 'attach-ack', 'peerConnected': true}),
      );
      await connectFuture;

      final stream1 = client.subscribe({'__ref': 'collection', 'path': 'col1'});
      final stream2 = client.subscribe({'__ref': 'collection', 'path': 'col2'});

      dynamic error1;
      dynamic error2;
      var done1 = false;
      var done2 = false;

      stream1.listen(
        (_) {},
        onError: (e) => error1 = e,
        onDone: () => done1 = true,
      );
      stream2.listen(
        (_) {},
        onError: (e) => error2 = e,
        onDone: () => done2 = true,
      );

      await client.disconnect();

      expect(done1, isTrue);
      expect(done2, isTrue);
      expect(error1, isA<PyricBridgeException>());
      expect((error1 as PyricBridgeException).code, equals('unavailable'));
      expect((error1 as PyricBridgeException).message, equals('PyricBridgeClient disconnected.'));
      expect(error2, isA<PyricBridgeException>());
      expect((error2 as PyricBridgeException).code, equals('unavailable'));
      expect((error2 as PyricBridgeException).message, equals('PyricBridgeClient disconnected.'));
    });
  });
}
