import 'package:firebase_app_check_platform_interface/firebase_app_check_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart';

import '../app_check/pyric_firebase_app_check_platform.dart';
import '../transport/bridge_client.dart';
import 'ai_config.dart';
import 'ai_content.dart';
import 'ai_exception.dart';
import 'generative_model.dart';

const String _defaultVertexLocation = 'us-central1';

/// Backend service family targeted by a [FirebaseAI] instance.
enum FirebaseAIBackendType {
  googleAI,
  vertexAI,
}

/// Entry point for Pyric Flutter Firebase AI Logic (`googleAI` and `vertexAI`).
final class FirebaseAI {
  static final Map<String, FirebaseAI> _instancesByKey = <String, FirebaseAI>{};
  static PyricBridgeClient? _registeredBridgeClient;
  static Map<String, dynamic>? _registeredDefaultEngine;

  /// Bound [FirebaseApp], if initialized or supplied.
  final FirebaseApp? app;

  /// Configured backend type (`googleAI` or `vertexAI`).
  final FirebaseAIBackendType backendType;

  /// Configured Vertex AI region (`us-central1` by default on Vertex AI, empty on Google AI).
  final String location;

  /// Whether each request fetches a single-use App Check token instead of a cached standard token.
  final bool useLimitedUseAppCheckTokens;

  final FirebaseAppCheckPlatform? _explicitAppCheck;
  PyricBridgeClient _bridgeClient;
  bool _ownsBridgeClient;
  final Map<String, dynamic>? _engineWire;

  FirebaseAI._({
    required this.app,
    required this.backendType,
    required this.location,
    required this.useLimitedUseAppCheckTokens,
    required FirebaseAppCheckPlatform? explicitAppCheck,
    required PyricBridgeClient bridgeClient,
    required bool ownsBridgeClient,
    required Map<String, dynamic>? engineWire,
  })  : _explicitAppCheck = explicitAppCheck,
        _bridgeClient = bridgeClient,
        _ownsBridgeClient = ownsBridgeClient,
        _engineWire = engineWire == null
            ? null
            : Map<String, dynamic>.unmodifiable(engineWire);

  /// Underlying Pyric WebSocket bridge client.
  PyricBridgeClient get bridgeClient => _bridgeClient;

  /// Registers a shared [PyricBridgeClient] (and optional default scripted/proxy
  /// `engine` wire config) used by subsequent [FirebaseAI] instances.
  static void registerWith({
    PyricBridgeClient? bridgeClient,
    Map<String, dynamic>? defaultEngine,
  }) {
    _instancesByKey.clear();
    _registeredBridgeClient = bridgeClient;
    _registeredDefaultEngine = defaultEngine == null
        ? null
        : Map<String, dynamic>.unmodifiable(defaultEngine);
  }

  /// Clears cached per-[FirebaseApp] [FirebaseAI] instances and disconnects
  /// owned bridge clients between test runs.
  static Future<void> clearInstancesForTest() async {
    final instances = _instancesByKey.values.toList(growable: false);
    _instancesByKey.clear();
    _registeredBridgeClient = null;
    _registeredDefaultEngine = null;
    for (final instance in instances) {
      await instance._disposeOwnedTransport();
    }
  }

  /// Returns a [FirebaseAI] instance targeting the Gemini Developer API (`googleAI`).
  static FirebaseAI googleAI({
    FirebaseApp? app,
    FirebaseAppCheckPlatform? appCheck,
    bool? useLimitedUseAppCheckTokens,
    PyricBridgeClient? bridgeClient,
    Map<String, dynamic>? engine,
  }) {
    return _instanceFor(
      app: app,
      backendType: FirebaseAIBackendType.googleAI,
      location: '',
      appCheck: appCheck,
      useLimitedUseAppCheckTokens: useLimitedUseAppCheckTokens ?? false,
      bridgeClient: bridgeClient,
      engine: engine,
    );
  }

  /// Returns a [FirebaseAI] instance targeting the Vertex AI Gemini API (`vertexAI`).
  static FirebaseAI vertexAI({
    FirebaseApp? app,
    FirebaseAppCheckPlatform? appCheck,
    String location = _defaultVertexLocation,
    bool? useLimitedUseAppCheckTokens,
    PyricBridgeClient? bridgeClient,
    Map<String, dynamic>? engine,
  }) {
    final trimmedLocation = location.trim();
    final effectiveLocation =
        trimmedLocation.isEmpty ? _defaultVertexLocation : trimmedLocation;
    return _instanceFor(
      app: app,
      backendType: FirebaseAIBackendType.vertexAI,
      location: effectiveLocation,
      appCheck: appCheck,
      useLimitedUseAppCheckTokens: useLimitedUseAppCheckTokens ?? false,
      bridgeClient: bridgeClient,
      engine: engine,
    );
  }

  static FirebaseAI _instanceFor({
    required FirebaseApp? app,
    required FirebaseAIBackendType backendType,
    required String location,
    required FirebaseAppCheckPlatform? appCheck,
    required bool useLimitedUseAppCheckTokens,
    required PyricBridgeClient? bridgeClient,
    required Map<String, dynamic>? engine,
  }) {
    final resolvedApp = app ?? _tryDefaultApp();
    final appKey = resolvedApp?.name ?? '[DEFAULT]';
    final backendKey = backendType == FirebaseAIBackendType.vertexAI
        ? 'vertexai/$location'
        : 'googleai';
    final cacheKey = '$appKey|$backendKey|$useLimitedUseAppCheckTokens';

    final usesSharedConfiguration = bridgeClient == null && engine == null;
    if (usesSharedConfiguration) {
      final cached = _instancesByKey[cacheKey];
      if (cached != null &&
          (appCheck == null || identical(cached._explicitAppCheck, appCheck))) {
        return cached;
      }
    }

    final resolvedBridge = _resolveBridgeClient(
      explicitBridge: bridgeClient,
      explicitAppCheck: appCheck,
      app: resolvedApp,
    );
    final instance = FirebaseAI._(
      app: resolvedApp,
      backendType: backendType,
      location: location,
      useLimitedUseAppCheckTokens: useLimitedUseAppCheckTokens,
      explicitAppCheck: appCheck,
      bridgeClient: resolvedBridge.client,
      ownsBridgeClient: resolvedBridge.ownsClient,
      engineWire: engine ?? _registeredDefaultEngine,
    );

    if (usesSharedConfiguration) {
      _instancesByKey[cacheKey] = instance;
    }
    return instance;
  }

  static ({PyricBridgeClient client, bool ownsClient}) _resolveBridgeClient({
    required PyricBridgeClient? explicitBridge,
    required FirebaseAppCheckPlatform? explicitAppCheck,
    required FirebaseApp? app,
  }) {
    if (explicitBridge != null) {
      return (client: explicitBridge, ownsClient: false);
    }
    final registered = _registeredBridgeClient;
    if (registered != null) {
      return (client: registered, ownsClient: false);
    }
    if (explicitAppCheck is PyricFirebaseAppCheckPlatform) {
      return (client: explicitAppCheck.bridgeClient, ownsClient: false);
    }
    final registeredAppCheck = _resolveActivatedRegisteredAppCheck(app);
    if (registeredAppCheck != null) {
      return (client: registeredAppCheck.bridgeClient, ownsClient: false);
    }
    return (client: PyricBridgeClient(), ownsClient: true);
  }

  static FirebaseApp? _tryDefaultApp() {
    try {
      return Firebase.app();
    } catch (_) {
      return null;
    }
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

  /// Connects this [FirebaseAI] instance to `ws://<host>:<port>/__pyric/sandbox`.
  Future<void> useAIEmulator(String host, int port) async {
    if (host.trim().isEmpty || port <= 0 || port > 65535) {
      throw FirebaseAIException(
        'Invalid AI bridge endpoint: $host:$port',
        code: 'invalid-argument',
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
    if (ownedPrevious) {
      await previous.disconnect();
    }
    await _bridgeClient.connect();
  }

  /// Creates a [GenerativeModel] configured against this backend and [FirebaseApp].
  GenerativeModel generativeModel({
    required String model,
    GenerationConfig? generationConfig,
    List<SafetySetting>? safetySettings,
    List<Tool>? tools,
    ToolConfig? toolConfig,
    Content? systemInstruction,
  }) {
    return GenerativeModel(
      modelName: model,
      isVertexAI: backendType == FirebaseAIBackendType.vertexAI,
      bridgeClient: _bridgeClient,
      appCheckResolver: _resolveAppCheckClaim,
      engineWire: _engineWire,
      generationConfig: generationConfig,
      safetySettings: safetySettings,
      tools: tools,
      toolConfig: toolConfig,
      systemInstruction: systemInstruction,
    );
  }

  Future<Map<String, dynamic>?> _resolveAppCheckClaim() async {
    final explicit = _explicitAppCheck;
    if (explicit != null) {
      if (explicit is PyricFirebaseAppCheckPlatform && !explicit.isActivated) {
        return const <String, dynamic>{'token': null};
      }
      final token = useLimitedUseAppCheckTokens
          ? await explicit.getLimitedUseToken()
          : await explicit.getToken(false);
      final normalized = (token == null || token.isEmpty) ? null : token;
      return <String, dynamic>{'token': normalized};
    }

    final registered = _resolveActivatedRegisteredAppCheck(app);
    if (registered != null) {
      final token = useLimitedUseAppCheckTokens
          ? await registered.getLimitedUseToken()
          : await registered.getToken(false);
      final normalized = (token == null || token.isEmpty) ? null : token;
      return <String, dynamic>{'token': normalized};
    }

    return null;
  }

  Future<void> _disposeOwnedTransport() async {
    if (_ownsBridgeClient) {
      await _bridgeClient.disconnect();
    }
  }
}
