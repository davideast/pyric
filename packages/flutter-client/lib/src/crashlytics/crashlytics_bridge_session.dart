import 'dart:io' show Platform;

import 'package:firebase_app_check_platform_interface/firebase_app_check_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart';

import '../app_check/pyric_firebase_app_check_platform.dart';
import '../transport/bridge_client.dart';
import 'crashlytics_types.dart';
import 'crashlytics_wire_codec.dart';

/// Internal WebSocket bridge and App Check token session for one [FirebaseCrashlytics] instance.
class CrashlyticsBridgeSession {
  CrashlyticsBridgeSession({
    required PyricBridgeClient bridgeClient,
    required bool ownsBridgeClient,
    required bool hasConfiguredBridge,
    required FirebaseApp? app,
    required FirebaseAppCheckPlatform? explicitAppCheck,
  })  : _bridgeClient = bridgeClient,
        _ownsBridgeClient = ownsBridgeClient,
        _hasConfiguredBridge = hasConfiguredBridge,
        _app = app,
        _explicitAppCheck = explicitAppCheck;

  factory CrashlyticsBridgeSession.resolve({
    required FirebaseApp? app,
    required PyricBridgeClient? explicitBridge,
    required PyricBridgeClient? registeredBridge,
    required FirebaseAppCheckPlatform? explicitAppCheck,
    required FirebaseAppCheckPlatform? registeredAppCheck,
  }) {
    final effectiveAppCheck = explicitAppCheck ?? registeredAppCheck;
    if (explicitBridge != null) {
      return CrashlyticsBridgeSession(
        bridgeClient: explicitBridge,
        ownsBridgeClient: false,
        hasConfiguredBridge: true,
        app: app,
        explicitAppCheck: effectiveAppCheck,
      );
    }
    if (registeredBridge != null) {
      return CrashlyticsBridgeSession(
        bridgeClient: registeredBridge,
        ownsBridgeClient: false,
        hasConfiguredBridge: true,
        app: app,
        explicitAppCheck: effectiveAppCheck,
      );
    }
    if (effectiveAppCheck is PyricFirebaseAppCheckPlatform) {
      return CrashlyticsBridgeSession(
        bridgeClient: effectiveAppCheck.bridgeClient,
        ownsBridgeClient: false,
        hasConfiguredBridge: true,
        app: app,
        explicitAppCheck: effectiveAppCheck,
      );
    }
    final activatedAppCheck = _resolveActivatedRegisteredAppCheck(app);
    if (activatedAppCheck != null) {
      return CrashlyticsBridgeSession(
        bridgeClient: activatedAppCheck.bridgeClient,
        ownsBridgeClient: false,
        hasConfiguredBridge: true,
        app: app,
        explicitAppCheck: effectiveAppCheck,
      );
    }
    final envUri = _resolveLiveCrashlyticsBridgeUri();
    if (envUri != null) {
      return CrashlyticsBridgeSession(
        bridgeClient: PyricBridgeClient(
          uri: envUri,
          headers: <String, dynamic>{
            if (envUri.hasPort)
              'Host': '${envUri.host}:${envUri.port}'
            else
              'Host': envUri.host,
          },
        ),
        ownsBridgeClient: true,
        hasConfiguredBridge: true,
        app: app,
        explicitAppCheck: effectiveAppCheck,
      );
    }
    return CrashlyticsBridgeSession(
      bridgeClient: PyricBridgeClient(),
      ownsBridgeClient: true,
      hasConfiguredBridge: false,
      app: app,
      explicitAppCheck: effectiveAppCheck,
    );
  }

  static Uri? _resolveLiveCrashlyticsBridgeUri() {
    for (final key in const <String>[
      'PYRIC_LIVE_CRASHLYTICS_BRIDGE_URL',
      'PYRIC_LIVE_BRIDGE_URL',
      'PYRIC_BRIDGE_URL',
    ]) {
      final raw = Platform.environment[key]?.trim() ?? '';
      if (raw.isNotEmpty) {
        return Uri.parse(raw);
      }
    }
    return null;
  }

  static PyricFirebaseAppCheckPlatform? _resolveActivatedRegisteredAppCheck(
    FirebaseApp? app,
  ) {
    try {
      final root = FirebaseAppCheckPlatform.instance;
      if (root is! PyricFirebaseAppCheckPlatform) {
        return null;
      }
      if (app != null) {
        final delegate = FirebaseAppCheckPlatform.instanceFor(app: app);
        if (delegate is PyricFirebaseAppCheckPlatform && delegate.isActivated) {
          return delegate;
        }
      }
      if (root.isActivated) {
        return root;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  final FirebaseApp? _app;
  final FirebaseAppCheckPlatform? _explicitAppCheck;

  PyricBridgeClient _bridgeClient;
  bool _ownsBridgeClient;
  bool _hasConfiguredBridge;
  bool _isDisposed = false;

  PyricBridgeClient get bridgeClient => _bridgeClient;

  bool get hasLiveBridge =>
      !_isDisposed && (_hasConfiguredBridge || _bridgeClient.isConnected);

  bool get isDisposed => _isDisposed;

  Future<void> useEmulator(String host, int port) async {
    if (host.trim().isEmpty || port <= 0 || port > 65535) {
      throw FirebaseException(
        plugin: firebaseCrashlyticsPluginName,
        code: 'invalid-argument',
        message: 'Invalid Crashlytics bridge endpoint: $host:$port',
      );
    }
    final normalizedHost =
        host.contains(':') && !host.startsWith('[') ? '[$host]' : host;
    final endpoint = Uri.parse('ws://$normalizedHost:$port/__pyric/sandbox');
    final nextClient = PyricBridgeClient(
      uri: endpoint,
      headers: <String, dynamic>{'Host': '$normalizedHost:$port'},
    );
    final previous = _bridgeClient;
    final ownedPrevious = _ownsBridgeClient;
    _bridgeClient = nextClient;
    _ownsBridgeClient = true;
    _hasConfiguredBridge = true;
    if (ownedPrevious) {
      await previous.disconnect();
    }
    await _bridgeClient.connect();
  }

  Future<String?> resolveAppCheckToken() async {
    final explicit = _explicitAppCheck;
    if (explicit != null) {
      if (explicit is PyricFirebaseAppCheckPlatform && !explicit.isActivated) {
        return null;
      }
      try {
        final token = await explicit.getToken(false);
        if (token != null && token.isNotEmpty) {
          return token;
        }
      } catch (_) {
        return null;
      }
      return null;
    }

    final registered = _resolveActivatedRegisteredAppCheck(_app);
    if (registered != null) {
      try {
        final token = await registered.getToken(false);
        if (token != null && token.isNotEmpty) {
          return token;
        }
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  Future<dynamic> runOp(String method, Map<String, dynamic> params) async {
    try {
      final token = await resolveAppCheckToken();
      final payload = <String, dynamic>{
        ...params,
        if (token != null) 'appCheckToken': token,
      };
      return await _bridgeClient.op(method, payload);
    } catch (error, stackTrace) {
      Error.throwWithStackTrace(
        mapCrashlyticsBridgeException(error, stackTrace),
        stackTrace,
      );
    }
  }

  Future<void> dispose() async {
    if (_isDisposed) {
      return;
    }
    _isDisposed = true;
    if (_ownsBridgeClient) {
      await _bridgeClient.disconnect();
    }
  }
}
