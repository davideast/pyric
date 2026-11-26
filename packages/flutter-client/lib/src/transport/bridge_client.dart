import 'dart:async';
import 'dart:convert';

import 'package:meta/meta.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../auth/auth_lens.dart';
import 'bridge_frame_codec.dart';
import 'bridge_heartbeat.dart';
import 'bridge_operation_queue.dart';
import 'bridge_reconnect_policy.dart';
import 'bridge_subscription_registry.dart';
import 'exceptions.dart';

export 'bridge_operations.dart';
export 'bridge_reconnect_policy.dart';
export 'exceptions.dart';

/// Pure-Dart WebSocket transport connecting to the Pyric bridge server.
///
/// After the first attach, a dropped socket is reopened with bounded backoff.
/// The client re-attaches with its `clientSessionId` and re-sends every live
/// subscription. Operations in flight at the drop fail once with
/// `unavailable` and are never re-sent. An operation issued while the client
/// is not attached (or positively refused by a throwing sink) is held, then
/// sent once after the restore, or fails once after 10 seconds without being
/// sent.
///
/// While attached, the client sends a `ping` at attach and every 15 seconds.
/// Before each one, a socket that has delivered no frame for 45 seconds is
/// treated as dropped and takes the reconnect path above.
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

  /// Test-only: how long an operation issued while not attached is held. The
  /// deadline is fixed at 10 seconds (ADR-0019 decision 7); this is not a user
  /// setting.
  @visibleForTesting
  Duration holdDeadline = bridgeDefaultHoldDeadline;

  /// Test-only: the wait between heartbeat pings. Fixed at 15 seconds
  /// (ADR-0019, heartbeat amendment); this is not a user setting.
  @visibleForTesting
  Duration heartbeatInterval = bridgeDefaultHeartbeatInterval;

  /// Test-only: how long the socket may deliver no frame before the next
  /// heartbeat treats it as dropped. Fixed at 45 seconds (ADR-0019, heartbeat
  /// amendment); this is not a user setting.
  @visibleForTesting
  Duration livenessTimeout = bridgeDefaultLivenessTimeout;

  /// Runs on a re-attach to a replaced host, before listens are re-sent.
  BridgeAuthRestorer? restoreAuth;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _channelSubscription;

  BridgeConnectionState _state = BridgeConnectionState.connecting;
  bool _isDisposed = false;
  bool _hasEverAttached = false;
  String? _clientSessionId;
  String? _hostInstanceId;
  bool _needsAuthRestore = false;
  int _connectionGeneration = 0;
  int _reconnectAttempt = 0;
  Timer? _reconnectTimer;
  Timer? _attachDeadline;
  Completer<void>? _attempt;
  Completer<void>? _nextAttempt;
  Future<void>? _shutdownComplete;

  final StreamController<AuthLens> _remoteLensController =
      StreamController<AuthLens>.broadcast();
  final StreamController<PyricBridgeException> _denialController =
      StreamController<PyricBridgeException>.broadcast();
  final StreamController<BridgeConnectionState> _stateController =
      StreamController<BridgeConnectionState>.broadcast();

  late final BridgeHeartbeat _heartbeat;
  late final BridgeOperationQueue _ops;
  late final BridgeSubscriptionRegistry _subs;

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
        reconnectDelay = reconnectDelay ?? bridgeReconnectDelay {
    _heartbeat = BridgeHeartbeat(
      interval: () => heartbeatInterval,
      livenessTimeout: () => livenessTimeout,
      isCurrentGeneration: (gen) => gen == _connectionGeneration && !_isDisposed,
      sendPing: (pingId) => _trySendMessage({'type': 'ping', 'id': pingId}),
      onSilentDrop: (gen, reason) => _handleConnectionLoss(gen, reason),
    );
    _ops = BridgeOperationQueue(
      defaultOpTimeout: defaultOpTimeout,
      holdDeadline: () => holdDeadline,
      isConnected: () => isConnected,
      isDisposed: () => _isDisposed,
      hasEverAttached: () => _hasEverAttached,
      clientSessionId: () => _clientSessionId,
      trySendEncoded: _trySendEncoded,
      ensureInitialAttempt: () => connect().ignore(),
      onDenial: _emitDenial,
    );
    _subs = BridgeSubscriptionRegistry(
      isConnected: () => isConnected,
      isDisposed: () => _isDisposed,
      hasEverAttached: () => _hasEverAttached,
      clientSessionId: () => _clientSessionId,
      trySendMessage: _trySendMessage,
      ensureInitialAttempt: () => connect().ignore(),
      onDenial: _emitDenial,
    );
  }

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
  ///
  /// While the client is not attached, the operation is held and sent once
  /// after the next attach. It fails with `unavailable`, unsent, if the client
  /// has not attached within 10 seconds of the call.
  Future<dynamic> op(
    String method,
    Map<String, dynamic> params, {
    Map<String, dynamic>? actAs,
    Duration? timeout,
  }) async {
    _ensureUsable();
    return _ops.enqueueOrDispatch(
      method,
      params,
      actAs: actAs,
      timeout: timeout,
    );
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
  Stream<dynamic> subscribeRaw(Map<String, dynamic> subPayload) =>
      _subs.subscribeRaw(subPayload);

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

  Future<void> _startAttempt() {
    final attempt = Completer<void>();
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
      _handleConnectionLoss(
        generation,
        'Timed out connecting to the Pyric bridge.',
      );
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

    final sentAttach = _trySendMessage({
      'type': 'attach',
      'protocol': 1,
      'capabilities': const ['pyric/firestore-values/1'],
      if (_clientSessionId != null) 'clientSessionId': _clientSessionId,
      'clientInfo': const {'platform': 'flutter'},
    });
    if (!sentAttach) {
      _handleConnectionLoss(generation, 'Failed to send attach frame.');
    }
  }

  void _handleConnectionLoss(int generation, String reason, {int? closeCode}) {
    final isStale = generation != _connectionGeneration || _isDisposed;
    if (isStale) return;
    final error = PyricBridgeException(code: 'unavailable', message: reason);
    final permitsRetry = (_hasEverAttached || retryInitialConnection) &&
        closeCode != bridgePolicyCloseCode;
    if (!permitsRetry) {
      _shutdown(error).ignore();
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
    _ops.failPending(const PyricBridgeException(
      code: 'unavailable',
      message: bridgeConnectionLostMessage,
    ));
    if (attempt != null && !attempt.isCompleted) attempt.completeError(error);
    if (wasAttached) _subs.reportGap();

    final delay = reconnectDelay(_reconnectAttempt);
    _reconnectAttempt++;
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () {
      _reconnectTimer = null;
      if (_isDisposed || _attempt != null) return;
      _startAttempt();
    });
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
    if (changedHost) _needsAuthRestore = true;
    _finishAttach(generation, attempt, _needsAuthRestore);
  }

  Future<void> _finishAttach(
    int generation,
    Completer<void> attempt,
    bool restoresAuth,
  ) async {
    final restorer = restoreAuth;
    var authRestoreFailed = false;
    if (restoresAuth && restorer != null) {
      try {
        await restorer(
          (method, params) => _ops.dispatch(
            method,
            params,
            holdOnRefusal: false,
          ),
        );
      } catch (_) {
        authRestoreFailed = true;
      }
      final isStale = generation != _connectionGeneration || _isDisposed;
      if (isStale) return;
      _needsAuthRestore = false;
    }
    if (authRestoreFailed) {
      _ops.failHeld(const PyricBridgeException(
        code: 'unavailable',
        message: bridgeAuthRestoreFailedMessage,
      ));
    }

    _attachDeadline?.cancel();
    _attachDeadline = null;
    _attempt = null;
    _hasEverAttached = true;
    _reconnectAttempt = 0;
    _setState(BridgeConnectionState.attached);
    _heartbeat.start(generation);
    _subs.restoreAll();
    _ops.sendHeld();
    if (!attempt.isCompleted) attempt.complete();
  }

  void _setState(BridgeConnectionState next) {
    if (_state == next) return;
    _state = next;
    if (!_stateController.isClosed) _stateController.add(next);
  }

  void _releaseChannel() {
    _heartbeat.stop();
    final subscription = _channelSubscription;
    final channel = _channel;
    _channelSubscription = null;
    _channel = null;
    subscription?.cancel();
    try {
      channel?.sink.close();
    } catch (_) {}
  }

  void _ensureUsable() {
    if (_isDisposed) {
      throw const PyricBridgeException(
        code: 'unavailable',
        message: 'PyricBridgeClient has been disposed.',
      );
    }
  }

  bool _trySendEncoded(String encoded) {
    final channel = _channel;
    if (channel == null || _isDisposed) return false;
    try {
      channel.sink.add(encoded);
      return true;
    } catch (_) {
      return false;
    }
  }

  bool _trySendMessage(Map<String, dynamic> message) {
    try {
      return _trySendEncoded(jsonEncode(message));
    } catch (_) {
      return false;
    }
  }

  void _emitDenial(PyricBridgeException exception) {
    if (!_denialController.isClosed) {
      _denialController.add(exception);
    }
    onDenial?.call(exception);
  }

  void _handleMessage(int generation, dynamic raw) {
    final isStale = generation != _connectionGeneration || _isDisposed;
    if (isStale) return;
    _heartbeat.recordInboundFrame();
    final msg = decodeBridgeFrame(raw);
    if (msg == null) return;

    final type = msg['type'] as String?;
    switch (type) {
      case 'attach-ack':
        _handleAttachAck(generation, msg);
        break;
      case 'worker-res':
        _ops.handleWorkerRes(msg);
        break;
      case 'worker-snap':
        _subs.handleWorkerSnap(msg);
        break;
      case 'worker-event':
        final lens = parseRemoteLensEvent(msg);
        if (lens != null && !_remoteLensController.isClosed) {
          _remoteLensController.add(lens);
        }
        break;
      case 'ping':
        final id = msg['id'] as String?;
        if (id != null) _trySendMessage({'type': 'pong', 'id': id});
        break;
      case 'pong':
        break;
    }
  }

  Future<void> _shutdown(PyricBridgeException error) {
    if (_shutdownComplete != null) return _shutdownComplete!;
    _isDisposed = true;
    _connectionGeneration++;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _heartbeat.stop();
    _setState(BridgeConnectionState.closed);

    _ops.failPending(error);
    _ops.failHeld(error);

    final closeFutures = _subs.closeAll(error);
    if (!_stateController.isClosed) {
      closeFutures.add(_stateController.close());
    }
    if (!_remoteLensController.isClosed) {
      closeFutures.add(_remoteLensController.close());
    }
    if (!_denialController.isClosed) {
      closeFutures.add(_denialController.close());
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

    final done = closeFutures.isEmpty
        ? Future<void>.value()
        : Future.wait(closeFutures).then((_) {});
    _shutdownComplete = done;
    return done;
  }

  /// Closes the connection and cancels all outstanding operations and subscriptions.
  Future<void> disconnect() async {
    if (_isDisposed) {
      await _shutdownComplete;
      return;
    }
    final channelSubscription = _channelSubscription;
    final channel = _channel;
    _channelSubscription = null;
    _channel = null;
    final shutdownFuture = _shutdown(const PyricBridgeException(
      code: 'unavailable',
      message: 'PyricBridgeClient disconnected.',
    ));
    await channelSubscription?.cancel();
    try {
      await channel?.sink.close();
    } catch (_) {}
    await shutdownFuture;
  }
}
