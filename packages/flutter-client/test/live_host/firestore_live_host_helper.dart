import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase, FirebaseApp;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

const FirebaseOptions liveFirestoreOptions = FirebaseOptions(
  apiKey: 'demo-flutter-live-api-key',
  appId: '1:1234567890:android:demoflutterlive',
  messagingSenderId: '1234567890',
  projectId: 'demo-flutter-live',
  databaseURL: 'https://demo-flutter-live-default-rtdb.firebaseio.com',
);

class LiveHostFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = {};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? liveFirestoreOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(name, liveFirestoreOptions),
    );
  }
}

void installLiveHostHttpOverrides() {
  HttpOverrides? previousHttpOverrides;

  setUp(() {
    previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
  });

  tearDown(() {
    HttpOverrides.global = previousHttpOverrides;
  });
}

Uri? resolveLiveBridgeUri() {
  final raw = Platform.environment['PYRIC_LIVE_BRIDGE_URL'];
  if (raw == null || raw.trim().isEmpty) {
    return null;
  }
  return Uri.parse(raw.trim());
}

class LiveFirestoreSession {
  final Uri bridgeUri;
  final FirebaseApp app;
  final PyricBridgeClient client;
  final PyricFirebaseAuthPlatform auth;
  final PyricFirestorePlatform firestore;
  final String uid;

  const LiveFirestoreSession({
    required this.bridgeUri,
    required this.app,
    required this.client,
    required this.auth,
    required this.firestore,
    required this.uid,
  });
}

int _sessionCounter = 0;

Future<T> withLiveFirestoreSession<T>(
  Uri bridgeUri,
  Future<T> Function(LiveFirestoreSession session) body,
) async {
  _sessionCounter += 1;
  final nonce = '${DateTime.now().microsecondsSinceEpoch}-$_sessionCounter';
  FirebasePlatform.instance = LiveHostFirebasePlatform();
  final app = await Firebase.initializeApp(
    name: 'flutter-fs-live-$nonce',
    options: liveFirestoreOptions,
  );
  final client = PyricBridgeClient(
    uri: bridgeUri,
    headers: <String, dynamic>{'Host': '${bridgeUri.host}:${bridgeUri.port}'},
  );
  final auth = PyricFirebaseAuthPlatform(appInstance: app, bridgeClient: client);
  PyricFirebaseAuthPlatform.registerWith(bridgeClient: client);
  PyricFirestorePlatform.registerWith(
    bridgeClient: client,
    credentialsProvider: auth,
  );

  PyricFirestorePlatform? firestore;
  try {
    await client.connect();
    final created = await auth.createUserWithEmailAndPassword(
      'fs-live-$nonce@example.test',
      'correct-horse-battery',
    );
    final uid = created.user!.uid;
    firestore = PyricFirestorePlatform(
      app: app,
      bridgeClient: client,
      credentialsProvider: auth,
    );
    return await body(
      LiveFirestoreSession(
        bridgeUri: bridgeUri,
        app: app,
        client: client,
        auth: auth,
        firestore: firestore,
        uid: uid,
      ),
    );
  } finally {
    await firestore?.terminate();
    await auth.dispose();
    await client.disconnect();
  }
}

Future<T> withDedicatedFirestoreClient<T>(
  LiveFirestoreSession session,
  Future<T> Function(PyricBridgeClient client, PyricFirestorePlatform firestore)
      body, {
  String? databaseId,
}) async {
  final auxClient = PyricBridgeClient(
    uri: session.bridgeUri,
    headers: <String, dynamic>{
      'Host': '${session.bridgeUri.host}:${session.bridgeUri.port}',
    },
  );
  await auxClient.connect();
  final auxFirestore = PyricFirestorePlatform(
    app: session.app,
    databaseId: databaseId,
    bridgeClient: auxClient,
    credentialsProvider: session.auth,
  );
  try {
    return await body(auxClient, auxFirestore);
  } finally {
    await auxFirestore.terminate();
    await auxClient.disconnect();
  }
}

Future<PyricBridgeException> expectBridgeError(
  Future<Object?> Function() action, {
  List<String>? allowedCodes,
}) async {
  try {
    await action();
    fail('Expected PyricBridgeException, but call completed normally');
  } on PyricBridgeException catch (err) {
    if (allowedCodes != null && allowedCodes.isNotEmpty) {
      expect(
        allowedCodes.contains(err.code),
        isTrue,
        reason: 'Expected code in $allowedCodes, got ${err.code}: ${err.message}',
      );
    }
    return err;
  }
}
