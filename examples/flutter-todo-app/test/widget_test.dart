import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_todo_app/main.dart';
import 'package:flutter_todo_app/services/todo_repository.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/pyric_firestore.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

class _MockWebSocketChannel extends StreamChannelMixin<dynamic> implements WebSocketChannel {
  final StreamController<dynamic> toServerController = StreamController<dynamic>.broadcast();
  final StreamController<dynamic> toClientController = StreamController<dynamic>.broadcast();

  @override
  Stream<dynamic> get stream => toClientController.stream;

  @override
  WebSocketSink get sink => _MockSink(toServerController);

  @override
  String? get protocol => null;
  @override
  int? get closeCode => null;
  @override
  String? get closeReason => null;
  @override
  Future<void> get ready => Future.value();
}

class _MockSink implements WebSocketSink {
  final StreamController<dynamic> _controller;
  _MockSink(this._controller);
  @override
  void add(dynamic data) => _controller.add(data);
  @override
  void addError(Object error, [StackTrace? stackTrace]) => _controller.addError(error, stackTrace);
  @override
  Future<void> addStream(Stream<dynamic> stream) => _controller.addStream(stream);
  @override
  Future<void> close([int? closeCode, String? closeReason]) => _controller.close();
  @override
  Future<void> get done => _controller.done;
}

void main() {
  late _MockWebSocketChannel mockChannel;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform authPlatform;
  late PyricFirestorePlatform firestorePlatform;
  late PyricDebugController debugController;
  late TodoRepository repository;

  setUp(() async {
    mockChannel = _MockWebSocketChannel();
    client = PyricBridgeClient(
      channelFactory: (uri, headers) async => mockChannel,
    );

    final connectFuture = client.connect();
    await Future<void>.delayed(Duration.zero);
    mockChannel.toClientController.add(jsonEncode({
      'type': 'attach-ack',
      'protocol': 1,
      'bridgeVersion': '0.1.0',
      'peerConnected': true,
      'clientSessionId': 'test-session-1',
    }));
    await connectFuture;

    authPlatform = PyricFirebaseAuthPlatform(bridgeClient: client);
    FirebaseAuthPlatform.instance = authPlatform;

    firestorePlatform = PyricFirestorePlatform(
      bridgeClient: client,
      credentialsProvider: authPlatform,
    );
    FirebaseFirestorePlatform.instance = firestorePlatform;

    debugController = PyricDebugController(
      authPlatform: authPlatform,
      bridgeClient: client,
    );
    repository = TodoRepository(firestore: firestorePlatform);
  });

  tearDown(() async {
    debugController.dispose();
    await authPlatform.dispose();
    await client.disconnect();
    await mockChannel.toServerController.close();
    await mockChannel.toClientController.close();
  });

  testWidgets('TodoApp boots with PyricDebugOverlay and unauthenticated prompt', (tester) async {
    await tester.pumpWidget(
      TodoApp(
        debugController: debugController,
        repository: repository,
      ),
    );

    // Verify title and Auth prompt
    expect(find.text('Pyric Flutter Todos'), findsOneWidget);
    expect(find.text('Authentication Required'), findsOneWidget);
    expect(find.text('Sign In Anonymously'), findsOneWidget);
    expect(find.text('Sign In as Alice (Email/Password)'), findsOneWidget);

    // Verify Pyric Debug overlay pill exists
    expect(find.byType(PyricDebugOverlay), findsOneWidget);
  });
}
