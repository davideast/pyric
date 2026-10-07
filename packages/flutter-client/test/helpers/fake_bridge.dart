import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// One fake socket. [drop] ends it the way a lost connection does.
class FakeSocket extends StreamChannelMixin<dynamic>
    implements WebSocketChannel {
  final StreamController<dynamic> _toClient = StreamController<dynamic>();
  final void Function(Map<String, dynamic> frame) _onFrame;
  int? _closeCode;
  bool _isOpen = true;

  FakeSocket(this._onFrame);

  bool get isOpen => _isOpen;

  void deliver(Map<String, dynamic> frame) {
    if (_isOpen) _toClient.add(jsonEncode(frame));
  }

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
    if (!_socket.isOpen) throw StateError('socket closed');
    _socket._onFrame(jsonDecode(data as String) as Map<String, dynamic>);
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

  FakeSocket get current => sockets.last;

  Future<WebSocketChannel> connect(Uri uri, Map<String, dynamic> headers) async {
    if (refuseConnections) throw StateError('connection refused');
    late final FakeSocket socket;
    socket = FakeSocket((frame) {
      frames.add(frame);
      if (frame['type'] == 'attach') {
        scheduleMicrotask(() => socket.deliver({
              'type': 'attach-ack',
              'protocol': 1,
              'peerConnected': peerConnected,
              'clientSessionId': frame['clientSessionId'] ?? sessionId,
              'hostInstanceId': hostInstanceId,
            }));
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
  for (var i = 0; i < 400; i++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  fail('condition not reached');
}
