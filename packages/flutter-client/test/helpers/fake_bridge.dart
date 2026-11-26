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

  final List<void Function()> _frameWatchers = [];
  final List<void Function()> _connectWatchers = [];

  FakeSocket get current => sockets.last;

  void _notifyFrameWatchers() {
    final watchers = List<void Function()>.of(_frameWatchers);
    for (final watcher in watchers) {
      watcher();
    }
  }

  void _notifyConnectWatchers() {
    final watchers = List<void Function()>.of(_connectWatchers);
    for (final watcher in watchers) {
      watcher();
    }
  }

  /// Completes as soon as [frames] contains at least [count] frames matching [predicate].
  Future<List<Map<String, dynamic>>> waitForFrames(
    bool Function(Map<String, dynamic> frame) predicate, {
    int count = 1,
  }) {
    final existing = frames.where(predicate).toList();
    if (existing.length >= count) return Future.value(existing);
    final completer = Completer<List<Map<String, dynamic>>>();
    late final void Function() check;
    check = () {
      final matches = frames.where(predicate).toList();
      if (matches.length >= count && !completer.isCompleted) {
        _frameWatchers.remove(check);
        completer.complete(matches);
      }
    };
    _frameWatchers.add(check);
    return completer.future;
  }

  Future<List<Map<String, dynamic>>> waitForType(String type, {int count = 1}) =>
      waitForFrames((frame) => frame['type'] == type, count: count);

  Future<List<Map<String, dynamic>>> waitForSubsFor(String path, {int count = 1}) =>
      waitForFrames(
        (frame) {
          if (frame['type'] != 'worker-sub') return false;
          final target = (frame['sub'] as Map)['target'];
          return target is Map && target['path'] == path;
        },
        count: count,
      );

  Future<List<Map<String, dynamic>>> waitForSubTarget(
    Object target, {
    int count = 1,
  }) =>
      waitForFrames(
        (frame) =>
            frame['type'] == 'worker-sub' &&
            (frame['sub'] as Map)['target'] == target,
        count: count,
      );

  Future<List<Map<String, dynamic>>> waitForOpsNamed(
    String method, {
    int count = 1,
  }) =>
      waitForFrames(
        (frame) =>
            frame['type'] == 'worker-op' &&
            (frame['op'] as Map)['method'] == method,
        count: count,
      );

  /// Completes as soon as [connectCalls] reaches at least [count].
  Future<void> waitForConnectCalls(int count) {
    if (connectCalls >= count) return Future.value();
    final completer = Completer<void>();
    late final void Function() check;
    check = () {
      if (connectCalls >= count && !completer.isCompleted) {
        _connectWatchers.remove(check);
        completer.complete();
      }
    };
    _connectWatchers.add(check);
    return completer.future;
  }

  /// Completes as soon as [sockets] has at least [count] opened sockets.
  Future<void> waitForSocketCount(int count) {
    if (sockets.length >= count) return Future.value();
    final completer = Completer<void>();
    late final void Function() check;
    check = () {
      if (sockets.length >= count && !completer.isCompleted) {
        _connectWatchers.remove(check);
        completer.complete();
      }
    };
    _connectWatchers.add(check);
    return completer.future;
  }

  Future<WebSocketChannel> connect(Uri uri, Map<String, dynamic> headers) async {
    connectCalls++;
    if (refuseConnections) {
      _notifyConnectWatchers();
      throw StateError('connection refused');
    }
    late final FakeSocket socket;
    socket = FakeSocket((frame) {
      frames.add(frame);
      onFrame?.call(frame);
      _notifyFrameWatchers();
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
    _notifyConnectWatchers();
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

/// Deterministic event counter gate (zero timers, zero polling).
class CountGate {
  int _count = 0;
  final List<({int target, Completer<void> completer})> _waiters = [];

  int get count => _count;

  void tick() {
    _count++;
    _waiters.removeWhere((waiter) {
      if (_count >= waiter.target) {
        if (!waiter.completer.isCompleted) waiter.completer.complete();
        return true;
      }
      return false;
    });
  }

  Future<void> atLeast(int target) {
    if (_count >= target) return Future.value();
    final completer = Completer<void>();
    _waiters.add((target: target, completer: completer));
    return completer.future;
  }
}

/// Flushes queued microtasks deterministically without timers.
Future<void> flushMicrotasks([int rounds = 4]) async {
  for (var i = 0; i < rounds; i++) {
    await Future<void>.microtask(() {});
  }
}

Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 5));

Future<void> until(bool Function() condition) async {
  for (var i = 0; i < 1200; i++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  fail('condition not reached');
}
