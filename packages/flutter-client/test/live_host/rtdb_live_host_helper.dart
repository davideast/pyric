import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase, FirebaseApp;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_database.dart';

const FirebaseOptions liveRtdbOptions = FirebaseOptions(
  apiKey: 'demo-flutter-live-api-key',
  appId: '1:1234567890:android:demoflutterlive',
  messagingSenderId: '1234567890',
  projectId: 'demo-flutter-live',
  databaseURL: 'https://demo-flutter-live-default-rtdb.firebaseio.com',
);

int _sessionCounter = 0;

class LiveRtdbFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = {};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? liveRtdbOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(name, liveRtdbOptions),
    );
  }
}

Uri? liveBridgeUriFromEnv() {
  final raw = Platform.environment['PYRIC_LIVE_BRIDGE_URL'];
  if (raw == null || raw.trim().isEmpty) return null;
  return Uri.parse(raw.trim());
}

String nextUniqueLiveId(String prefix) {
  _sessionCounter += 1;
  return '$prefix-${DateTime.now().microsecondsSinceEpoch}-$_sessionCounter';
}

Future<void> expectRtdbPermissionDenied(
  Future<Object?> Function() action,
) async {
  try {
    await action();
    fail('Expected PyricBridgeException permission denial, but call succeeded');
  } on PyricBridgeException catch (err) {
    final code = err.code.toLowerCase();
    final msg = err.message.toLowerCase();
    expect(
      code == 'permission-denied' ||
          code == 'permission_denied' ||
          code.contains('permission') ||
          msg.contains('permission_denied') ||
          msg.contains('permission denied'),
      isTrue,
      reason: 'Unexpected bridge error: ${err.code} (${err.message})',
    );
  }
}

class LiveRtdbSession {
  final Uri bridgeUri;
  final FirebaseApp app;
  final PyricBridgeClient client;
  final PyricFirebaseAuthPlatform auth;
  final PyricDatabase db;
  final String uid;
  final String email;

  const LiveRtdbSession({
    required this.bridgeUri,
    required this.app,
    required this.client,
    required this.auth,
    required this.db,
    required this.uid,
    required this.email,
  });

  String get userRoot => 'users/$uid';

  DatabaseReference userRef([String? subPath]) {
    if (subPath == null || subPath.isEmpty) {
      return db.ref(userRoot);
    }
    return db.ref('$userRoot/$subPath');
  }

  Future<({PyricBridgeClient client, PyricDatabase db})>
      openSecondaryDatabaseConnection({String? databaseURL}) async {
    final secondaryClient = PyricBridgeClient(
      uri: bridgeUri,
      headers: <String, dynamic>{
        'Host': '${bridgeUri.host}:${bridgeUri.port}',
      },
    );
    await secondaryClient.connect();
    final secondaryDb = PyricDatabase(
      app: app,
      databaseURL: databaseURL,
      bridgeClient: secondaryClient,
      credentialsProvider: auth,
    );
    return (client: secondaryClient, db: secondaryDb);
  }
}

Future<void> runLiveRtdbTest(
  Future<void> Function(LiveRtdbSession session) body,
) async {
  final bridgeUri = liveBridgeUriFromEnv();
  if (bridgeUri == null) return;

  FirebasePlatform.instance = LiveRtdbFirebasePlatform();
  final runTag = nextUniqueLiveId('rtdb');
  final app = await Firebase.initializeApp(
    name: 'flutter-$runTag',
    options: liveRtdbOptions,
  );
  final client = PyricBridgeClient(
    uri: bridgeUri,
    headers: <String, dynamic>{'Host': '${bridgeUri.host}:${bridgeUri.port}'},
  );
  final auth = PyricFirebaseAuthPlatform(
    appInstance: app,
    bridgeClient: client,
  );
  PyricFirebaseAuthPlatform.registerWith(bridgeClient: client);
  PyricDatabase.registerWith(
    bridgeClient: client,
    credentialsProvider: auth,
  );

  try {
    await client.connect();
    final email = '$runTag@example.test';
    final created = await auth.createUserWithEmailAndPassword(
      email,
      'correct-horse-battery',
    );
    final uid = created.user!.uid;
    final db = PyricDatabase.instance;
    await body(
      LiveRtdbSession(
        bridgeUri: bridgeUri,
        app: app,
        client: client,
        auth: auth,
        db: db,
        uid: uid,
        email: email,
      ),
    );
  } finally {
    await auth.dispose();
    await client.disconnect();
  }
}
