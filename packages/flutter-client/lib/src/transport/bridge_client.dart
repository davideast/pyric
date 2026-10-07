import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:collection/collection.dart';
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

/// Sends one worker operation on the connection being restored.
typedef BridgeRestoreOperation = Future<dynamic> Function(
  String method,
  Map<String, dynamic> params,
);

/// Re-establishes the session's Auth user on a replaced bridge host.
typedef BridgeAuthRestorer = Future<void> Function(BridgeRestoreOperation op);

/// The bridge client's transport state.
///
/// `interrupted` covers every reconnect attempt after a drop. `closed` is
/// terminal: the client was disconnected or hit a failure that permits no retry.
enum BridgeConnectionState { connecting, attached, interrupted, closed }

/// Delivered on a subscription registered with `includeMetadataChanges` when
/// the connection drops after it has delivered a value. The listener reports
/// its last snapshot again with `fromCache` set.
class BridgeSubscriptionGap {
  const BridgeSubscriptionGap._();

  static const BridgeSubscriptionGap instance = BridgeSubscriptionGap._();
}

const String _connectionLost =
    'The bridge connection was lost. Requests already sent may have completed; check state before retrying.';
const int _policyCloseCode = 1008;
const int _maxReconnectDelayMs = 5000;
final math.Random _jitterSource = math.Random();

/// The wait before reconnect attempt [attempt] (0-based): 250 ms doubling to a
/// 5 s cap, plus up to 250 ms of jitter, never above 5 s.
Duration bridgeReconnectDelay(int attempt, [math.Random? random]) {
  final exponent = math.min(attempt, 10);
  final base = math.min(_maxReconnectDelayMs, 250 * (1 << exponent));
  final jitter = (random ?? _jitterSource).nextDouble() * math.min(250, base / 10);
  return Duration(milliseconds: math.min(_maxReconnectDelayMs, base + jitter).floor());
}

class _PendingOp {
  final Completer<dynamic> completer;
  final Timer timer;

  _PendingOp(this.completer, this.timer);
}

class _ActiveSub {
  final StreamController<dynamic> controller;
  final Map<String, dynamic> payload;
  bool hasValue = false;
  dynamic lastValue;
  bool awaitsRestoredValue = false;

  _ActiveSub(this.controller, this.payload);

  bool get includesMetadataChanges => payload['includeMetadataChanges'] == true;
}

/// Pure-Dart WebSocket transport connecting to the Pyric bridge server.
///
/// After the first attach, a dropped socket is reopened with bounded backoff.
/// The client re-attaches with its `clientSessionId` and re-sends every live
/// subscription. Operations in flight at the drop fail once with
/// `unavailable` and are never re-sent.
class PyricBridgeClient {
  final Uri uri;
  final Map<String, dynamic> headers;
  final Duration defaultOpTimeout;
  final WebSocketChannelFactory? channelFactory;

  /// Retry the first connection on the reconnect schedule instead of closing.
  final bool retryInitialConnection;

  /// The wait before each reconnect attempt.
  final Duration Function(int attempt) reconnectDelay;

  /// An attempt that has not attached within this time counts as failed.
  final Duration attachTimeout;

  /// Runs on a re-attach to a replaced host, before listens are re-sent.
  BridgeAuthRestorer? restoreAuth;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _channelSubscription;

  BridgeConnectionState _state = BridgeConnectionState.connecting;
  bool _isDisposed = false;
  bool _hasEverAttached = false;
  String? _clientSessionId;
  String? _hostInstanceId;
  int _connectionGeneration = 0;
  int _reconnectAttempt = 0;
  Timer? _reconnectTimer;
  Timer? _attachDeadline;
  Completer<void>? _attempt;
  // Callers waiting for the next scheduled attempt.
  Completer<void>? _nextAttempt;

  int _opCounter = 0;
  int _subCounter = 0;

  final Map<String, _PendingOp> _pendingOps = {};
  final Map<String, _ActiveSub> _activeSubs = {};

  final StreamController<AuthLens> _remoteLensController =
      StreamController<AuthLens>.broadcast();
  final StreamController<PyricBridgeException> _denialController =
      StreamController<PyricBridgeException>.broadcast();
  final StreamController<BridgeConnectionState> _stateController =
      StreamController<BridgeConnectionState>.broadcast();

  static void Function(PyricBridgeException)? onDenial;

  PyricBridgeClient({
    Uri? uri,
    Map<String, dynamic>? headers,
    this.defaultOpTimeout = const Duration(seconds: 35),
    this.channelFactory,
    this.retryInitialConnection = false,
    Duration Function(int attempt)? reconnectDelay,
    this.attachTimeout = const Duration(seconds: 5),
  })  : uri = uri ?? Uri.parse('ws://localhost:5174/__pyric/sandbox'),
        headers = headers ?? const {'Host': 'localhost:5174'},
        reconnectDelay = reconnectDelay ?? bridgeReconnectDelay;

  /// Reports whether the client is attached to the bridge.
  bool get isConnected =>
      _state == BridgeConnectionState.attached && !_isDisposed;

  /// Reports whether the client has been permanently closed.
  bool get isDisposed => _isDisposed;

  /// The current transport state.
  BridgeConnectionState get connectionState => _state;

  /// Transport state changes.
  Stream<BridgeConnectionState> get connectionStates => _stateController.stream;

  /// Returns the client session ID assigned or acknowledged by the bridge server.
  String? get clientSessionId => _clientSessionId;

  /// Stream of remote lens changes pushed by the Pyric bridge.
  Stream<AuthLens> get remoteLensStream => _remoteLensController.stream;

  /// Stream of Security Rules denial exceptions intercepted from worker responses.
  Stream<PyricBridgeException> get denialStream => _denialController.stream;

  /// Establishes the WebSocket connection and completes the `attach`/`attach-ack` handshake.
  ///
  /// Joins the attempt in progress or, while a retry is scheduled, the next
  /// scheduled attempt. Starts an attempt only when none is in progress or
  /// scheduled.
  Future<void> connect() {
    if (isConnected) return Future.value();
    if (_isDisposed) {
      return Future.error(const PyricBridgeException(
        code: 'unavailable',
        message: 'Client is disposed.',
      ));
    }
    final inFlight = _attempt;
    if (inFlight != null) return inFlight.future;
    if (_reconnectTimer != null) {
      final next = _nextAttempt ??= Completer<void>();
      next.future.ignore();
      return next.future;
    }
    return _startAttempt();
  }

  /// Dispatches a one-shot worker operation and awaits the correlated result.
  Future<dynamic> op(
    String method,
    Map<String, dynamic> params, {
    Map<String, dynamic>? actAs,
    Duration? timeout,
  }) async {
    _ensureUsable();
    if (!isConnected) {
      if (_hasEverAttached) {
        throw const PyricBridgeException(code: 'unavailable', message: _connectionLost);
      }
      await connect();
    }
    _ensureUsable();
    return _dispatchOp(method, params, actAs: actAs, timeout: timeout);
  }

  Future<dynamic> _dispatchOp(
    String method,
    Map<String, dynamic> params, {
    Map<String, dynamic>? actAs,
    Duration? timeout,
  }) {
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
  ///
  /// The subscription survives a dropped connection: it is re-sent on every
  /// re-attach until the listener cancels.
  Stream<dynamic> subscribeRaw(Map<String, dynamic> subPayload) {
    if (_isDisposed) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'PyricBridgeClient has been disposed.',
      );
    }

    late StreamController<dynamic> controller;
    String? currentSubId;

    controller = StreamController<dynamic>.broadcast(
      onListen: () {
        if (_isDisposed) {
          controller.addError(const PyricBridgeException(
            code: 'unavailable',
            message: 'PyricBridgeClient has been disposed.',
          ));
          controller.close();
          return;
        }
        final subId = 'rsub-${++_subCounter}';
        currentSubId = subId;
        final sub = _ActiveSub(controller, subPayload);
        _activeSubs[subId] = sub;
        if (isConnected) {
          _sendSub(subId, sub);
        } else if (!_hasEverAttached) {
          // Sent by the attach that this starts or joins.
          connect().ignore();
        }
      },
      onCancel: () {
        final subId = currentSubId;
        currentSubId = null;
        if (subId != null && _activeSubs.remove(subId) != null && isConnected) {
          try {
            _sendRaw({
              'type': 'worker-unsub',
              'subId': subId,
              if (_clientSessionId != null) 'clientSessionId': _clientSessionId,
            });
          } catch (_) {}
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

  // ─── Connection Lifecycle ─────────────────────────────────────────────────

  Future<void> _startAttempt() {
    final attempt = Completer<void>();
    // Settled attempts nobody awaits must not surface as unhandled errors.
    attempt.future.ignore();
    _attempt = attempt;
    final generation = ++_connectionGeneration;
    if (!_hasEverAttached) _setState(BridgeConnectionState.connecting);
    final waiting = _nextAttempt;
    _nextAttempt = null;
    if (waiting != null) {
      attempt.future.then(waiting.complete, onError: waiting.completeError);
    }
    _attachDeadline?.cancel();
    _attachDeadline = Timer(attachTimeout, () {
      _handleConnectionLoss(generation, 'Timed out connecting to the Pyric bridge.');
    });
    _openChannel(generation);
    return attempt.future;
  }

  Future<void> _openChannel(int generation) async {
    final WebSocketChannel channel;
    try {
      if (channelFactory != null) {
        channel = await channelFactory!(uri, headers);
      } else {
        channel = WebSocketChannel.connect(uri);
        await channel.ready;
      }
    } catch (e) {
      _handleConnectionLoss(generation, 'Failed to connect to Pyric bridge: $e');
      return;
    }

    final isStale = generation != _connectionGeneration || _isDisposed;
    if (isStale) {
      try {
        await channel.sink.close();
      } catch (_) {}
      return;
    }

    _channel = channel;
    _channelSubscription = channel.stream.listen(
      (raw) => _handleMessage(generation, raw),
      onError: (Object error) => _handleConnectionLoss(
        generation,
        'WebSocket stream error: $error',
      ),
      onDone: () => _handleConnectionLoss(
        generation,
        'WebSocket closed by remote peer.',
        closeCode: channel.closeCode,
      ),
    );

    try {
      _sendRaw({
        'type': 'attach',
        'protocol': 1,
        if (_clientSessionId != null) 'clientSessionId': _clientSessionId,
        'clientInfo': {
          'platform': 'flutter',
        },
      });
    } catch (e) {
      _handleConnectionLoss(generation, 'Failed to send attach frame: $e');
    }
  }

  void _handleConnectionLoss(int generation, String reason, {int? closeCode}) {
    final isStale = generation != _connectionGeneration || _isDisposed;
    if (isStale) return;
    final error = PyricBridgeException(code: 'unavailable', message: reason);
    final permitsRetry = (_hasEverAttached || retryInitialConnection) &&
        closeCode != _policyCloseCode;
    if (!permitsRetry) {
      _shutdown(error);
      return;
    }

    _connectionGeneration++;
    _attachDeadline?.cancel();
    _attachDeadline = null;
    _releaseChannel();
    final attempt = _attempt;
    _attempt = null;
    final wasAttached = _state == BridgeConnectionState.attached;
    _setState(BridgeConnectionState.interrupted);
    _failPendingOps(const PyricBridgeException(
      code: 'unavailable',
      message: _connectionLost,
    ));
    if (attempt != null && !attempt.isCompleted) attempt.completeError(error);
    if (wasAttached) _reportGap();

    final delay = reconnectDelay(_reconnectAttempt);
    _reconnectAttempt++;
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () {
      _reconnectTimer = null;
      if (_isDisposed || _attempt != null) return;
      _startAttempt();
    });
  }

  void _reportGap() {
    for (final sub in _activeSubs.values) {
      final reportsGap = sub.includesMetadataChanges && sub.hasValue;
      if (reportsGap && !sub.controller.isClosed) {
        sub.controller.add(BridgeSubscriptionGap.instance);
      }
    }
  }

  void _handleAttachAck(int generation, Map<String, dynamic> msg) {
    final attempt = _attempt;
    if (attempt == null || attempt.isCompleted) return;
    final peerConnected = msg['peerConnected'] == true;
    if (!peerConnected) {
      _handleConnectionLoss(
        generation,
        'No browser tab is connected to the sandbox; open pyric sandbox in a browser and retry.',
      );
      return;
    }
    final ackSessionId =
        msg['clientSessionId'] as String? ?? msg['sessionId'] as String?;
    if (ackSessionId != null) _clientSessionId = ackSessionId;
    final ackHostId = msg['hostInstanceId'] as String?;
    final changedHost = _hasEverAttached &&
        _hostInstanceId != null &&
        ackHostId != null &&
        ackHostId != _hostInstanceId;
    if (ackHostId != null) _hostInstanceId = ackHostId;
    _finishAttach(generation, attempt, changedHost);
  }

  Future<void> _finishAttach(
    int generation,
    Completer<void> attempt,
    bool changedHost,
  ) async {
    final restorer = restoreAuth;
    if (changedHost && restorer != null) {
      try {
        await restorer((method, params) => _dispatchOp(method, params));
      } catch (_) {
        // The Auth observers report the host's state when the restore fails.
      }
      final isStale = generation != _connectionGeneration || _isDisposed;
      if (isStale) return;
    }

    _attachDeadline?.cancel();
    _attachDeadline = null;
    _attempt = null;
    _hasEverAttached = true;
    _reconnectAttempt = 0;
    _setState(BridgeConnectionState.attached);
    for (final entry in _activeSubs.entries.toList()) {
      final sub = entry.value;
      sub.awaitsRestoredValue = sub.hasValue;
      _sendSub(entry.key, sub);
    }
    if (!attempt.isCompleted) attempt.complete();
  }

  void _sendSub(String subId, _ActiveSub sub) {
    try {
      _sendRaw({
        'type': 'worker-sub',
        'subId': subId,
        if (_clientSessionId != null) 'clientSessionId': _clientSessionId,
        'sub': sub.payload,
      });
    } catch (_) {
      // A failed send means the socket is closing; its close re-sends this.
    }
  }

  void _setState(BridgeConnectionState next) {
    if (_state == next) return;
    _state = next;
    if (!_stateController.isClosed) _stateController.add(next);
  }

  void _releaseChannel() {
    final subscription = _channelSubscription;
    final channel = _channel;
    _channelSubscription = null;
    _channel = null;
    subscription?.cancel();
    try {
      channel?.sink.close();
    } catch (_) {}
  }

  // ─── Message Routing ──────────────────────────────────────────────────────

  void _ensureUsable() {
    if (_isDisposed) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'PyricBridgeClient has been disposed.',
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

  void _handleMessage(int generation, dynamic raw) {
    final isStale = generation != _connectionGeneration || _isDisposed;
    if (isStale) return;
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
        _handleAttachAck(generation, msg);
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
      if (denialContext != null ||
          code.toLowerCase().contains('permission') ||
          message.toLowerCase().contains('permission_denied')) {
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
      if (isConnected) {
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
      if (denialContext != null ||
          code.toLowerCase().contains('permission') ||
          message.toLowerCase().contains('permission_denied')) {
        _denialController.add(exception);
        onDenial?.call(exception);
      }
      sub.controller.addError(exception);
      sub.controller.close();
      return;
    }

    if (sub.awaitsRestoredValue) {
      sub.awaitsRestoredValue = false;
      final unchanged = const DeepCollectionEquality().equals(sub.lastValue, value);
      // Production raises a sync-state-only change only to metadata listeners.
      if (unchanged && !sub.includesMetadataChanges) return;
    }
    sub.hasValue = true;
    sub.lastValue = value;
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

  void _failPendingOps(PyricBridgeException error) {
    final pending = _pendingOps.values.toList();
    _pendingOps.clear();
    for (final op in pending) {
      op.timer.cancel();
      op.completer.completeError(error);
    }
  }

  void _shutdown(PyricBridgeException error) {
    _isDisposed = true;
    _connectionGeneration++;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _setState(BridgeConnectionState.closed);

    _failPendingOps(error);

    final subs = _activeSubs.values.toList();
    _activeSubs.clear();
    for (final sub in subs) {
      if (sub.controller.isClosed) continue;
      sub.controller.addError(error);
      sub.controller.close();
    }

    final attempt = _attempt;
    _attempt = null;
    if (attempt != null && !attempt.isCompleted) attempt.completeError(error);
    final waiting = _nextAttempt;
    _nextAttempt = null;
    if (waiting != null && !waiting.isCompleted) waiting.completeError(error);
    _attachDeadline?.cancel();
    _attachDeadline = null;

    _releaseChannel();
  }

  /// Closes the connection and cancels all outstanding operations and subscriptions.
  Future<void> disconnect() async {
    if (_isDisposed) return;
    final channelSubscription = _channelSubscription;
    final channel = _channel;
    _channelSubscription = null;
    _channel = null;
    _shutdown(const PyricBridgeException(
      code: 'unavailable',
      message: 'PyricBridgeClient disconnected.',
    ));
    await channelSubscription?.cancel();
    try {
      await channel?.sink.close();
    } catch (_) {}
  }
}
