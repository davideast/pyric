import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

// ignore: depend_on_referenced_packages
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_firestore.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Helper for unverified rows: fails when PYRIC_CLIMB=1 is active.
void expectUnverified(String message) {
  if (Platform.environment['PYRIC_CLIMB'] == '1') {
    fail(message);
  }
}

/// In-memory mock WebSocket channel for hermetic testing.
class MockWebSocketChannel extends StreamChannelMixin<dynamic>
    implements WebSocketChannel {
  final StreamController<dynamic> toServerController;
  final StreamController<dynamic> toClientController;

  MockWebSocketChannel({
    required this.toServerController,
    required this.toClientController,
  });

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

/// Hermetic mock harness simulating the Pyric WebSocket bridge.
class ConformanceMockHarness {
  final List<Map<String, dynamic>> sentMessages = [];
  final StreamController<dynamic> toServer =
      StreamController<dynamic>.broadcast();
  final StreamController<dynamic> toClient =
      StreamController<dynamic>.broadcast();
  late final PyricBridgeClient client;
  late final PyricFirestorePlatform firestore;

  ConformanceMockHarness() {
    toServer.stream.listen((event) {
      final msg = jsonDecode(event as String) as Map<String, dynamic>;
      sentMessages.add(msg);
      final type = msg['type'] as String?;

      if (type == 'attach') {
        toClient.add(jsonEncode({
          'type': 'attach-ack',
          'protocol': 1,
          'peerConnected': true,
        }));
      } else if (type == 'worker-op') {
        final id = msg['id'] as String;
        final op = msg['op'] as Map<String, dynamic>;
        final method = op['method'] as String;

        if (method == 'getDoc') {
          final path = op['path'] as String;
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {
              'id': path.split('/').last,
              'path': path,
              'exists': true,
              'data': {
                'json': jsonEncode({'name': 'Alice', 'age': 30}),
              },
            },
          }));
        } else if (method == 'getDocs') {
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {
              'docs': [
                {
                  'id': '1',
                  'path': 'users/1',
                  'exists': true,
                  'data': {'json': jsonEncode({'name': 'A'})},
                },
                {
                  'id': '2',
                  'path': 'users/2',
                  'exists': true,
                  'data': {'json': jsonEncode({'name': 'B'})},
                },
              ],
            },
          }));
        } else if (method == 'count') {
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {'count': 42},
          }));
        } else if (method == 'aggregate') {
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {
              'data': {
                'sum_score': 150.0,
                'avg_score': 75.0,
              },
            },
          }));
        } else {
          // setDoc, updateDoc, deleteDoc, addDoc, batchCommit, txnCommit
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': null,
          }));
        }
      } else if (type == 'worker-sub') {
        final subId = msg['subId'] as String;
        final sub = msg['sub'] as Map<String, dynamic>;
        final target = sub['target'] as Map<String, dynamic>;
        final refType = target['__ref'];

        if (refType == 'doc') {
          toClient.add(jsonEncode({
            'type': 'worker-snap',
            'subId': subId,
            'value': {
              'id': (target['path'] as String).split('/').last,
              'path': target['path'],
              'exists': true,
              'data': {'json': jsonEncode({'status': 'online'})},
            },
          }));
        } else {
          toClient.add(jsonEncode({
            'type': 'worker-snap',
            'subId': subId,
            'value': {
              'docs': [
                {
                  'id': 'doc1',
                  'path': '${target['path'] ?? 'coll'}/doc1',
                  'exists': true,
                  'data': {'json': jsonEncode({'item': 1})},
                }
              ],
            },
          }));
        }
      }
    });

    final channel = MockWebSocketChannel(
      toServerController: toServer,
      toClientController: toClient,
    );
    client = PyricBridgeClient(
      channelFactory: (uri, headers) => channel,
    );
    firestore = PyricFirestorePlatform(bridgeClient: client);
  }

  Future<void> dispose() async {
    await client.disconnect();
    await toServer.close();
    await toClient.close();
  }
}

/// In-memory mock [FirebasePlatform] preventing uninitialized Firebase exceptions.
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
