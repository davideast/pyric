import 'dart:async';
import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';

import '../transport/bridge_client.dart';
import 'messaging_wire_codec.dart';
import 'remote_message.dart';

/// Internal transport and subscription coordinator for one [FirebaseMessaging] instance.
class MessagingBridgeSession {
  MessagingBridgeSession({
    required PyricBridgeClient bridgeClient,
    required bool ownsBridgeClient,
    required bool hasConfiguredBridge,
    required this.registrationId,
    required this.recipientId,
    required this.wantsStaticForeground,
    required this.onStaticForegroundMessage,
    required this.resolveStaticBackgroundHandler,
  })  : _bridgeClient = bridgeClient,
        _ownsBridgeClient = ownsBridgeClient,
        _hasConfiguredBridge = hasConfiguredBridge;

  factory MessagingBridgeSession.resolve({
    required PyricBridgeClient? explicitBridge,
    required PyricBridgeClient? registeredBridge,
    required String? registrationId,
    required String? recipientId,
    required bool Function() wantsStaticForeground,
    required void Function(RemoteMessage message) onStaticForegroundMessage,
    required Future<void> Function(RemoteMessage message)? Function()
        resolveStaticBackgroundHandler,
  }) {
    if (explicitBridge != null) {
      return MessagingBridgeSession(
        bridgeClient: explicitBridge,
        ownsBridgeClient: false,
        hasConfiguredBridge: true,
        registrationId: registrationId,
        recipientId: recipientId,
        wantsStaticForeground: wantsStaticForeground,
        onStaticForegroundMessage: onStaticForegroundMessage,
        resolveStaticBackgroundHandler: resolveStaticBackgroundHandler,
      );
    }
    if (registeredBridge != null) {
      return MessagingBridgeSession(
        bridgeClient: registeredBridge,
        ownsBridgeClient: false,
        hasConfiguredBridge: true,
        registrationId: registrationId,
        recipientId: recipientId,
        wantsStaticForeground: wantsStaticForeground,
        onStaticForegroundMessage: onStaticForegroundMessage,
        resolveStaticBackgroundHandler: resolveStaticBackgroundHandler,
      );
    }
    final envUrl = Platform.environment['PYRIC_LIVE_BRIDGE_URL'];
    if (envUrl != null && envUrl.isNotEmpty) {
      return MessagingBridgeSession(
        bridgeClient: PyricBridgeClient(uri: Uri.parse(envUrl)),
        ownsBridgeClient: true,
        hasConfiguredBridge: true,
        registrationId: registrationId,
        recipientId: recipientId,
        wantsStaticForeground: wantsStaticForeground,
        onStaticForegroundMessage: onStaticForegroundMessage,
        resolveStaticBackgroundHandler: resolveStaticBackgroundHandler,
      );
    }
    return MessagingBridgeSession(
      bridgeClient: PyricBridgeClient(),
      ownsBridgeClient: true,
      hasConfiguredBridge: false,
      registrationId: registrationId,
      recipientId: recipientId,
      wantsStaticForeground: wantsStaticForeground,
      onStaticForegroundMessage: onStaticForegroundMessage,
      resolveStaticBackgroundHandler: resolveStaticBackgroundHandler,
    );
  }

  final String? registrationId;
  final String? recipientId;
  final bool Function() wantsStaticForeground;
  final void Function(RemoteMessage message) onStaticForegroundMessage;
  final Future<void> Function(RemoteMessage message)? Function()
      resolveStaticBackgroundHandler;

  PyricBridgeClient _bridgeClient;
  bool _ownsBridgeClient;
  bool _hasConfiguredBridge;
  bool _bridgeActivated = false;
  bool _isDisposed = false;

  int _instanceForegroundListeners = 0;
  Future<void> Function(RemoteMessage message)? instanceBackgroundHandler;
  StreamSubscription<dynamic>? _foregroundBridgeSub;
  StreamSubscription<dynamic>? _backgroundBridgeSub;

  late final StreamController<RemoteMessage> instanceForegroundController =
      StreamController<RemoteMessage>.broadcast(
    onListen: () {
      _instanceForegroundListeners++;
      syncSubscriptions();
    },
    onCancel: () {
      if (_instanceForegroundListeners > 0) {
        _instanceForegroundListeners--;
      }
      syncSubscriptions();
    },
  );

  PyricBridgeClient get bridgeClient => _bridgeClient;

  bool get isReadyForAutoInit => _hasConfiguredBridge || _bridgeActivated;

  Future<void> useEmulator(String host, int port) async {
    if (host.trim().isEmpty || port <= 0 || port > 65535) {
      throw FirebaseException(
        plugin: firebaseMessagingPluginName,
        code: 'invalid-argument',
        message: 'Invalid Messaging bridge endpoint: $host:$port',
      );
    }
    final normalizedHost =
        host.contains(':') && !host.startsWith('[') ? '[$host]' : host;
    final endpoint = Uri.parse('ws://$normalizedHost:$port/__pyric/sandbox');
    final nextClient = PyricBridgeClient(
      uri: endpoint,
      headers: <String, dynamic>{'Host': '$normalizedHost:$port'},
    );
    await cancelSubscriptions();
    final previous = _bridgeClient;
    final ownedPrevious = _ownsBridgeClient;
    _bridgeClient = nextClient;
    _ownsBridgeClient = true;
    _hasConfiguredBridge = true;
    _bridgeActivated = true;
    if (ownedPrevious) {
      await previous.disconnect();
    }
    await _bridgeClient.connect();
    syncSubscriptions();
  }

  Future<dynamic> runOp(String method, Map<String, dynamic> params) async {
    _bridgeActivated = true;
    syncSubscriptions();
    try {
      return await _bridgeClient.op(method, params);
    } catch (error, stackTrace) {
      Error.throwWithStackTrace(
        mapMessagingBridgeException(error, stackTrace),
        stackTrace,
      );
    }
  }

  void checkTopicOutcome(
    Object? raw,
    String topic, {
    bool allowUnregistered = false,
  }) {
    if (raw is! Map) return;
    final failureCount = (raw['failureCount'] as num?)?.toInt() ?? 0;
    if (failureCount <= 0) return;
    var reason = 'unknown';
    final errors = raw['errors'];
    if (errors is List && errors.isNotEmpty && errors.first is Map) {
      reason = ((errors.first as Map)['reason'] as String?) ?? 'unknown';
    }
    if (allowUnregistered && reason == 'unregistered-token') {
      return;
    }
    final code =
        reason == 'unregistered-token' ? 'unregistered' : 'invalid-argument';
    throw FirebaseMessagingSendException(
      code: code,
      status: reason,
      message: 'Topic operation on "$topic" failed for registration ($reason).',
    );
  }

  void syncSubscriptions() {
    if (_isDisposed) return;
    final canSubscribe =
        _hasConfiguredBridge || _bridgeActivated || _bridgeClient.isConnected;
    if (!canSubscribe) return;

    final wantsFg = wantsStaticForeground() || _instanceForegroundListeners > 0;
    if (wantsFg && _foregroundBridgeSub == null) {
      _foregroundBridgeSub = _bridgeClient.subscribeRaw(<String, dynamic>{
        'target': 'messaging.foreground',
        if (recipientId != null) 'recipientId': recipientId,
        'includeMetadataChanges': true,
      }).listen(_handleForegroundSnap, onError: (_) {});
    } else if (!wantsFg && _foregroundBridgeSub != null) {
      final sub = _foregroundBridgeSub;
      _foregroundBridgeSub = null;
      unawaited(sub?.cancel());
    }

    final wantsBg = resolveStaticBackgroundHandler() != null ||
        instanceBackgroundHandler != null;
    if (wantsBg && _backgroundBridgeSub == null) {
      _backgroundBridgeSub = _bridgeClient.subscribeRaw(<String, dynamic>{
        'target': 'messaging.background',
        if (recipientId != null) 'recipientId': recipientId,
        'includeMetadataChanges': true,
      }).listen(_handleBackgroundSnap, onError: (_) {});
    } else if (!wantsBg && _backgroundBridgeSub != null) {
      final sub = _backgroundBridgeSub;
      _backgroundBridgeSub = null;
      unawaited(sub?.cancel());
    }
  }

  void _handleForegroundSnap(dynamic snap) {
    if (_isDisposed || snap is BridgeSubscriptionGap || snap is! Map) return;
    final message = remoteMessageFromDeliveredPayload(
      Map<String, dynamic>.from(snap),
    );
    if (_instanceForegroundListeners > 0 &&
        !instanceForegroundController.isClosed) {
      instanceForegroundController.add(message);
    }
    onStaticForegroundMessage(message);
  }

  void _handleBackgroundSnap(dynamic snap) {
    if (_isDisposed || snap is BridgeSubscriptionGap || snap is! Map) return;
    final message = remoteMessageFromDeliveredPayload(
      Map<String, dynamic>.from(snap),
    );
    final handler = instanceBackgroundHandler ?? resolveStaticBackgroundHandler();
    if (handler != null) {
      unawaited(_runGuarded(handler, message));
    }
  }

  Future<void> _runGuarded(
    Future<void> Function(RemoteMessage message) handler,
    RemoteMessage message,
  ) async {
    try {
      await handler(message);
    } catch (_) {
      // Broker contract: consumer handler failures never crash sibling listeners.
    }
  }

  Future<void> cancelSubscriptions() async {
    final fg = _foregroundBridgeSub;
    final bg = _backgroundBridgeSub;
    _foregroundBridgeSub = null;
    _backgroundBridgeSub = null;
    if (fg != null) await fg.cancel();
    if (bg != null) await bg.cancel();
  }

  Future<void> dispose() async {
    if (_isDisposed) return;
    _isDisposed = true;
    await cancelSubscriptions();
    await instanceForegroundController.close();
    if (_ownsBridgeClient) {
      await _bridgeClient.disconnect();
    }
  }
}
