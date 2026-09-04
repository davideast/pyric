import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../auth/auth_lens.dart';
import 'exceptions.dart';

export 'bridge_operations.dart';
export 'exceptions.dart';

/// Factory signature for injecting mock or custom WebSocket channels (e.g. in tests).
typedef WebSocketChannelFactory = FutureOr<WebSocketChannel> Function(
  Uri uri,
  Map<String, dynamic> headers,
);

class _PendingOp {
  final Completer<dynamic> completer;
  final Timer timer;

  _PendingOp(this.completer, this.timer);
}

class _ActiveSub {
  final StreamController<dynamic> controller;

  _ActiveSub(this.controller);
}

/// Pure-Dart WebSocket transport connecting to the Pyric bridge server.
class PyricBridgeClient {
  final Uri uri;
  final Map<String, dynamic> headers;
  final Duration defaultOpTimeout;
  final WebSocketChannelFactory? channelFactory;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _channelSubscription;

  bool _connected = false;
  bool _isDisposed = false;
  String? _clientSessionId;

  int _opCounter = 0;
  int _subCounter = 0;

  final Map<String, _PendingOp> _pendingOps = {};
  final Map<String, _ActiveSub> _activeSubs = {};

  final StreamController<AuthLens> _remoteLensController =
      StreamController<AuthLens>.broadcast();
  final StreamController<PyricBridgeException> _denialController =
      StreamController<PyricBridgeException>.broadcast();

  static void Function(PyricBridgeException)? onDenial;

  Completer<void>? _handshakeCompleter;

  PyricBridgeClient({
    Uri? uri,
    Map<String, dynamic>? headers,
    this.defaultOpTimeout = const Duration(seconds: 35),
    this.channelFactory,
  })  : uri = uri ?? Uri.parse('ws://localhost:5174/__pyric/sandbox'),
        headers = headers ?? const {'Host': 'localhost:5174'};

  /// Reports whether the client is connected to bridge and handshake is acknowledged.
  bool get isConnected => _connected && !_isDisposed;

  /// Reports whether the client has been permanently closed.
  bool get isDisposed => _isDisposed;

  /// Returns the client session ID assigned or acknowledged by the bridge server.
  String? get clientSessionId => _clientSessionId;

  /// Stream of remote lens changes pushed by the Pyric bridge.
  Stream<AuthLens> get remoteLensStream => _remoteLensController.stream;

  /// Stream of Security Rules denial exceptions intercepted from worker responses.
  Stream<PyricBridgeException> get denialStream => _denialController.stream;

  /// Establishes the WebSocket connection and completes the `attach`/`attach-ack` handshake.
  Future<void> connect() async {
    if (_connected) return;
    if (_isDisposed) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'Client is disposed.',
      );
    }
    if (_handshakeCompleter != null) return _handshakeCompleter!.future;

    _handshakeCompleter = Completer<void>();

    try {
      if (channelFactory != null) {
        _channel = await channelFactory!(uri, headers);
      } else {
        _channel = WebSocketChannel.connect(uri);
        await _channel!.ready;
      }

      _channelSubscription = _channel!.stream.listen(
        _handleMessage,
        onError: _handleChannelError,
        onDone: _handleChannelDone,
      );

      // Send initial attach frame per protocol
      _sendRaw({
        'type': 'attach',
        'protocol': 1,
        if (_clientSessionId != null) 'clientSessionId': _clientSessionId,
        'clientInfo': {
          'platform': 'flutter',
        },
      });

      await _handshakeCompleter!.future;
      _connected = true;
    } catch (e) {
      await disconnect();
      if (e is PyricBridgeException) rethrow;
      throw PyricBridgeException(
        code: 'unavailable',
        message: 'Failed to connect to Pyric bridge: $e',
      );
    }
  }

  /// Dispatches a one-shot worker operation and awaits the correlated result.
  Future<dynamic> op(
    String method,
    Map<String, dynamic> params, {
    Map<String, dynamic>? actAs,
    Duration? timeout,
  }) async {
    if (!_connected && !_isDisposed) {
      await connect();
    }
    _ensureConnected();

    final id = 'rop-${++_opCounter}';
    final completer = Completer<dynamic>();
    final opPayload = <String, dynamic>{
      'method': method,
      ...params,
      if (actAs != null) 'actAs': actAs,
    };

    final opTimeout = timeout ?? defaultOpTimeout;
    final timer = Timer(opTimeout, () {
      if (_pendingOps.remove(id) != null) {
        completer.completeError(
          PyricBridgeException(
            code: 'deadline-exceeded',
            message:
                'Remote sandbox op timed out after ${opTimeout.inMilliseconds}ms (op: $method). Is pyric sandbox still running?',
          ),
        );
      }
    });

    _pendingOps[id] = _PendingOp(completer, timer);

    try {
      _sendRaw({
        'type': 'worker-op',
        'id': id,
        if (_clientSessionId != null) 'clientSessionId': _clientSessionId,
        'op': opPayload,
      });
    } catch (e) {
      timer.cancel();
      _pendingOps.remove(id);
      completer.completeError(
        PyricBridgeException(
          code: 'unavailable',
          message: 'Failed to dispatch op to bridge: $e',
        ),
      );
    }

    return completer.future;
  }

  /// Lists all sandbox users via the auth.listUsers RPC.
  Future<List<Map<String, dynamic>>> authListUsers() async {
    final res = await op('auth.listUsers', {});
    if (res is List) {
      return res.map((item) => Map<String, dynamic>.from(item as Map)).toList();
    }
    return [];
  }

  /// Establishes a raw subscription payload over the bridge (e.g. for auth or custom targets).
  Stream<dynamic> subscribeRaw(Map<String, dynamic> subPayload) {
    if (_isDisposed) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'PyricBridgeClient has been disposed.',
      );
    }

    late StreamController<dynamic> controller;
    var listenGen = 0;
    String? currentSubId;

    controller = StreamController<dynamic>.broadcast(
      onListen: () async {
        final gen = ++listenGen;
        final subId = 'rsub-${++_subCounter}';
        try {
          if (!_connected) {
            await connect();
          }
          if (gen != listenGen || _isDisposed) {
            return;
          }
          _activeSubs[subId] = _ActiveSub(controller);
          currentSubId = subId;
          _sendRaw({
            'type': 'worker-sub',
            'subId': subId,
            if (_clientSessionId != null) 'clientSessionId': _clientSessionId,
            'sub': subPayload,
          });
        } catch (e) {
          if (gen == listenGen) {
            _activeSubs.remove(subId);
            currentSubId = null;
            if (!controller.isClosed) {
              controller.addError(
                e is PyricBridgeException
                    ? e
                    : PyricBridgeException(
                        code: 'unavailable',
                        message: 'Failed to dispatch subscription to bridge: $e',
                      ),
              );
              controller.close();
            }
          }
        }
      },
      onCancel: () {
        listenGen++;
        final subId = currentSubId;
        currentSubId = null;
        if (subId != null && _activeSubs.remove(subId) != null) {
          if (_connected && !_isDisposed) {
            try {
              _sendRaw({
                'type': 'worker-unsub',
                'subId': subId,
                if (_clientSessionId != null)
                  'clientSessionId': _clientSessionId,
              });
            } catch (_) {}
          }
        }
      },
    );

    return controller.stream;
  }

  /// Establishes a real-time subscription for a document or query target.
  Stream<dynamic> subscribe(
    Map<String, dynamic> target, {
    Map<String, dynamic>? actAs,
    bool includeMetadataChanges = false,
    String? listenSource,
  }) {
    return subscribeRaw({
      'target': target,
      if (actAs != null) 'actAs': actAs,
      if (includeMetadataChanges) 'includeMetadataChanges': true,
      if (listenSource != null && listenSource != 'defaultSource')
        'listenSource': listenSource,
    });
  }

  // ─── Connection Lifecycle & Message Routing ───────────────────────────────

  void _ensureConnected() {
    if (_isDisposed) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'PyricBridgeClient has been disposed.',
      );
    }
    if (!_connected) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'PyricBridgeClient is not connected. Call connect() first.',
      );
    }
  }

  void _sendRaw(Map<String, dynamic> message) {
    if (_channel == null || _isDisposed) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'Cannot send message: WebSocket is closed.',
      );
    }
    _channel!.sink.add(jsonEncode(message));
  }

  void _handleMessage(dynamic raw) {
    Map<String, dynamic> msg;
    try {
      if (raw is String) {
        msg = jsonDecode(raw) as Map<String, dynamic>;
      } else if (raw is List<int>) {
        msg = jsonDecode(utf8.decode(raw)) as Map<String, dynamic>;
      } else if (raw is Map) {
        msg = Map<String, dynamic>.from(raw);
      } else {
        return;
      }
    } catch (_) {
      return;
    }

    final type = msg['type'] as String?;
    if (type == null) return;

    switch (type) {
      case 'attach-ack':
        _handleAttachAck(msg);
        break;
      case 'worker-res':
        _handleWorkerRes(msg);
        break;
      case 'worker-snap':
        _handleWorkerSnap(msg);
        break;
      case 'worker-event':
        _handleWorkerEvent(msg);
        break;
      case 'ping':
        _handlePing(msg);
        break;
      case 'pong':
        break;
    }
  }

  void _handleWorkerEvent(Map<String, dynamic> msg) {
    final event = msg['event'] as String?;
    if (event != 'remote-lens') return;

    final lensMap = msg['lens'] is Map
        ? Map<String, dynamic>.from(msg['lens'] as Map)
        : msg['payload'] is Map
            ? (msg['payload']['lens'] is Map
                ? Map<String, dynamic>.from(msg['payload']['lens'] as Map)
                : Map<String, dynamic>.from(msg['payload'] as Map))
            : null;
    if (lensMap == null) return;

    final mode = lensMap['mode'] as String?;
    final AuthLens lens;
    switch (mode) {
      case 'admin':
        lens = AuthLens.admin;
        break;
      case 'anon':
        lens = AuthLens.anon;
        break;
      case 'app-session':
        lens = AuthLens.appSession;
        break;
      case 'as':
        lens = AuthLens.asUser(
          uid: lensMap['uid'] as String? ?? '',
          tenant: lensMap['tenant'] as String?,
          token: lensMap['token'] is Map
              ? Map<String, dynamic>.from(lensMap['token'] as Map)
              : null,
        );
        break;
      default:
        return;
    }
    _remoteLensController.add(lens);
  }

  void _handleAttachAck(Map<String, dynamic> msg) {
    _clientSessionId =
        msg['clientSessionId'] as String? ?? msg['sessionId'] as String?;
    final peerConnected = msg['peerConnected'] == true;
    if (_handshakeCompleter != null && !_handshakeCompleter!.isCompleted) {
      if (peerConnected) {
        _handshakeCompleter!.complete();
      } else {
        _handshakeCompleter!.completeError(
          const PyricBridgeException(
            code: 'unavailable',
            message:
                'No browser tab is connected to the sandbox — open pyric sandbox in a browser and retry.',
          ),
        );
      }
    }
  }

  void _handleWorkerRes(Map<String, dynamic> msg) {
    final id = msg['id'] as String?;
    if (id == null) return;

    final pending = _pendingOps.remove(id);
    if (pending == null) return; // Expired or already handled

    pending.timer.cancel();

    final ok = msg['ok'] == true;
    if (ok) {
      pending.completer.complete(msg['value']);
    } else {
      final errorMap = msg['error'] as Map<String, dynamic>? ?? {};
      final code = errorMap['code'] as String? ?? 'unknown';
      final message = errorMap['message'] as String? ?? 'unknown sandbox error';
      final denialContext = errorMap['denialContext'];
      final envelope = errorMap['envelope'];

      final exception = PyricBridgeException(
        code: code,
        message: message,
        denialContext: denialContext,
        envelope: envelope,
      );
      if (denialContext != null) {
        _denialController.add(exception);
        onDenial?.call(exception);
      }
      pending.completer.completeError(exception);
    }
  }

  void _handleWorkerSnap(Map<String, dynamic> msg) {
    final subId = msg['subId'] as String?;
    if (subId == null) return;

    final sub = _activeSubs[subId];
    if (sub == null) return; // Listener already unmounted

    final dynamic value = msg['value'];
    if (value is Map && value.containsKey('__error')) {
      // Terminal subscription error per Firestore contract
      _activeSubs.remove(subId);
      if (!_isDisposed && _connected) {
        try {
          _sendRaw({
            'type': 'worker-unsub',
            'subId': subId,
            if (_clientSessionId != null) 'clientSessionId': _clientSessionId,
          });
        } catch (_) {}
      }

      final errMap = value['__error'] as Map<String, dynamic>? ?? {};
      final code = errMap['code'] as String? ?? 'permission-denied';
      final message = errMap['message'] as String? ?? 'Subscription error';
      final denialContext = errMap['denialContext'];

      final exception = PyricBridgeException(
        code: code,
        message: message,
        denialContext: denialContext,
      );
      if (denialContext != null) {
        _denialController.add(exception);
        onDenial?.call(exception);
      }
      sub.controller.addError(exception);
      sub.controller.close();
      return;
    }

    sub.controller.add(value);
  }

  void _handlePing(Map<String, dynamic> msg) {
    final id = msg['id'] as String?;
    if (id != null) {
      try {
        _sendRaw({'type': 'pong', 'id': id});
      } catch (_) {}
    }
  }

  void _handleChannelError(dynamic error) {
    if (_handshakeCompleter != null && !_handshakeCompleter!.isCompleted) {
      _handshakeCompleter!.completeError(
        PyricBridgeException(
          code: 'unavailable',
          message: 'WebSocket connection error: $error',
        ),
      );
    }
    _failPendingOps('unavailable', 'WebSocket stream error: $error');
  }

  void _handleChannelDone() {
    if (_handshakeCompleter != null && !_handshakeCompleter!.isCompleted) {
      _handshakeCompleter!.completeError(
        const PyricBridgeException(
          code: 'unavailable',
          message: 'WebSocket closed before attach-ack received.',
        ),
      );
    }
    _failPendingOps('unavailable', 'WebSocket closed by remote peer.');
  }

  void _failPendingOps(String code, String message) {
    _connected = false;

    for (final pending in _pendingOps.values) {
      pending.timer.cancel();
      pending.completer.completeError(
        PyricBridgeException(code: code, message: message),
      );
    }
    _pendingOps.clear();

    for (final sub in _activeSubs.values) {
      sub.controller.addError(
        PyricBridgeException(code: code, message: message),
      );
      sub.controller.close();
    }
    _activeSubs.clear();
  }

  /// Closes the connection and cancels all outstanding operations and subscriptions.
  Future<void> disconnect() async {
    _isDisposed = true;
    _connected = false;

    for (final pending in _pendingOps.values) {
      pending.timer.cancel();
      pending.completer.completeError(
        const PyricBridgeException(
          code: 'unavailable',
          message: 'PyricBridgeClient disconnected.',
        ),
      );
    }
    _pendingOps.clear();

    for (final sub in _activeSubs.values) {
      sub.controller.addError(
        const PyricBridgeException(
          code: 'unavailable',
          message: 'PyricBridgeClient disconnected.',
        ),
      );
      sub.controller.close();
    }
    _activeSubs.clear();

    if (_handshakeCompleter != null && !_handshakeCompleter!.isCompleted) {
      _handshakeCompleter!.completeError(
        const PyricBridgeException(
          code: 'unavailable',
          message: 'PyricBridgeClient disconnected.',
        ),
      );
    }
    _handshakeCompleter = null;

    await _channelSubscription?.cancel();
    _channelSubscription = null;

    await _channel?.sink.close();
    _channel = null;
  }
}
