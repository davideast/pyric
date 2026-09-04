import 'dart:async';
import 'dart:convert';

import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:pyric_firestore/src/transport/bridge_client.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// In-memory mock WebSocket channel enabling full bidirectional protocol simulation in tests.
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
  Future<void> addStream(Stream<dynamic> stream) =>
      _controller.addStream(stream);

  @override
  Future<void> close([int? closeCode, String? closeReason]) =>
      _controller.close();

  @override
  Future<void> get done => _controller.done;
}

/// Test harness for managing simulated Pyric bridge traffic.
class MockBridgeHarness {
  final MockWebSocketChannel channel;
  final List<Map<String, dynamic>> sentMessages = [];
  late final StreamSubscription<dynamic> _serverSub;

  MockBridgeHarness() : channel = MockWebSocketChannel() {
    _serverSub = channel.toServerController.stream.listen((raw) {
      if (raw is String) {
        sentMessages.add(jsonDecode(raw) as Map<String, dynamic>);
      }
    });
  }

  PyricBridgeClient createClient({Duration? timeout}) {
    return PyricBridgeClient(
      defaultOpTimeout: timeout ?? const Duration(seconds: 5),
      channelFactory: (uri, headers) async => channel,
    );
  }

  /// Sends a simulated frame to the client.
  void sendToClient(Map<String, dynamic> frame) {
    channel.toClientController.add(jsonEncode(frame));
  }

  /// Acknowledges an attach request.
  void ackAttach({String? clientSessionId}) {
    sendToClient({
      'type': 'attach-ack',
      'protocol': 1,
      'bridgeVersion': '0.1.0',
      'peerConnected': true,
      if (clientSessionId != null) 'clientSessionId': clientSessionId,
    });
  }

  Future<void> dispose() async {
    await _serverSub.cancel();
    await channel.toServerController.close();
    await channel.toClientController.close();
  }
}

class MockFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = {};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(
      appName,
      options ??
          const FirebaseOptions(
            apiKey: 'test-api-key',
            appId: 'test-app-id',
            messagingSenderId: 'test-sender-id',
            projectId: 'test-project-id',
          ),
    );
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps[name] ??
        FirebaseAppPlatform(
          name,
          const FirebaseOptions(
            apiKey: 'test-api-key',
            appId: 'test-app-id',
            messagingSenderId: 'test-sender-id',
            projectId: 'test-project-id',
          ),
        );
  }
}

void setupMockFirebase() {
  FirebasePlatform.instance = MockFirebasePlatform();
}

