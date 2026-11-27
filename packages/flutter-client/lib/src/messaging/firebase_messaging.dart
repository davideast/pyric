import 'dart:async';

import 'package:firebase_core/firebase_core.dart';

import '../platform/platform_env.dart';
import '../transport/bridge_client.dart';
import 'messaging_bridge_session.dart';
import 'messaging_settings.dart';
import 'messaging_wire_codec.dart';
import 'remote_message.dart';

/// Top-level or static callback invoked for background Cloud Messaging deliveries.
typedef BackgroundMessageHandler = Future<void> Function(RemoteMessage message);

/// Alias matching Pyric's Flutter package naming convention.
typedef PyricFirebaseMessaging = FirebaseMessaging;

/// Short alias for [FirebaseMessaging].
typedef PyricMessaging = FirebaseMessaging;

/// Pure-Dart Firebase Cloud Messaging client backed by Pyric's WebSocket bridge.
///
/// Mirrors FlutterFire's `firebase_messaging` public API (`instance`,
/// `instanceFor`, `getToken`, `deleteToken`, `onTokenRefresh`,
/// `subscribeToTopic`, `unsubscribeFromTopic`, `requestPermission`,
/// `getNotificationSettings`, `onMessage`, `onMessageOpenedApp`,
/// `onBackgroundMessage`, and `getInitialMessage`) while routing token, topic,
/// visibility, and message-delivery traffic through the hosted `MessagingBroker`.
class FirebaseMessaging {
  FirebaseMessaging._({
    required this.app,
    required MessagingBridgeSession session,
  }) : _session = session {
    _liveInstances.add(this);
    _session.syncSubscriptions();
  }

  static FirebaseMessaging? _defaultInstance;
  static final Map<String, FirebaseMessaging> _instancesByKey =
      <String, FirebaseMessaging>{};
  static final Set<FirebaseMessaging> _liveInstances = <FirebaseMessaging>{};

  static PyricBridgeClient? _registeredBridgeClient;
  static String? _registeredRegistrationId;
  static String? _registeredRecipientId;

  static int _staticForegroundListeners = 0;
  static BackgroundMessageHandler? _backgroundMessageHandler;

  static final StreamController<RemoteMessage> _onMessageController =
      StreamController<RemoteMessage>.broadcast(
    onListen: _onStaticForegroundListen,
    onCancel: _onStaticForegroundCancel,
  );

  static final StreamController<RemoteMessage> _onMessageOpenedAppController =
      StreamController<RemoteMessage>.broadcast();

  /// Stream of [RemoteMessage] payloads delivered while the client is visible.
  static Stream<RemoteMessage> get onMessage => _onMessageController.stream;

  /// Stream of [RemoteMessage] payloads emitted when a notification opens the app.
  static Stream<RemoteMessage> get onMessageOpenedApp =>
      _onMessageOpenedAppController.stream;

  /// Registers a handler invoked when messages route to `messaging.background`.
  static void onBackgroundMessage(BackgroundMessageHandler handler) {
    _backgroundMessageHandler = handler;
    _ensureDefaultInstanceForStaticListeners();
    for (final inst in _liveInstances.toList(growable: false)) {
      inst._session.syncSubscriptions();
    }
  }

  /// Default [FirebaseMessaging] singleton for the default [FirebaseApp].
  static FirebaseMessaging get instance {
    final existing = _defaultInstance;
    if (existing != null && !existing._isDisposed) {
      return existing;
    }
    final created = _createInstance(
      app: _tryDefaultApp(),
      bridgeClient: null,
      registrationId: null,
      recipientId: null,
    );
    _defaultInstance = created;
    return created;
  }

  /// Returns a [FirebaseMessaging] instance scoped to [app] (and optional bridge overrides).
  static FirebaseMessaging instanceFor({
    FirebaseApp? app,
    PyricBridgeClient? bridgeClient,
    String? registrationId,
    String? recipientId,
  }) {
    final resolvedApp = app ?? _tryDefaultApp();
    final appName = resolvedApp?.name ?? defaultFirebaseAppName;
    final hasCustomOverrides = bridgeClient != null ||
        registrationId != null ||
        recipientId != null;

    if (!hasCustomOverrides && appName == defaultFirebaseAppName) {
      return instance;
    }

    if (!hasCustomOverrides) {
      final cached = _instancesByKey[appName];
      if (cached != null && !cached._isDisposed) {
        return cached;
      }
    }

    final created = _createInstance(
      app: resolvedApp,
      bridgeClient: bridgeClient,
      registrationId: registrationId,
      recipientId: recipientId,
    );
    if (!hasCustomOverrides) {
      _instancesByKey[appName] = created;
    }
    return created;
  }

  /// Registers shared bridge defaults used by subsequent [instance] and [instanceFor] calls.
  static void registerWith({
    PyricBridgeClient? bridgeClient,
    String? registrationId,
    String? recipientId,
  }) {
    _registeredBridgeClient = bridgeClient;
    _registeredRegistrationId = registrationId;
    _registeredRecipientId = recipientId;
    _defaultInstance = null;
    _instancesByKey.clear();
  }

  /// Disposes all cached instances, clears static handlers, and resets test state.
  static Future<void> clearInstancesForTest() async {
    final toDispose = _liveInstances.toList(growable: false);
    _liveInstances.clear();
    _defaultInstance = null;
    _instancesByKey.clear();
    _registeredBridgeClient = null;
    _registeredRegistrationId = null;
    _registeredRecipientId = null;
    _backgroundMessageHandler = null;
    for (final inst in toDispose) {
      await inst.dispose();
    }
  }

  static FirebaseMessaging _createInstance({
    required FirebaseApp? app,
    required PyricBridgeClient? bridgeClient,
    required String? registrationId,
    required String? recipientId,
  }) {
    final appName = app?.name ?? defaultFirebaseAppName;
    final isDefaultApp = appName == defaultFirebaseAppName;
    final effectiveRegId = registrationId ??
        (isDefaultApp ? _registeredRegistrationId : 'flutter-reg-$appName');
    final effectiveRecipientId = recipientId ??
        (isDefaultApp ? _registeredRecipientId : 'flutter-app-$appName');
    final session = MessagingBridgeSession.resolve(
      explicitBridge: bridgeClient,
      registeredBridge: _registeredBridgeClient,
      registrationId: effectiveRegId,
      recipientId: effectiveRecipientId,
      wantsStaticForeground: () => _staticForegroundListeners > 0,
      onStaticForegroundMessage: (message) {
        if (_staticForegroundListeners > 0 && !_onMessageController.isClosed) {
          _onMessageController.add(message);
        }
      },
      resolveStaticBackgroundHandler: () => _backgroundMessageHandler,
    );
    return FirebaseMessaging._(app: app, session: session);
  }

  static void _ensureDefaultInstanceForStaticListeners() {
    if (_liveInstances.isNotEmpty) return;
    final envUrl = readPlatformEnvironment('PYRIC_LIVE_BRIDGE_URL');
    final hasLiveTarget =
        _registeredBridgeClient != null || (envUrl != null && envUrl.isNotEmpty);
    if (hasLiveTarget) {
      instance;
    }
  }

  static void _onStaticForegroundListen() {
    _staticForegroundListeners++;
    _ensureDefaultInstanceForStaticListeners();
    for (final inst in _liveInstances.toList(growable: false)) {
      inst._session.syncSubscriptions();
    }
  }

  static void _onStaticForegroundCancel() {
    if (_staticForegroundListeners > 0) {
      _staticForegroundListeners--;
    }
    for (final inst in _liveInstances.toList(growable: false)) {
      inst._session.syncSubscriptions();
    }
  }

  static FirebaseApp? _tryDefaultApp() {
    try {
      return Firebase.app();
    } catch (_) {
      return null;
    }
  }

  /// Associated [FirebaseApp], if initialized.
  final FirebaseApp? app;

  final MessagingBridgeSession _session;
  bool _isDisposed = false;

  bool _isAutoInitEnabled = true;
  bool _deliveryMetricsExportToBigQuery = false;
  bool _isSupportedFlag = true;
  String? _apnsToken;
  String? _activeToken;
  String? _lastEmittedToken;
  RemoteMessage? _pendingInitialMessage;

  NotificationSettings _notificationSettings =
      const NotificationSettings.authorizedDefaults();
  ForegroundPresentationOptions _foregroundOptions =
      const ForegroundPresentationOptions();

  final StreamController<String> _tokenRefreshController =
      StreamController<String>.broadcast();

  /// Underlying [PyricBridgeClient] used by this Messaging instance.
  PyricBridgeClient get bridgeClient => _session.bridgeClient;

  /// Whether automatic token initialization is enabled on this instance.
  bool get isAutoInitEnabled => _isAutoInitEnabled;

  /// Whether BigQuery delivery metrics export is enabled on this instance.
  bool get isDeliveryMetricsExportToBigQueryEnabled =>
      _deliveryMetricsExportToBigQuery;

  /// Current Apple foreground notification presentation options.
  ForegroundPresentationOptions get foregroundPresentationOptions =>
      _foregroundOptions;

  /// Stream emitting whenever this instance mints a new or rotated FCM token.
  Stream<String> get onTokenRefresh => _tokenRefreshController.stream;

  /// Instance-scoped foreground message stream (useful for multi-app isolation).
  Stream<RemoteMessage> get onForegroundMessage =>
      _session.instanceForegroundController.stream;

  /// Registers an instance-scoped background handler (useful for multi-app isolation).
  void onInstanceBackgroundMessage(BackgroundMessageHandler? handler) {
    _session.instanceBackgroundHandler = handler;
    _session.syncSubscriptions();
  }

  /// Connects this [FirebaseMessaging] instance to `ws://<host>:<port>/__pyric/sandbox`.
  Future<void> useMessagingEmulator(String host, int port) async {
    _ensureNotDisposed();
    await _session.useEmulator(host, port);
  }

  /// Returns whether Cloud Messaging is supported in the current environment.
  Future<bool> isSupported() async => _isSupportedFlag;

  /// Overrides [isSupported] for deterministic unit testing.
  void setSupportedForTesting(bool supported) {
    _isSupportedFlag = supported;
  }

  /// Enables or disables automatic FCM token initialization.
  Future<void> setAutoInitEnabled(bool enabled) async {
    _ensureNotDisposed();
    final wasEnabled = _isAutoInitEnabled;
    _isAutoInitEnabled = enabled;
    if (!wasEnabled && enabled && _session.isReadyForAutoInit) {
      await getToken();
    }
  }

  /// Enables or disables BigQuery delivery metrics export.
  Future<void> setDeliveryMetricsExportToBigQuery(bool enabled) async {
    _ensureNotDisposed();
    _deliveryMetricsExportToBigQuery = enabled;
  }

  /// Configures foreground notification presentation options on Apple platforms.
  Future<void> setForegroundNotificationPresentationOptions({
    bool alert = false,
    bool badge = false,
    bool sound = false,
  }) async {
    _ensureNotDisposed();
    _foregroundOptions = ForegroundPresentationOptions(
      alert: alert,
      badge: badge,
      sound: sound,
    );
  }

  /// Returns the APNs device token if set (defaults to `null` outside Apple hardware).
  Future<String?> getAPNSToken() async {
    _ensureNotDisposed();
    return _apnsToken;
  }

  /// Sets a synthetic APNs token for testing Apple-specific code paths.
  void setAPNSTokenForTesting(String? token) {
    _apnsToken = token;
  }

  /// Requests user notification permissions and updates [getNotificationSettings].
  Future<NotificationSettings> requestPermission({
    bool alert = true,
    bool announcement = false,
    bool badge = true,
    bool carPlay = false,
    bool criticalAlert = false,
    bool provisional = false,
    bool sound = true,
    bool providesAppNotificationSettings = false,
  }) async {
    _ensureNotDisposed();
    if (_notificationSettings.authorizationStatus ==
        AuthorizationStatus.denied) {
      return _notificationSettings;
    }
    final status = provisional
        ? AuthorizationStatus.provisional
        : AuthorizationStatus.authorized;
    AppleNotificationSetting flag(bool enabled) => enabled
        ? AppleNotificationSetting.enabled
        : AppleNotificationSetting.disabled;

    _notificationSettings = NotificationSettings(
      alert: flag(alert),
      announcement: flag(announcement),
      authorizationStatus: status,
      badge: flag(badge),
      carPlay: flag(carPlay),
      lockScreen: flag(alert),
      notificationCenter: AppleNotificationSetting.enabled,
      showPreviews: AppleShowPreviewSetting.always,
      timeSensitive: AppleNotificationSetting.disabled,
      criticalAlert: flag(criticalAlert),
      sound: flag(sound),
      providesAppNotificationSettings: flag(providesAppNotificationSettings),
    );
    return _notificationSettings;
  }

  /// Overrides [AuthorizationStatus] (e.g. [AuthorizationStatus.denied]) for testing.
  void setAuthorizationStatusForTesting(AuthorizationStatus status) {
    final enabled = status == AuthorizationStatus.authorized ||
        status == AuthorizationStatus.provisional;
    final setting = enabled
        ? AppleNotificationSetting.enabled
        : AppleNotificationSetting.disabled;
    _notificationSettings = NotificationSettings(
      alert: setting,
      announcement: AppleNotificationSetting.disabled,
      authorizationStatus: status,
      badge: setting,
      carPlay: AppleNotificationSetting.disabled,
      lockScreen: setting,
      notificationCenter: setting,
      showPreviews: AppleShowPreviewSetting.always,
      timeSensitive: AppleNotificationSetting.disabled,
      criticalAlert: AppleNotificationSetting.disabled,
      sound: setting,
      providesAppNotificationSettings: AppleNotificationSetting.disabled,
    );
  }

  /// Returns the current [NotificationSettings] for this Messaging instance.
  Future<NotificationSettings> getNotificationSettings() async {
    _ensureNotDisposed();
    return _notificationSettings;
  }

  /// Returns the [RemoteMessage] that cold-launched the app from a notification
  /// tap, consuming it so subsequent calls return `null`.
  Future<RemoteMessage?> getInitialMessage() async {
    _ensureNotDisposed();
    final message = _pendingInitialMessage;
    _pendingInitialMessage = null;
    return message;
  }

  /// Simulates a user tapping a notification: stages [getInitialMessage] when
  /// [asInitialMessage] is `true`, or emits on [onMessageOpenedApp] otherwise.
  void simulateNotificationOpen(
    RemoteMessage message, {
    bool asInitialMessage = false,
  }) {
    _ensureNotDisposed();
    if (asInitialMessage) {
      _pendingInitialMessage = message;
      return;
    }
    if (!_onMessageOpenedAppController.isClosed) {
      _onMessageOpenedAppController.add(message);
    }
  }

  /// Mints or returns the stable FCM registration token for this instance.
  Future<String?> getToken({String? vapidKey}) async {
    _ensureNotDisposed();
    if (!_isSupportedFlag) {
      return null;
    }
    if (_notificationSettings.authorizationStatus ==
        AuthorizationStatus.denied) {
      throw FirebaseException(
        plugin: firebaseMessagingPluginName,
        code: 'permission-blocked',
        message:
            'Messaging: The notification permission was not granted and blocked instead.',
      );
    }
    if (vapidKey != null && vapidKey.trim().isEmpty) {
      throw FirebaseException(
        plugin: firebaseMessagingPluginName,
        code: 'invalid-vapid-key',
        message: 'Messaging: vapidKey must not be empty when supplied.',
      );
    }

    final regId = _session.registrationId;
    final recId = _session.recipientId;
    final response = await _session.runOp('messaging.getToken', <String, dynamic>{
      if (regId != null) 'registrationId': regId,
      if (recId != null) 'recipientId': recId,
    });
    final token = response is Map
        ? response['token'] as String?
        : response as String?;
    _activeToken = token;
    if (token != null && token.isNotEmpty && token != _lastEmittedToken) {
      _lastEmittedToken = token;
      if (!_tokenRefreshController.isClosed) {
        _tokenRefreshController.add(token);
      }
    }
    return token;
  }

  /// Invalidates the current registration token on the hosted `MessagingBroker`.
  Future<void> deleteToken() async {
    _ensureNotDisposed();
    final regId = _session.registrationId;
    await _session.runOp('messaging.deleteToken', <String, dynamic>{
      if (regId != null) 'registrationId': regId,
    });
    _activeToken = null;
  }

  /// Subscribes this instance's registration token to [topic].
  Future<void> subscribeToTopic(String topic) async {
    _ensureNotDisposed();
    validateAndNormalizeTopic(topic);
    final token = _activeToken ?? await getToken();
    if (token == null || token.isEmpty) {
      throw FirebaseException(
        plugin: firebaseMessagingPluginName,
        code: 'token-unavailable',
        message: 'Unable to obtain an FCM registration token for topic "$topic".',
      );
    }
    final res =
        await _session.runOp('messaging.subscribeToTopic', <String, dynamic>{
      'tokens': <String>[token],
      'topic': topic,
    });
    _session.checkTopicOutcome(res, topic);
  }

  /// Unsubscribes this instance's registration token from [topic].
  Future<void> unsubscribeFromTopic(String topic) async {
    _ensureNotDisposed();
    validateAndNormalizeTopic(topic);
    final token = _activeToken ?? (_isAutoInitEnabled ? await getToken() : null);
    if (token == null || token.isEmpty) {
      return;
    }
    final res = await _session.runOp(
      'messaging.unsubscribeFromTopic',
      <String, dynamic>{
        'tokens': <String>[token],
        'topic': topic,
      },
    );
    _session.checkTopicOutcome(res, topic, allowUnregistered: true);
  }

  /// Reports this client's visibility (`'visible'` or `'hidden'`) to the broker.
  Future<void> setVisibility(String state) async {
    _ensureNotDisposed();
    final validated = validateVisibilityState(state);
    final recId = _session.recipientId;
    await _session.runOp('messaging.setVisibility', <String, dynamic>{
      'state': validated,
      if (recId != null) 'recipientId': recId,
    });
  }

  /// Injects a message directly into this recipient's client delivery plane.
  Future<MessagingDeliveryResult> deliver({
    Map<String, String>? data,
    Map<String, String>? notification,
    String? visibilityState,
    String? from,
    String? messageId,
  }) async {
    _ensureNotDisposed();
    if (visibilityState != null) {
      validateVisibilityState(visibilityState);
    }
    final recId = _session.recipientId;
    final res = await _session.runOp('messaging.deliver', <String, dynamic>{
      'spec': <String, dynamic>{
        if (visibilityState != null) 'visibilityState': visibilityState,
        if (data != null) 'data': data,
        if (notification != null) 'notification': notification,
        if (from != null) 'from': from,
        if (messageId != null) 'messageId': messageId,
      },
      if (recId != null) 'recipientId': recId,
    });
    return MessagingDeliveryResult.fromMap(
      res is Map ? Map<String, dynamic>.from(res) : const <String, dynamic>{},
    );
  }

  /// Sends a raw FCM v1 broker message (`token`, `topic`, or `condition`).
  Future<AcceptedMessagingSend> sendBrokerMessage(
    Map<String, dynamic> message, {
    bool? validateOnly,
  }) async {
    _ensureNotDisposed();
    final res = await _session.runOp('messaging.send', <String, dynamic>{
      'message': message,
      if (validateOnly != null) 'validateOnly': validateOnly,
    });
    return AcceptedMessagingSend.fromMap(
      res is Map ? Map<String, dynamic>.from(res) : const <String, dynamic>{},
    );
  }

  /// Cancels active bridge subscriptions and disconnects owned transport clients.
  Future<void> dispose() async {
    if (_isDisposed) return;
    _isDisposed = true;
    _liveInstances.remove(this);
    if (identical(_defaultInstance, this)) {
      _defaultInstance = null;
    }
    _instancesByKey.removeWhere((_, value) => identical(value, this));
    await _tokenRefreshController.close();
    await _session.dispose();
  }

  void _ensureNotDisposed() {
    if (_isDisposed) {
      throw FirebaseException(
        plugin: firebaseMessagingPluginName,
        code: 'disposed',
        message: 'This FirebaseMessaging instance has been disposed.',
      );
    }
  }
}
