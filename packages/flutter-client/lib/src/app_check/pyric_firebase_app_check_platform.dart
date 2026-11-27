import 'dart:async';

import 'package:firebase_app_check_platform_interface/firebase_app_check_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart';

import '../transport/bridge_client.dart';
import 'app_check_wire_codec.dart';

/// Concrete [FirebaseAppCheckPlatform] minting RS256 App Check JWTs over the Pyric WebSocket bridge.
class PyricFirebaseAppCheckPlatform extends FirebaseAppCheckPlatform {
  static final Map<String, PyricFirebaseAppCheckPlatform> _delegatesByAppName =
      <String, PyricFirebaseAppCheckPlatform>{};

  PyricBridgeClient _bridgeClient;
  bool _ownsBridgeClient;
  final int Function() _clockMillis;

  String _providerKind = 'debug';
  String? _debugToken;
  String? _siteKey;
  bool _isActivated = false;
  bool _isTokenAutoRefreshEnabled;
  bool _isDisposed = false;

  static const String _placeholderToken = 'eyJlcnJvciI6IlVOS05PV05fRVJST1IifQ==';
  static const int _minAutoRefreshDelayMillis = 50;

  DecodedAppCheckToken? _cachedToken;
  String? _lastEmittedToken;
  Future<DecodedAppCheckToken>? _inFlightStandardFetch;
  int _mintGeneration = 0;
  Timer? _autoRefreshTimer;
  BridgeAppCheckTokenProvider? _registeredBridgeProvider;

  final StreamController<String?> _onTokenChangeController =
      StreamController<String?>.broadcast();

  PyricFirebaseAppCheckPlatform({
    super.appInstance,
    PyricBridgeClient? bridgeClient,
    bool isTokenAutoRefreshEnabled = true,
    int Function()? clockMillis,
  })  : _bridgeClient = bridgeClient ?? PyricBridgeClient(),
        _ownsBridgeClient = bridgeClient == null,
        _isTokenAutoRefreshEnabled = isTokenAutoRefreshEnabled,
        _clockMillis = clockMillis ?? (() => DateTime.now().millisecondsSinceEpoch);

  /// Access the underlying Pyric WebSocket bridge client.
  PyricBridgeClient get bridgeClient => _bridgeClient;

  /// Currently configured wire provider identifier (for example `debug`, `play-integrity`, `app-attest`).
  String get providerKind => _providerKind;

  /// Optional debug token supplied at [activate] time.
  String? get debugToken => _debugToken;

  /// Optional reCAPTCHA site key supplied at [activate] time.
  String? get siteKey => _siteKey;

  /// Whether [activate] has been called on this instance.
  bool get isActivated => _isActivated;

  /// Whether proactive background token refresh is enabled.
  bool get isTokenAutoRefreshEnabled => _isTokenAutoRefreshEnabled;

  /// Registers [PyricFirebaseAppCheckPlatform] as [FirebaseAppCheckPlatform.instance].
  static PyricFirebaseAppCheckPlatform registerWith({
    PyricBridgeClient? bridgeClient,
    bool isTokenAutoRefreshEnabled = true,
    int Function()? clockMillis,
  }) {
    _delegatesByAppName.clear();
    final root = PyricFirebaseAppCheckPlatform(
      bridgeClient: bridgeClient,
      isTokenAutoRefreshEnabled: isTokenAutoRefreshEnabled,
      clockMillis: clockMillis,
    );
    FirebaseAppCheckPlatform.instance = root;
    return root;
  }

  /// Clears cached per-[FirebaseApp] delegates between test runs.
  static Future<void> clearInstancesForTest() async {
    final delegates = _delegatesByAppName.values.toList();
    _delegatesByAppName.clear();
    for (final delegate in delegates) {
      await delegate.dispose();
    }
  }

  @override
  FirebaseAppCheckPlatform delegateFor({required FirebaseApp app}) {
    return _delegatesByAppName.putIfAbsent(app.name, () {
      return PyricFirebaseAppCheckPlatform(
        appInstance: app,
        bridgeClient: _bridgeClient,
        isTokenAutoRefreshEnabled: _isTokenAutoRefreshEnabled,
        clockMillis: _clockMillis,
      );
    });
  }

  @override
  FirebaseAppCheckPlatform setInitialValues() {
    return this;
  }

  /// Connects this instance to a specific Pyric bridge host and port (`ws://<host>:<port>/__pyric/sandbox`).
  Future<void> useAppCheckEmulator(String host, int port) async {
    _checkNotDisposed();
    if (host.trim().isEmpty || port <= 0 || port > 65535) {
      throw FirebaseException(
        plugin: 'firebase_app_check',
        code: 'invalid-argument',
        message: 'Invalid App Check bridge endpoint: $host:$port',
      );
    }
    final normalizedHost = host.contains(':') && !host.startsWith('[') ? '[$host]' : host;
    final endpoint = Uri.parse('ws://$normalizedHost:$port/__pyric/sandbox');
    final nextClient = PyricBridgeClient(
      uri: endpoint,
      headers: <String, dynamic>{'Host': '$normalizedHost:$port'},
    );
    final previousClient = _bridgeClient;
    final ownedPrevious = _ownsBridgeClient;
    _unbindFromBridgeClient(previousClient);
    _bridgeClient = nextClient;
    _ownsBridgeClient = true;
    _mintGeneration++;
    _cachedToken = null;
    _inFlightStandardFetch = null;
    _cancelAutoRefreshTimer();
    if (_isActivated) {
      _bindToBridgeClient(nextClient);
    }
    if (ownedPrevious) {
      await previousClient.disconnect();
    }
    await _bridgeClient.connect();
  }

  @override
  Future<void> activate({
    WebProvider? webProvider,
    @Deprecated(
      'Use providerAndroid instead. '
      'This parameter will be removed in a future major release.',
    )
    AndroidProvider? androidProvider,
    @Deprecated(
      'Use providerApple instead. '
      'This parameter will be removed in a future major release.',
    )
    AppleProvider? appleProvider,
    AndroidAppCheckProvider? providerAndroid,
    AppleAppCheckProvider? providerApple,
    WindowsAppCheckProvider? providerWindows,
  }) async {
    _checkNotDisposed();
    final resolved = resolveAppCheckActivation(
      webProvider: webProvider,
      androidProvider: androidProvider,
      appleProvider: appleProvider,
      providerAndroid: providerAndroid,
      providerApple: providerApple,
      providerWindows: providerWindows,
    );
    final configChanged = _providerKind != resolved.provider ||
        _debugToken != resolved.debugToken ||
        _siteKey != resolved.siteKey;
    if (_isActivated && configChanged) {
      _mintGeneration++;
      _cachedToken = null;
      _inFlightStandardFetch = null;
      _cancelAutoRefreshTimer();
    }
    _providerKind = resolved.provider;
    _debugToken = resolved.debugToken;
    _siteKey = resolved.siteKey;
    _isActivated = true;
    _bindToBridgeClient(_bridgeClient);
    _scheduleAutoRefreshIfNeeded();
  }

  @override
  Future<String?> getToken(bool forceRefresh) async {
    final result = await _resolveStandardToken(forceRefresh);
    return result.token;
  }

  @override
  Future<AppCheckTokenResult?> getTokenResult(bool forceRefresh) async {
    final result = await _resolveStandardToken(forceRefresh);
    return result.toTokenResult();
  }

  @override
  Future<String> getLimitedUseToken() async {
    _checkNotDisposed();
    try {
      await _ensureBridgeConnected();
      final raw = await _bridgeClient.op(
        'appCheck.getLimitedUseToken',
        _baseWireParams(),
      );
      final decoded = decodeWireAppCheckToken(raw, nowMillis: _clockMillis());
      return decoded.token;
    } catch (error, stackTrace) {
      throw mapToAppCheckFirebaseException(error, stackTrace);
    }
  }

  @override
  Future<void> setTokenAutoRefreshEnabled(bool isTokenAutoRefreshEnabled) async {
    _checkNotDisposed();
    _isTokenAutoRefreshEnabled = isTokenAutoRefreshEnabled;
    if (!_isTokenAutoRefreshEnabled) {
      _cancelAutoRefreshTimer();
    } else {
      _scheduleAutoRefreshIfNeeded();
    }
  }

  @override
  Stream<String?> get onTokenChange => _onTokenChangeController.stream;

  /// Dispatches a bridge operation with a fresh or cached `appCheckToken` attached unless already supplied.
  Future<dynamic> opWithAppCheck(
    String method,
    Map<String, dynamic> params, {
    bool limitedUse = false,
    Map<String, dynamic>? actAs,
    Duration? timeout,
  }) async {
    _checkNotDisposed();
    final mergedParams = Map<String, dynamic>.from(params);
    final existingToken = mergedParams['appCheckToken'];
    if (existingToken is! String || existingToken.isEmpty) {
      final token = limitedUse
          ? await getLimitedUseToken()
          : await getToken(false);
      if (token != null && token.isNotEmpty) {
        mergedParams['appCheckToken'] = token;
      }
    }
    await _ensureBridgeConnected();
    return _bridgeClient.op(
      method,
      mergedParams,
      actAs: actAs,
      timeout: timeout,
    );
  }

  @override
  Future<void> dispose() async {
    if (_isDisposed) {
      return;
    }
    _isDisposed = true;
    _mintGeneration++;
    _inFlightStandardFetch = null;
    _unbindFromBridgeClient(_bridgeClient);
    _cancelAutoRefreshTimer();
    final boundApp = appInstance;
    if (boundApp != null && identical(_delegatesByAppName[boundApp.name], this)) {
      _delegatesByAppName.remove(boundApp.name);
    }
    await _onTokenChangeController.close();
    if (_ownsBridgeClient) {
      await _bridgeClient.disconnect();
    }
  }

  Future<DecodedAppCheckToken> _resolveStandardToken(bool forceRefresh) async {
    _checkNotDisposed();
    final nowMillis = _clockMillis();
    final existingCached = _cachedToken;
    if (!forceRefresh && existingCached != null && existingCached.isFreshAt(nowMillis)) {
      return existingCached;
    }
    if (!forceRefresh && _inFlightStandardFetch != null) {
      return _inFlightStandardFetch!;
    }

    final fetchFuture = _fetchStandardTokenFromBridge(forceRefresh: forceRefresh);
    if (!forceRefresh) {
      _inFlightStandardFetch = fetchFuture;
    }
    try {
      return await fetchFuture;
    } finally {
      if (identical(_inFlightStandardFetch, fetchFuture)) {
        _inFlightStandardFetch = null;
      }
    }
  }

  Future<DecodedAppCheckToken> _fetchStandardTokenFromBridge({
    required bool forceRefresh,
  }) async {
    final capturedGeneration = ++_mintGeneration;
    try {
      await _ensureBridgeConnected();
      final params = _baseWireParams()..['forceRefresh'] = forceRefresh;
      final raw = await _bridgeClient.op('appCheck.getToken', params);
      final decoded = decodeWireAppCheckToken(raw, nowMillis: _clockMillis());
      if (!_isDisposed && capturedGeneration == _mintGeneration) {
        _cachedToken = decoded;
        if (decoded.token != _lastEmittedToken) {
          _lastEmittedToken = decoded.token;
          _onTokenChangeController.add(decoded.token);
        }
        _scheduleAutoRefreshIfNeeded();
      }
      return decoded;
    } catch (error, stackTrace) {
      throw mapToAppCheckFirebaseException(error, stackTrace);
    }
  }

  void _bindToBridgeClient(PyricBridgeClient client) {
    final provider = _registeredBridgeProvider ??= () async {
      if (_isDisposed || !_isActivated) return null;
      try {
        return await getToken(false);
      } catch (_) {
        return _placeholderToken;
      }
    };
    client.appCheckTokenProvider = provider;
  }

  void _unbindFromBridgeClient(PyricBridgeClient client) {
    final registered = _registeredBridgeProvider;
    if (registered != null && identical(client.appCheckTokenProvider, registered)) {
      client.appCheckTokenProvider = null;
    }
  }

  Map<String, dynamic> _baseWireParams() {
    final params = <String, dynamic>{
      'provider': _providerKind,
    };
    final targetApp = _tryResolveApp();
    if (targetApp != null) {
      final appId = targetApp.options.appId.trim();
      if (appId.isNotEmpty) {
        params['appId'] = appId;
      }
      final projectId = targetApp.options.projectId.trim();
      if (projectId.isNotEmpty) {
        params['projectId'] = projectId;
      }
    }
    return params;
  }

  FirebaseApp? _tryResolveApp() {
    if (appInstance != null) {
      return appInstance;
    }
    try {
      return Firebase.app();
    } catch (_) {
      return null;
    }
  }

  Future<void> _ensureBridgeConnected() async {
    if (!_bridgeClient.isConnected) {
      await _bridgeClient.connect();
    }
  }

  void _scheduleAutoRefreshIfNeeded() {
    _cancelAutoRefreshTimer();
    if (_isDisposed || !_isTokenAutoRefreshEnabled) {
      return;
    }
    final cached = _cachedToken;
    if (cached == null) {
      return;
    }
    final nowMillis = _clockMillis();
    final remainingMillis = cached.expireTimeMillis - nowMillis;
    if (remainingMillis <= 0) {
      return;
    }
    final int delayMillis;
    if (remainingMillis > appCheckRefreshBufferMillis) {
      delayMillis = remainingMillis - appCheckRefreshBufferMillis;
    } else {
      final rawDelay = remainingMillis - (remainingMillis ~/ 2);
      delayMillis = rawDelay > _minAutoRefreshDelayMillis
          ? rawDelay
          : _minAutoRefreshDelayMillis;
    }
    _autoRefreshTimer = Timer(Duration(milliseconds: delayMillis), () {
      if (_isDisposed || !_isTokenAutoRefreshEnabled) {
        return;
      }
      unawaited(
        _fetchStandardTokenFromBridge(forceRefresh: true).catchError((Object _) {
          return cached;
        }),
      );
    });
  }

  void _cancelAutoRefreshTimer() {
    _autoRefreshTimer?.cancel();
    _autoRefreshTimer = null;
  }

  void _checkNotDisposed() {
    if (_isDisposed) {
      throw FirebaseException(
        plugin: 'firebase_app_check',
        code: 'disposed',
        message: 'PyricFirebaseAppCheckPlatform instance has already been disposed.',
      );
    }
  }
}
