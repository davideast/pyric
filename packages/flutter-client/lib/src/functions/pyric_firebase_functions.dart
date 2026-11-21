import 'dart:async';
import 'dart:io' show Platform;

import 'package:firebase_app_check_platform_interface/firebase_app_check_platform_interface.dart';
import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart';

import '../app_check/pyric_firebase_app_check_platform.dart';
import '../transport/bridge_client.dart';
import 'functions_http_transport.dart';
import 'functions_url.dart';
import 'https_callable.dart';

/// Optional async provider supplying an Auth ID token (`Authorization: Bearer <jwt>`).
typedef FunctionsAuthTokenProvider = Future<String?> Function();

/// Optional async provider supplying an App Check token (`X-Firebase-AppCheck: <jwt>`).
typedef FunctionsAppCheckTokenProvider = Future<String?> Function({
  required bool limitedUse,
});

/// Pure-Dart Cloud Functions callable client targeting Pyric's hosted `onCall` endpoint.
///
/// Mirrors the public API of FlutterFire's `cloud_functions` package
/// (`FirebaseFunctions.instance`, `FirebaseFunctions.instanceFor`,
/// `useFunctionsEmulator`, `httpsCallable`, `httpsCallableFromUrl`, and
/// `httpsCallableFromUri`).
class FirebaseFunctions {
  static FirebaseFunctions? _defaultInstance;
  static final Map<String, FirebaseFunctions> _instancesByKey =
      <String, FirebaseFunctions>{};

  static PyricBridgeClient? _registeredBridgeClient;
  static FirebaseAuthPlatform? _registeredAuthPlatform;
  static FirebaseAppCheckPlatform? _registeredAppCheckPlatform;
  static FunctionsHttpTransport? _registeredTransport;
  static String? _registeredGatewayOrigin;

  /// Associated [FirebaseApp], if initialized via `Firebase.initializeApp`.
  final FirebaseApp? app;

  final String? _explicitProjectId;
  final PyricBridgeClient? _bridgeClient;
  final FirebaseAuthPlatform? _authPlatform;
  final FirebaseAppCheckPlatform? _appCheckPlatform;
  final FunctionsAuthTokenProvider? _authTokenProvider;
  final FunctionsAppCheckTokenProvider? _appCheckTokenProvider;
  final FunctionsHttpTransport _transport;
  final bool _ownsTransport;

  /// Resolved Cloud Functions region (defaults to `'us-central1'`).
  final String region;

  /// Custom HTTP(S) domain URL if passed via `region` in [instanceFor].
  final String? customDomain;

  String? _emulatorOrigin;
  final String? _explicitGatewayOrigin;
  bool _isDisposed = false;
  final Completer<void> _cancelCompleter = Completer<void>();

  /// Creates a [FirebaseFunctions] client instance.
  FirebaseFunctions({
    this.app,
    String? projectId,
    String? region,
    PyricBridgeClient? bridgeClient,
    FirebaseAuthPlatform? authPlatform,
    FirebaseAppCheckPlatform? appCheckPlatform,
    FunctionsAuthTokenProvider? authTokenProvider,
    FunctionsAppCheckTokenProvider? appCheckTokenProvider,
    FunctionsHttpTransport? transport,
    String? gatewayOrigin,
  })  : _explicitProjectId = projectId,
        _bridgeClient = bridgeClient ?? _registeredBridgeClient,
        _authPlatform = authPlatform ?? _registeredAuthPlatform,
        _appCheckPlatform = appCheckPlatform ?? _registeredAppCheckPlatform,
        _authTokenProvider = authTokenProvider,
        _appCheckTokenProvider = appCheckTokenProvider,
        _transport =
            transport ?? _registeredTransport ?? DartIoFunctionsHttpTransport(),
        _ownsTransport = transport == null && _registeredTransport == null,
        _explicitGatewayOrigin = gatewayOrigin ?? _registeredGatewayOrigin,
        region = parseRegionOrCustomDomain(region).region,
        customDomain = parseRegionOrCustomDomain(region).customDomain;

  /// Default [FirebaseFunctions] instance for the default [FirebaseApp] and `'us-central1'`.
  static FirebaseFunctions get instance {
    return _defaultInstance ??= FirebaseFunctions(app: _tryDefaultApp());
  }

  /// Returns a cached [FirebaseFunctions] instance scoped to [app] and [region] (or custom domain).
  static FirebaseFunctions instanceFor({
    FirebaseApp? app,
    String? region,
    String? projectId,
    PyricBridgeClient? bridgeClient,
    FirebaseAuthPlatform? authPlatform,
    FirebaseAppCheckPlatform? appCheckPlatform,
    FunctionsAuthTokenProvider? authTokenProvider,
    FunctionsAppCheckTokenProvider? appCheckTokenProvider,
    FunctionsHttpTransport? transport,
    String? gatewayOrigin,
  }) {
    final resolvedApp = app ?? _tryDefaultApp();
    final effectiveRegion = region ?? defaultFunctionsRegion;
    final hasCustomOverrides = projectId != null ||
        bridgeClient != null ||
        authPlatform != null ||
        appCheckPlatform != null ||
        authTokenProvider != null ||
        appCheckTokenProvider != null ||
        transport != null ||
        gatewayOrigin != null;

    if (!hasCustomOverrides &&
        effectiveRegion == defaultFunctionsRegion &&
        (resolvedApp == null || resolvedApp.name == defaultFirebaseAppName)) {
      return instance;
    }

    final key = '${resolvedApp?.name ?? defaultFirebaseAppName}|$effectiveRegion';
    if (!hasCustomOverrides) {
      final existing = _instancesByKey[key];
      if (existing != null && !existing.isDisposed) {
        return existing;
      }
    }

    final created = FirebaseFunctions(
      app: resolvedApp,
      projectId: projectId,
      region: effectiveRegion,
      bridgeClient: bridgeClient,
      authPlatform: authPlatform,
      appCheckPlatform: appCheckPlatform,
      authTokenProvider: authTokenProvider,
      appCheckTokenProvider: appCheckTokenProvider,
      transport: transport,
      gatewayOrigin: gatewayOrigin,
    );
    if (!hasCustomOverrides) {
      _instancesByKey[key] = created;
    }
    return created;
  }

  /// Registers shared Pyric transport/Auth/AppCheck wiring for [instance] and [instanceFor].
  static void registerWith({
    PyricBridgeClient? bridgeClient,
    FirebaseAuthPlatform? authPlatform,
    FirebaseAppCheckPlatform? appCheckPlatform,
    FunctionsHttpTransport? transport,
    String? gatewayOrigin,
  }) {
    _registeredBridgeClient = bridgeClient;
    _registeredAuthPlatform = authPlatform;
    _registeredAppCheckPlatform = appCheckPlatform;
    _registeredTransport = transport;
    _registeredGatewayOrigin = gatewayOrigin;
    _defaultInstance = null;
    _instancesByKey.clear();
  }

  /// Resets all cached [FirebaseFunctions] instances and static registrations for test isolation.
  static Future<void> clearInstancesForTest() async {
    final toDispose = <FirebaseFunctions>[
      if (_defaultInstance != null) _defaultInstance!,
      ..._instancesByKey.values,
    ];
    _defaultInstance = null;
    _instancesByKey.clear();
    _registeredBridgeClient = null;
    _registeredAuthPlatform = null;
    _registeredAppCheckPlatform = null;
    _registeredTransport = null;
    _registeredGatewayOrigin = null;
    for (final fn in toDispose) {
      await fn.dispose();
    }
  }

  static FirebaseApp? _tryDefaultApp() {
    try {
      return Firebase.app();
    } catch (_) {
      return null;
    }
  }

  /// Whether [dispose] has been called on this instance.
  bool get isDisposed => _isDisposed;

  /// Effective Firebase project ID used when constructing callable gateway paths.
  String get projectId {
    final explicit = _explicitProjectId;
    if (explicit != null && explicit.isNotEmpty) {
      return explicit;
    }
    final appProject = app?.options.projectId;
    if (appProject != null && appProject.isNotEmpty) {
      return appProject;
    }
    final defaultProject = _tryDefaultApp()?.options.projectId;
    if (defaultProject != null && defaultProject.isNotEmpty) {
      return defaultProject;
    }
    final envProject = Platform.environment['PYRIC_LIVE_PROJECT_ID'];
    if (envProject != null && envProject.isNotEmpty) {
      return envProject;
    }
    return 'demo-no-project';
  }

  /// Points this [FirebaseFunctions] instance at a local Functions emulator or Pyric gateway.
  void useFunctionsEmulator(String host, int port) {
    _emulatorOrigin = normalizeEmulatorOrigin(host, port);
  }

  /// Returns an [HttpsCallable] targeting the named function [name].
  HttpsCallable httpsCallable(String name, {HttpsCallableOptions? options}) {
    return HttpsCallable.internal(
      options: options,
      context: _makeContext(
        () => resolveNamedCallableTarget(
          name: name,
          projectId: projectId,
          region: region,
          customDomain: customDomain,
          emulatorOrigin: _emulatorOrigin,
          gatewayOrigin: _effectiveGatewayOrigin,
        ),
      ),
    );
  }

  /// Returns an [HttpsCallable] targeting an explicit HTTP(S) [url].
  HttpsCallable httpsCallableFromUrl(
    String url, {
    HttpsCallableOptions? options,
  }) {
    return HttpsCallable.internal(
      options: options,
      context: _makeContext(
        () => resolveUrlCallableTarget(
          rawUrl: url,
          projectId: projectId,
          emulatorOrigin: _emulatorOrigin,
          gatewayOrigin: _effectiveGatewayOrigin,
        ),
      ),
    );
  }

  /// Returns an [HttpsCallable] targeting an explicit [uri].
  HttpsCallable httpsCallableFromUri(
    Uri uri, {
    HttpsCallableOptions? options,
  }) {
    return httpsCallableFromUrl(uri.toString(), options: options);
  }

  /// Cancels any in-flight callable requests on this instance and closes owned sockets.
  Future<void> dispose() async {
    if (_isDisposed) {
      return;
    }
    _isDisposed = true;
    if (!_cancelCompleter.isCompleted) {
      _cancelCompleter.complete();
    }
    if (_ownsTransport) {
      _transport.close();
    }
  }

  String? get _effectiveGatewayOrigin {
    if (_explicitGatewayOrigin != null && _explicitGatewayOrigin.isNotEmpty) {
      return _explicitGatewayOrigin;
    }
    final envUrl = Platform.environment['PYRIC_LIVE_FUNCTIONS_URL'];
    if (envUrl != null && envUrl.isNotEmpty) {
      return envUrl;
    }
    final bridge = _bridgeClient;
    if (bridge != null) {
      final wsUri = bridge.uri;
      final scheme = wsUri.scheme == 'wss' ? 'https' : 'http';
      return Uri(
        scheme: scheme,
        host: wsUri.host,
        port: wsUri.hasPort ? wsUri.port : null,
      ).toString();
    }
    return null;
  }

  CallableExecutionContext _makeContext(
    ResolvedCallableTarget Function() resolveTarget,
  ) {
    return CallableExecutionContext(
      resolveTarget: resolveTarget,
      buildHeaders: _buildCallableHeaders,
      getTransport: () => _transport,
      isDisposed: () => _isDisposed,
      cancelSignal: () => _cancelCompleter.future,
    );
  }

  Future<Map<String, String>> _buildCallableHeaders({
    required bool limitedUse,
  }) async {
    final headers = <String, String>{};

    try {
      final idToken = await _resolveAuthIdToken();
      if (idToken != null && idToken.isNotEmpty) {
        headers['Authorization'] = 'Bearer $idToken';
      }
    } catch (_) {
      // Matches Firebase Functions SDKs: leave Authorization off if Auth token lookup fails.
    }

    try {
      final appCheckToken = await _resolveAppCheckToken(limitedUse: limitedUse);
      if (appCheckToken != null && appCheckToken.isNotEmpty) {
        headers['X-Firebase-AppCheck'] = appCheckToken;
      }
    } catch (_) {
      if (limitedUse) {
        rethrow;
      }
    }

    return headers;
  }

  Future<String?> _resolveAuthIdToken() async {
    final customProvider = _authTokenProvider;
    if (customProvider != null) {
      return customProvider();
    }

    final explicitAuth = _authPlatform;
    if (explicitAuth != null) {
      final user = explicitAuth.currentUser;
      if (user == null) {
        return null;
      }
      return user.getIdToken(false);
    }

    try {
      final globalAuth = FirebaseAuthPlatform.instance;
      final targetAppName = app?.name ?? defaultFirebaseAppName;
      final authAppName = globalAuth.app.name;
      if (authAppName == targetAppName ||
          targetAppName == defaultFirebaseAppName) {
        final user = globalAuth.currentUser;
        if (user != null) {
          return await user.getIdToken(false);
        }
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  Future<String?> _resolveAppCheckToken({required bool limitedUse}) async {
    final customProvider = _appCheckTokenProvider;
    if (customProvider != null) {
      return customProvider(limitedUse: limitedUse);
    }

    FirebaseAppCheckPlatform? platform = _appCheckPlatform;
    if (platform == null) {
      try {
        platform = FirebaseAppCheckPlatform.instance;
      } catch (_) {
        platform = null;
      }
    }
    if (platform == null) {
      return null;
    }

    if (platform is PyricFirebaseAppCheckPlatform) {
      PyricFirebaseAppCheckPlatform target = platform;
      final boundApp = app;
      if (boundApp != null) {
        String? currentAppName;
        try {
          currentAppName = platform.app.name;
        } catch (_) {
          currentAppName = null;
        }
        if (currentAppName != boundApp.name) {
          final delegated = platform.delegateFor(app: boundApp);
          if (delegated is PyricFirebaseAppCheckPlatform) {
            target = delegated;
          }
        }
      }
      if (!target.isActivated) {
        return null;
      }
      if (limitedUse) {
        return target.getLimitedUseToken();
      }
      return target.getToken(false);
    }

    if (limitedUse) {
      return platform.getLimitedUseToken();
    }
    return platform.getToken(false);
  }
}

/// Alias matching Pyric's `PyricFirebase*` naming convention across Flutter services.
typedef PyricFirebaseFunctions = FirebaseFunctions;

/// Short alias matching `PyricDatabase` in `pyric_database.dart`.
typedef PyricFunctions = FirebaseFunctions;
