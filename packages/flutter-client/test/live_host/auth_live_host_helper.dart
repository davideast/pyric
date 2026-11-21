import 'dart:async' show Completer, StreamSubscription;
import 'dart:convert';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase, FirebaseApp;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

const FirebaseOptions liveAuthOptions = FirebaseOptions(
  apiKey: 'demo-flutter-live-api-key',
  appId: '1:1234567890:android:demoflutterlive',
  messagingSenderId: '1234567890',
  projectId: 'demo-flutter-live',
  databaseURL: 'https://demo-flutter-live-default-rtdb.firebaseio.com',
);

class LiveAuthFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? liveAuthOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(name, liveAuthOptions),
    );
  }
}

class LiveAuthSession {
  final FirebaseApp app;
  final PyricBridgeClient client;
  final PyricFirebaseAuthPlatform auth;
  final PyricFirestorePlatform firestore;

  const LiveAuthSession({
    required this.app,
    required this.client,
    required this.auth,
    required this.firestore,
  });
}

Uri? resolveLiveBridgeUri() {
  final raw = Platform.environment['PYRIC_LIVE_BRIDGE_URL']?.trim() ?? '';
  if (raw.isEmpty) {
    return null;
  }
  return Uri.parse(raw);
}

Future<T> withLiveAuthSession<T>(
  Uri bridgeUri,
  Future<T> Function(LiveAuthSession session) body,
) async {
  FirebasePlatform.instance = LiveAuthFirebasePlatform();
  final app = await Firebase.initializeApp(
    name: 'flutter-auth-live-${DateTime.now().microsecondsSinceEpoch}',
    options: liveAuthOptions,
  );
  final client = PyricBridgeClient(
    uri: bridgeUri,
    headers: <String, dynamic>{'Host': '${bridgeUri.host}:${bridgeUri.port}'},
  );
  final auth = PyricFirebaseAuthPlatform(appInstance: app, bridgeClient: client);
  PyricFirebaseAuthPlatform.registerWith(bridgeClient: client);
  FieldValueFactoryPlatform.instance = PyricFieldValueFactory();
  final firestore = PyricFirestorePlatform(
    app: app,
    bridgeClient: client,
    credentialsProvider: auth,
  );

  try {
    await client.connect();
    return await body(
      LiveAuthSession(
        app: app,
        client: client,
        auth: auth,
        firestore: firestore,
      ),
    );
  } finally {
    await firestore.terminate();
    await auth.dispose();
    await client.disconnect();
  }
}

Future<FirebaseAuthException> expectAuthExceptionCode(
  Future<Object?> Function() action,
  List<String> allowedCodes,
) async {
  try {
    await action();
    fail('Expected FirebaseAuthException with code in $allowedCodes');
  } on FirebaseAuthException catch (err) {
    expect(
      allowedCodes.contains(err.code),
      isTrue,
      reason:
          'Expected FirebaseAuthException code in $allowedCodes, got ${err.code} (${err.message})',
    );
    return err;
  }
}

Future<void> expectPermissionDenied(Future<Object?> Function() action) async {
  try {
    await action();
    fail('Expected PyricBridgeException permission denial');
  } on PyricBridgeException catch (err) {
    final lower = err.code.toLowerCase();
    expect(
      lower == 'permission-denied' ||
          lower == 'permission_denied' ||
          lower.contains('permission'),
      isTrue,
      reason: 'Unexpected bridge error: ${err.code} (${err.message})',
    );
  }
}

String mintUnsignedOidcJwt(Map<String, Object?> payload) {
  String encodePart(Map<String, Object?> jsonMap) {
    final encoded = base64Url.encode(utf8.encode(jsonEncode(jsonMap)));
    return encoded.replaceAll('=', '');
  }

  final header = encodePart(const <String, Object?>{'alg': 'none', 'typ': 'JWT'});
  final body = encodePart(payload);
  return '$header.$body.';
}

Map<String, dynamic> decodeJwtPayload(String jwt) {
  final parts = jwt.split('.');
  expect(parts.length, equals(3), reason: 'Expected 3-segment JWT, got: $jwt');
  final normalized = base64Url.normalize(parts[1]);
  final decoded = utf8.decode(base64Url.decode(normalized));
  return Map<String, dynamic>.from(jsonDecode(decoded) as Map);
}

Future<T> waitForStreamMatch<T>(
  Stream<T> stream,
  bool Function(T value) predicate, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final completer = Completer<T>();
  late final StreamSubscription<T> sub;
  sub = stream.listen(
    (event) {
      if (!completer.isCompleted && predicate(event)) {
        completer.complete(event);
      }
    },
    onError: (Object err, StackTrace st) {
      if (!completer.isCompleted) {
        completer.completeError(err, st);
      }
    },
  );
  try {
    return await completer.future.timeout(timeout);
  } finally {
    await sub.cancel();
  }
}
