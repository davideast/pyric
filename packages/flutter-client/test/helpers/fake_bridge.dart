import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// One fake socket. [drop] ends it the way a lost connection does; [silence]
/// leaves it open but delivers nothing more, as a half-open connection does;
/// [beginClosing] drops every later frame without an error, as
/// `web_socket_channel` does on a socket that is closing.
class FakeSocket extends StreamChannelMixin<dynamic>
    implements WebSocketChannel {
  final StreamController<dynamic> _toClient = StreamController<dynamic>();
  final void Function(Map<String, dynamic> frame) _onFrame;
  int? _closeCode;
  bool _isOpen = true;
  bool _isSilent = false;
  bool _isClosing = false;

  /// Frames the client sent on this socket while it was open.
  final List<Map<String, dynamic>> sent = [];

  /// Frames the client tried to send on this socket after it closed.
  final List<Map<String, dynamic>> sentAfterClose = [];

  /// Frames the client sent after [beginClosing]; none reached the bridge.
  final List<Map<String, dynamic>> droppedWhileClosing = [];

  FakeSocket(this._onFrame);

  bool get isOpen => _isOpen;

  bool get isClosing => _isClosing;

  void deliver(Map<String, dynamic> frame) {
    if (_isOpen && !_isSilent) _toClient.add(jsonEncode(frame));
  }

  /// Stops delivering frames without closing the socket.
  void silence() => _isSilent = true;

  /// Starts a close the client has not seen yet: the socket stays open, and
  /// the sink accepts each frame and drops it.
  void beginClosing() => _isClosing = true;

  List<Map<String, dynamic>> sentOfType(String type) =>
      sent.where((frame) => frame['type'] == type).toList();

  void drop({int? code}) {
    if (!_isOpen) return;
    _isOpen = false;
    _closeCode = code;
    _toClient.close();
  }

  @override
  Stream<dynamic> get stream => _toClient.stream;

  @override
  WebSocketSink get sink => _FakeSink(this);

  @override
  String? get protocol => null;

  @override
  int? get closeCode => _closeCode;

  @override
  String? get closeReason => null;

  @override
  Future<void> get ready => Future.value();
}

class _FakeSink implements WebSocketSink {
  final FakeSocket _socket;

  _FakeSink(this._socket);

  @override
  void add(dynamic data) {
    final frame = jsonDecode(data as String) as Map<String, dynamic>;
    if (!_socket.isOpen) {
      _socket.sentAfterClose.add(frame);
      throw StateError('socket closed');
    }
    if (_socket.isClosing) {
      _socket.droppedWhileClosing.add(frame);
      return;
    }
    _socket.sent.add(frame);
    _socket._onFrame(frame);
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<dynamic> stream) async {}

  @override
  Future<void> close([int? closeCode, String? closeReason]) async =>
      _socket.drop(code: closeCode);

  @override
  Future<void> get done => Future.value();
}

/// A bridge stand-in that hands out a new [FakeSocket] per connection and
/// records every frame the client sends, across all sockets. Tests select
/// frames by type and content, never by position.
class FakeBridge {
  final List<FakeSocket> sockets = [];
  final List<Map<String, dynamic>> frames = [];
  String sessionId = 'session-1';
  String hostInstanceId = 'host-a';
  bool peerConnected = true;
  bool refuseConnections = false;
  bool autoAck = true;
  int connectCalls = 0;

  /// Runs synchronously as each frame reaches the bridge, inside the client's send.
  void Function(Map<String, dynamic> frame)? onFrame;

  FakeSocket get current => sockets.last;

  Future<WebSocketChannel> connect(Uri uri, Map<String, dynamic> headers) async {
    connectCalls++;
    if (refuseConnections) throw StateError('connection refused');
    late final FakeSocket socket;
    socket = FakeSocket((frame) {
      frames.add(frame);
      onFrame?.call(frame);
      if (frame['type'] == 'attach' && autoAck) {
        scheduleMicrotask(() => socket.deliver({
              'type': 'attach-ack',
              'protocol': 1,
              'peerConnected': peerConnected,
              'clientSessionId': frame['clientSessionId'] ?? sessionId,
              'hostInstanceId': hostInstanceId,
            }));
      }
      // Answers each ping as the bridge does; a silenced socket delivers nothing.
      if (frame['type'] == 'ping') {
        scheduleMicrotask(() => socket.deliver({'type': 'pong', 'id': frame['id']}));
      }
    });
    sockets.add(socket);
    return socket;
  }

  List<Map<String, dynamic>> ofType(String type) =>
      frames.where((frame) => frame['type'] == type).toList();

  List<Map<String, dynamic>> subsFor(String path) =>
      ofType('worker-sub').where((frame) {
        final target = (frame['sub'] as Map)['target'];
        return target is Map && target['path'] == path;
      }).toList();

  Map<String, dynamic> lastSubFor(String path) => subsFor(path).last;

  Map<String, dynamic> opNamed(String method) => ofType('worker-op')
      .lastWhere((frame) => (frame['op'] as Map)['method'] == method);
}

Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 5));

Future<void> until(bool Function() condition) async {
  for (var i = 0; i < 1200; i++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  fail('condition not reached');
}
