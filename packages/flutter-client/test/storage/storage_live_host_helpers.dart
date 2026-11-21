import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show Firebase, FirebaseApp;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_storage.dart';

/// Secondary app bucket configured on `HostedRuntime` in `native-flutter-storage-conformance.test.ts`.
const String liveSecondaryStorageBucket = 'demo-flutter-secondary.appspot.com';

/// Minimal in-memory [FirebasePlatform] supporting multiple named [FirebaseApp] instances
/// for live-host and offline Storage conformance tests.
class LiveStorageFirebasePlatform extends FirebasePlatform {
  static const FirebaseOptions defaultOptions = FirebaseOptions(
    apiKey: 'demo-flutter-live-api-key',
    appId: '1:424242424242:android:flutterstoragelive',
    messagingSenderId: '424242424242',
    projectId: 'demo-flutter-live',
    storageBucket: 'demo-flutter-live.appspot.com',
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

/// Shared lifecycle state and helpers for `storage_live_host_test.dart`.
class LiveStorageHarness {
  HttpOverrides? _previousHttpOverrides;
  Uri? bridgeUri;
  String projectId = 'demo-flutter-live';
  String defaultBucket = 'demo-flutter-live.appspot.com';
  FirebaseApp? liveApp;
  FirebaseApp? secondaryLiveApp;
  PyricBridgeClient? liveClient;
  PyricFirebaseAuthPlatform? liveAuth;
  PyricFirebaseStoragePlatform? liveStorage;
  PyricFirebaseStoragePlatform? liveCustomStorage;
  PyricFirebaseStoragePlatform? liveSecondaryStorage;
  String ownerUid = '';

  bool get isOffline => bridgeUri == null;
  bool get isDedicatedStorageHost => isDedicatedStorageLiveHost();

  PyricFirebaseStoragePlatform newAdminStorage() => PyricFirebaseStoragePlatform(
        appInstance: liveApp,
        bucket: defaultBucket,
        bridgeClient: liveClient,
        authLens: AuthLens.admin,
      );

  Future<void> setUp() async {
    _previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    bridgeUri = resolveLiveStorageBridgeUri();
    projectId = resolveLiveStorageProjectId();
    defaultBucket = '$projectId.appspot.com';
    FirebasePlatform.instance = LiveStorageFirebasePlatform();

    if (bridgeUri == null) {
      return;
    }

    liveApp = await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: 'demo-flutter-live-api-key',
        appId: '1:424242424242:android:flutterstoragelive',
        messagingSenderId: '424242424242',
        projectId: projectId,
        storageBucket: defaultBucket,
      ),
    );
    secondaryLiveApp = await Firebase.initializeApp(
      name: 'flutter-storage-secondary',
      options: FirebaseOptions(
        apiKey: 'demo-flutter-live-api-key-2',
        appId: '1:424242424242:ios:flutterstoragelive2',
        messagingSenderId: '424242424242',
        projectId: projectId,
        storageBucket: 'gs://$liveSecondaryStorageBucket',
      ),
    );
    liveClient = PyricBridgeClient(
      uri: bridgeUri,
      headers: <String, dynamic>{'Host': '${bridgeUri!.host}:${bridgeUri!.port}'},
    );
    await liveClient!.connect();

    if (isDedicatedStorageHost) {
      liveAuth = PyricFirebaseAuthPlatform(
        appInstance: liveApp,
        bridgeClient: liveClient,
      );
      PyricFirebaseAuthPlatform.registerWith(bridgeClient: liveClient);
      PyricFirebaseStoragePlatform.registerWith(
        bridgeClient: liveClient,
        credentialsProvider: liveAuth,
      );
      liveStorage = FirebaseStoragePlatform.instanceFor(
        app: liveApp!,
        bucket: '',
      ) as PyricFirebaseStoragePlatform;
      liveCustomStorage = FirebaseStoragePlatform.instanceFor(
        app: liveApp!,
        bucket: 'gs://flutter-custom-media',
      ) as PyricFirebaseStoragePlatform;
    } else {
      PyricFirebaseStoragePlatform.registerWith(bridgeClient: liveClient);
      liveStorage = FirebaseStoragePlatform.instanceFor(
        app: liveApp!,
        bucket: '',
      ) as PyricFirebaseStoragePlatform;
    }
    liveSecondaryStorage = FirebaseStoragePlatform.instanceFor(
      app: secondaryLiveApp!,
      bucket: '',
    ) as PyricFirebaseStoragePlatform;
  }

  Future<void> tearDown() async {
    await liveAuth?.dispose();
    await PyricFirebaseStoragePlatform.clearInstancesForTest();
    await liveClient?.disconnect();
    HttpOverrides.global = _previousHttpOverrides;
  }
}

/// Runs [action] with a clean scratch directory inside `.dart_tool/` and removes it afterward.
Future<void> withLiveScratchDir(
  String prefix,
  Future<void> Function(Directory dir) action,
) async {
  final base = Directory('.dart_tool/pyric_live_storage_scratch');
  if (!await base.exists()) {
    await base.create(recursive: true);
  }
  final dir = await base.createTemp(prefix);
  try {
    await action(dir);
  } finally {
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
  }
}

/// Resolves the live Pyric WebSocket bridge URI from environment variables when running against a host.
Uri? resolveLiveStorageBridgeUri() {
  final primary = Platform.environment['PYRIC_LIVE_BRIDGE_URL']?.trim() ?? '';
  if (primary.isNotEmpty) {
    return Uri.parse(primary);
  }
  final fallback = Platform.environment['PYRIC_BRIDGE_URL']?.trim() ?? '';
  if (fallback.isNotEmpty) {
    return Uri.parse(fallback);
  }
  return null;
}

/// Resolves the live project ID configured by the conformance runner.
String resolveLiveStorageProjectId() {
  final raw = Platform.environment['PYRIC_LIVE_PROJECT_ID']?.trim() ?? '';
  return raw.isNotEmpty ? raw : 'demo-flutter-live';
}

/// Whether the runner mounted the dedicated Storage HTTP byte route (`PYRIC_LIVE_STORAGE_HOST=1`).
bool isDedicatedStorageLiveHost() {
  return Platform.environment['PYRIC_LIVE_STORAGE_HOST']?.trim() == '1';
}

/// Asserts that [action] throws a `firebase_storage` [FirebaseException] with [expectedCode].
Future<FirebaseException> expectStorageExceptionCode(
  Future<Object?> Function() action,
  String expectedCode,
) async {
  try {
    await action();
    fail(
      'Expected FirebaseException(plugin: firebase_storage, code: $expectedCode)',
    );
  } on FirebaseException catch (error) {
    expect(error.plugin, equals('firebase_storage'));
    expect(
      error.code,
      equals(expectedCode),
      reason: 'Expected code $expectedCode, got ${error.code}: ${error.message}',
    );
    return error;
  }
}

/// Raw HTTP GET response captured when verifying minted Storage download URLs.
class LiveHttpFetchResult {
  final int statusCode;
  final String? contentType;
  final Uint8List body;

  const LiveHttpFetchResult({
    required this.statusCode,
    required this.contentType,
    required this.body,
  });
}

/// Performs a plain HTTP GET against [uri] and returns status, content-type, and body bytes.
Future<LiveHttpFetchResult> fetchLiveHttpUrl(Uri uri) async {
  final httpClient = HttpClient();
  try {
    final request = await httpClient.getUrl(uri);
    final response = await request.close();
    final builder = BytesBuilder(copy: false);
    await for (final chunk in response) {
      builder.add(chunk);
    }
    return LiveHttpFetchResult(
      statusCode: response.statusCode,
      contentType: response.headers.value(HttpHeaders.contentTypeHeader),
      body: builder.takeBytes(),
    );
  } finally {
    httpClient.close(force: false);
  }
}
