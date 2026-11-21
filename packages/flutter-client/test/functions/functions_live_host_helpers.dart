import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase, FirebaseApp;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_app_check.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_functions.dart';

/// Default app ID used by `native-flutter-functions-conformance.test.ts`.
const String liveFunctionsAndroidAppId =
    '1:424242424242:android:flutterfunctionslive';

/// Minimal in-memory [FirebasePlatform] supporting [FirebaseApp] initialization
/// for offline and live-host Functions conformance tests.
class LiveFunctionsFirebasePlatform extends FirebasePlatform {
  static const FirebaseOptions defaultOptions = FirebaseOptions(
    apiKey: 'demo-flutter-functions-api-key',
    appId: liveFunctionsAndroidAppId,
    messagingSenderId: '424242424242',
    projectId: 'demo-flutter-functions-live',
  );

  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? defaultOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(name, defaultOptions),
    );
  }
}

/// Resolves the live bridge WebSocket URI when running under a live-host harness.
Uri? resolveLiveFunctionsBridgeUri() {
  final raw = Platform.environment['PYRIC_LIVE_BRIDGE_URL'] ??
      Platform.environment['PYRIC_BRIDGE_URL'];
  if (raw == null || raw.trim().isEmpty) {
    return null;
  }
  return Uri.parse(raw.trim());
}

/// Resolves the dedicated Functions HTTP gateway URL when running under
/// `native-flutter-functions-conformance.test.ts`.
Uri? resolveLiveFunctionsGatewayUri() {
  final raw = Platform.environment['PYRIC_LIVE_FUNCTIONS_URL'];
  if (raw == null || raw.trim().isEmpty) {
    return null;
  }
  return Uri.parse(raw.trim());
}

/// Resolves the active Firebase project ID from environment or defaults.
String resolveLiveFunctionsProjectId() {
  final raw = Platform.environment['PYRIC_LIVE_PROJECT_ID'];
  if (raw == null || raw.trim().isEmpty) {
    return 'demo-flutter-functions-live';
  }
  return raw.trim();
}

/// Asserts that [action] throws a [FirebaseFunctionsException] with [expectedCode].
Future<FirebaseFunctionsException> expectFunctionsExceptionCode(
  Future<Object?> Function() action,
  String expectedCode,
) async {
  try {
    await action();
  } on FirebaseFunctionsException catch (error) {
    expect(error.code, equals(expectedCode));
    return error;
  }
  fail('Expected FirebaseFunctionsException($expectedCode), but call succeeded.');
}

/// Shared setup and teardown harness for `functions_live_host_test.dart`.
class LiveFunctionsHarness {
  HttpOverrides? _previousHttpOverrides;
  Uri? bridgeUri;
  Uri? functionsGatewayUri;
  String projectId = 'demo-flutter-functions-live';
  FirebaseApp? liveApp;
  PyricBridgeClient? liveClient;
  PyricFirebaseAuthPlatform? liveAuth;
  PyricFirebaseAppCheckPlatform? liveAppCheck;
  FirebaseFunctions? liveFunctions;

  bool get isOffline => bridgeUri == null;
  bool get isDedicatedFunctionsHost => functionsGatewayUri != null;

  Future<void> setUp() async {
    _previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    await FirebaseFunctions.clearInstancesForTest();
    PyricFirebaseAppCheckPlatform.clearInstancesForTest();

    bridgeUri = resolveLiveFunctionsBridgeUri();
    functionsGatewayUri = resolveLiveFunctionsGatewayUri();
    projectId = resolveLiveFunctionsProjectId();
    FirebasePlatform.instance = LiveFunctionsFirebasePlatform();

    if (bridgeUri == null) {
      return;
    }

    liveApp = await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: 'demo-flutter-functions-api-key',
        appId: liveFunctionsAndroidAppId,
        messagingSenderId: '424242424242',
        projectId: projectId,
      ),
    );
    liveClient = PyricBridgeClient(
      uri: bridgeUri,
      headers: <String, dynamic>{
        'Host': '${bridgeUri!.host}:${bridgeUri!.port}',
      },
    );
    await liveClient!.connect();

    liveAuth = PyricFirebaseAuthPlatform(
      appInstance: liveApp,
      bridgeClient: liveClient,
    );
    FirebaseAuthPlatform.instance = liveAuth!;

    liveAppCheck = PyricFirebaseAppCheckPlatform.registerWith(
      bridgeClient: liveClient,
    ).delegateFor(app: liveApp!) as PyricFirebaseAppCheckPlatform;

    FirebaseFunctions.registerWith(
      bridgeClient: liveClient,
      authPlatform: liveAuth,
      appCheckPlatform: liveAppCheck,
      gatewayOrigin: functionsGatewayUri?.toString(),
    );
    liveFunctions = FirebaseFunctions.instanceFor(app: liveApp);
  }

  Future<void> tearDown() async {
    await FirebaseFunctions.clearInstancesForTest();
    PyricFirebaseAppCheckPlatform.clearInstancesForTest();
    await liveClient?.disconnect();
    liveClient = null;
    liveAuth = null;
    liveAppCheck = null;
    liveFunctions = null;
    HttpOverrides.global = _previousHttpOverrides;
  }
}
