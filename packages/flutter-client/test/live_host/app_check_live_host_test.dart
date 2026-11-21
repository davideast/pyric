import 'dart:convert';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase, FirebaseApp;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_app_check.dart';

class _LiveAppCheckFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final resolvedOptions = options ??
        const FirebaseOptions(
          apiKey: 'demo-flutter-live-api-key',
          appId: '1:1234567890:android:demoflutterlive',
          messagingSenderId: '1234567890',
          projectId: 'demo-flutter-live',
        );
    final app = FirebaseAppPlatform(appName, resolvedOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    final existing = _apps[name];
    if (existing != null) {
      return existing;
    }
    final created = FirebaseAppPlatform(
      name,
      const FirebaseOptions(
        apiKey: 'demo-flutter-live-api-key',
        appId: '1:1234567890:android:demoflutterlive',
        messagingSenderId: '1234567890',
        projectId: 'demo-flutter-live',
      ),
    );
    _apps[name] = created;
    return created;
  }
}

Uri? _resolveLiveBridgeUri() {
  final raw = Platform.environment['PYRIC_LIVE_BRIDGE_URL']?.trim() ?? '';
  if (raw.isEmpty) {
    return null;
  }
  return Uri.parse(raw);
}

String _resolveLiveProjectId() {
  final raw = Platform.environment['PYRIC_LIVE_PROJECT_ID']?.trim() ?? '';
  if (raw.isNotEmpty) {
    return raw;
  }
  return 'demo-flutter-live';
}

Map<String, dynamic> _decodeJwtHeader(String jwt) {
  final parts = jwt.split('.');
  expect(parts.length, equals(3), reason: 'Expected 3-segment RS256 JWT: $jwt');
  final normalized = base64Url.normalize(parts[0]);
  final decoded = utf8.decode(base64Url.decode(normalized));
  return Map<String, dynamic>.from(jsonDecode(decoded) as Map);
}

Map<String, dynamic> _decodeJwtPayload(String jwt) {
  final parts = jwt.split('.');
  expect(parts.length, equals(3), reason: 'Expected 3-segment RS256 JWT: $jwt');
  final normalized = base64Url.normalize(parts[1]);
  final decoded = utf8.decode(base64Url.decode(normalized));
  return Map<String, dynamic>.from(jsonDecode(decoded) as Map);
}

void main() {
  HttpOverrides? previousHttpOverrides;

  setUp(() {
    previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
  });

  tearDown(() async {
    await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
    HttpOverrides.global = previousHttpOverrides;
  });

  group('Pyric Flutter App Check live-host conformance', () {
    test(
      'mints standard, forced-refresh, and limited-use RS256 App Check JWTs across isolated FirebaseApps over live WebSocket bridge',
      () async {
        final bridgeUri = _resolveLiveBridgeUri();
        if (bridgeUri == null) {
          // Offline unit runs (without a live Node bridge host) verify local activation wiring.
          final offline = PyricFirebaseAppCheckPlatform(isTokenAutoRefreshEnabled: false);
          await offline.activate(providerAndroid: const AndroidDebugProvider());
          expect(offline.providerKind, equals('debug'));
          await offline.dispose();
          return;
        }

        final projectId = _resolveLiveProjectId();
        const androidAppId = '1:424242424242:android:flutterappcheck';
        const appleAppId = '1:424242424242:ios:flutterappcheckios';

        FirebasePlatform.instance = _LiveAppCheckFirebasePlatform();
        final FirebaseApp primaryApp = await Firebase.initializeApp(
          name: 'flutter-appcheck-primary-${DateTime.now().microsecondsSinceEpoch}',
          options: FirebaseOptions(
            apiKey: 'demo-flutter-live-api-key',
            appId: androidAppId,
            messagingSenderId: '424242424242',
            projectId: projectId,
          ),
        );
        final FirebaseApp secondaryApp = await Firebase.initializeApp(
          name: 'flutter-appcheck-secondary-${DateTime.now().microsecondsSinceEpoch}',
          options: FirebaseOptions(
            apiKey: 'demo-flutter-live-api-key',
            appId: appleAppId,
            messagingSenderId: '424242424242',
            projectId: projectId,
          ),
        );

        final client = PyricBridgeClient(
          uri: bridgeUri,
          headers: <String, dynamic>{'Host': '${bridgeUri.host}:${bridgeUri.port}'},
        );

        PyricFirebaseAppCheckPlatform.registerWith(
          bridgeClient: client,
          isTokenAutoRefreshEnabled: false,
        );
        final primaryAppCheck = FirebaseAppCheckPlatform.instanceFor(app: primaryApp)
            as PyricFirebaseAppCheckPlatform;
        final secondaryAppCheck = FirebaseAppCheckPlatform.instanceFor(app: secondaryApp)
            as PyricFirebaseAppCheckPlatform;
        PyricFirebaseAppCheckPlatform? emulatorConnectedAppCheck;

        final emittedPrimaryTokens = <String?>[];
        final sub = primaryAppCheck.onTokenChange.listen(emittedPrimaryTokens.add);

        try {
          await client.connect();

          await primaryAppCheck.activate(
            providerAndroid: const AndroidPlayIntegrityProvider(),
          );
          await secondaryAppCheck.activate(
            providerApple: const AppleAppAttestProvider(),
          );

          final firstToken = await primaryAppCheck.getToken(false);
          expect(firstToken, isNotNull);
          final firstJwt = firstToken!;
          final firstHeader = _decodeJwtHeader(firstJwt);
          expect(firstHeader['alg'], equals('RS256'));
          expect(firstHeader['typ'], equals('JWT'));
          expect((firstHeader['kid'] as String?)?.isNotEmpty, isTrue);

          final firstClaims = _decodeJwtPayload(firstJwt);
          expect(firstClaims['sub'], equals(androidAppId));
          expect(firstClaims['aud'], contains('projects/$projectId'));
          expect(
            (firstClaims['iss'] as String).startsWith('https://firebaseappcheck.googleapis.com/'),
            isTrue,
          );
          expect(
            (firstClaims['exp'] as num).toInt() - (firstClaims['iat'] as num).toInt(),
            equals(3600),
          );

          // Cached getToken(false) and getTokenResult(false) return the identical token.
          final cachedToken = await primaryAppCheck.getToken(false);
          expect(cachedToken, equals(firstJwt));
          final cachedResult = await primaryAppCheck.getTokenResult(false);
          expect(cachedResult, isNotNull);
          expect(cachedResult!.token, equals(firstJwt));
          expect(cachedResult.expirationTime, isNotNull);
          expect(
            cachedResult.expirationTime!.isAfter(
              DateTime.now().add(const Duration(minutes: 50)),
            ),
            isTrue,
          );

          // Forced refresh mints a new distinct RS256 token and emits on onTokenChange.
          final refreshedToken = await primaryAppCheck.getToken(true);
          expect(refreshedToken, isNotNull);
          expect(refreshedToken, isNot(equals(firstJwt)));
          final refreshedClaims = _decodeJwtPayload(refreshedToken!);
          expect(refreshedClaims['sub'], equals(androidAppId));

          // Limited-use token has a 5-minute TTL + jti claim and leaves standard cache intact.
          final limitedToken = await primaryAppCheck.getLimitedUseToken();
          expect(limitedToken, isNot(equals(refreshedToken)));
          final limitedClaims = _decodeJwtPayload(limitedToken);
          expect(limitedClaims['sub'], equals(androidAppId));
          expect((limitedClaims['jti'] as String?)?.isNotEmpty, isTrue);
          expect(
            (limitedClaims['exp'] as num).toInt() - (limitedClaims['iat'] as num).toInt(),
            equals(300),
          );
          expect(await primaryAppCheck.getToken(false), equals(refreshedToken));

          // Verify opWithAppCheck attaches the active App Check JWT to ai.generateContent on the worker host.
          final aiResponse = await primaryAppCheck.opWithAppCheck(
            'ai.generateContent',
            <String, dynamic>{
              'model': 'gemini-2.5-flash',
              'request': <String, dynamic>{
                'contents': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'role': 'user',
                    'parts': <Map<String, dynamic>>[
                      <String, dynamic>{'text': 'hello'},
                    ],
                  },
                ],
              },
            },
          );
          expect(aiResponse, isA<Map>());

          // Secondary FirebaseApp mints tokens scoped to its own iOS appId.
          final secondaryToken = await secondaryAppCheck.getToken(false);
          expect(secondaryToken, isNotNull);
          final secondaryClaims = _decodeJwtPayload(secondaryToken!);
          expect(secondaryClaims['sub'], equals(appleAppId));

          // Toggle auto-refresh cleanly on live instance.
          await primaryAppCheck.setTokenAutoRefreshEnabled(true);
          expect(primaryAppCheck.isTokenAutoRefreshEnabled, isTrue);
          await primaryAppCheck.setTokenAutoRefreshEnabled(false);
          expect(primaryAppCheck.isTokenAutoRefreshEnabled, isFalse);

          // Verify standalone useAppCheckEmulator(host, port) connection helper.
          emulatorConnectedAppCheck = PyricFirebaseAppCheckPlatform(
            appInstance: primaryApp,
            isTokenAutoRefreshEnabled: false,
          );
          await emulatorConnectedAppCheck.useAppCheckEmulator(
            bridgeUri.host,
            bridgeUri.port,
          );
          await emulatorConnectedAppCheck.activate(
            providerAndroid: const AndroidDebugProvider(debugToken: 'live-debug-token'),
          );
          final emulatorToken = await emulatorConnectedAppCheck.getToken(false);
          expect(emulatorToken, isNotNull);
          expect(_decodeJwtPayload(emulatorToken!)['sub'], equals(androidAppId));

          await Future<void>.delayed(const Duration(milliseconds: 20));
          expect(emittedPrimaryTokens, equals(<String?>[firstJwt, refreshedToken]));
        } finally {
          await sub.cancel();
          await emulatorConnectedAppCheck?.dispose();
          await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
          await client.disconnect();
        }
      },
    );
  });
}
