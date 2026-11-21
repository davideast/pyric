import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_app_check.dart';

import '../helpers/fake_bridge.dart';

const FirebaseOptions _testOptions = FirebaseOptions(
  apiKey: 'demo-appcheck-api-key',
  appId: '1:999999999:android:demoappcheck',
  messagingSenderId: '999999999',
  projectId: 'demo-flutter-appcheck',
);

class _MockFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? _testOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(name, _testOptions),
    );
  }
}

void main() {
  late FakeBridge fakeBridge;
  late PyricBridgeClient bridgeClient;
  late FirebaseApp defaultApp;
  int nowMillis = 1700000000000;

  setUp(() async {
    nowMillis = 1700000000000;
    FirebasePlatform.instance = _MockFirebasePlatform();
    defaultApp = await Firebase.initializeApp(options: _testOptions);

    fakeBridge = FakeBridge();
    bridgeClient = PyricBridgeClient(
      uri: Uri.parse('ws://127.0.0.1:4400/__pyric/sandbox'),
      channelFactory: fakeBridge.connect,
    );
  });

  tearDown(() async {
    await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
    await bridgeClient.disconnect();
  });

  group('app_check_wire_codec', () {
    test('resolves canonical wire provider slugs across Android, Apple, Web, Windows, and legacy enums', () {
      expect(
        resolveAppCheckActivation(
          providerAndroid: const AndroidDebugProvider(debugToken: 'dbg-android-1'),
        ),
        isA<ResolvedAppCheckActivation>()
            .having((r) => r.provider, 'provider', 'debug')
            .having((r) => r.debugToken, 'debugToken', 'dbg-android-1'),
      );
      expect(
        resolveAppCheckActivation(
          providerAndroid: const AndroidPlayIntegrityProvider(),
        ).provider,
        equals('play-integrity'),
      );
      expect(
        resolveAppCheckActivation(
          providerAndroid: const AndroidReCaptchaProvider('site-key-android'),
        ),
        isA<ResolvedAppCheckActivation>()
            .having((r) => r.provider, 'provider', 'recaptcha')
            .having((r) => r.siteKey, 'siteKey', 'site-key-android'),
      );
      expect(
        resolveAppCheckActivation(
          providerApple: const AppleAppAttestProvider(),
        ).provider,
        equals('app-attest'),
      );
      expect(
        resolveAppCheckActivation(
          providerApple: const AppleDeviceCheckProvider(),
        ).provider,
        equals('device-check'),
      );
      expect(
        resolveAppCheckActivation(
          providerApple: const AppleAppAttestWithDeviceCheckFallbackProvider(),
        ).provider,
        equals('app-attest-with-device-check-fallback'),
      );
      expect(
        resolveAppCheckActivation(
          webProvider: ReCaptchaV3Provider('site-v3'),
        ),
        isA<ResolvedAppCheckActivation>()
            .having((r) => r.provider, 'provider', 'recaptcha-v3')
            .having((r) => r.siteKey, 'siteKey', 'site-v3'),
      );
      expect(
        resolveAppCheckActivation(
          webProvider: ReCaptchaEnterpriseProvider('site-ent'),
        ),
        isA<ResolvedAppCheckActivation>()
            .having((r) => r.provider, 'provider', 'recaptcha-enterprise')
            .having((r) => r.siteKey, 'siteKey', 'site-ent'),
      );
      expect(
        resolveAppCheckActivation(
          webProvider: WebDebugProvider(debugToken: 'dbg-web'),
        ),
        isA<ResolvedAppCheckActivation>()
            .having((r) => r.provider, 'provider', 'debug')
            .having((r) => r.debugToken, 'debugToken', 'dbg-web'),
      );
      expect(
        resolveAppCheckActivation(
          providerWindows: const WindowsDebugProvider(debugToken: 'dbg-win'),
        ),
        isA<ResolvedAppCheckActivation>()
            .having((r) => r.provider, 'provider', 'debug')
            .having((r) => r.debugToken, 'debugToken', 'dbg-win'),
      );
      // ignore: deprecated_member_use
      expect(
        // ignore: deprecated_member_use
        resolveAppCheckActivation(androidProvider: AndroidProvider.playIntegrity).provider,
        equals('play-integrity'),
      );
      // ignore: deprecated_member_use
      expect(
        // ignore: deprecated_member_use
        resolveAppCheckActivation(appleProvider: AppleProvider.appAttest).provider,
        equals('app-attest'),
      );
      expect(resolveAppCheckActivation().provider, equals('debug'));
    });

    test('normalizes appCheck error prefixes and rejects malformed responses', () {
      expect(normalizeAppCheckErrorCode('appCheck/throttled'), equals('throttled'));
      expect(normalizeAppCheckErrorCode('app-check/fetch-status-error'), equals('fetch-status-error'));
      expect(normalizeAppCheckErrorCode('internal'), equals('internal'));

      expect(
        () => decodeWireAppCheckToken('not-a-map', nowMillis: nowMillis),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_app_check')
              .having((e) => e.code, 'code', 'invalid-response'),
        ),
      );
      expect(
        () => decodeWireAppCheckToken(<String, Object?>{'token': ''}, nowMillis: nowMillis),
        throwsA(isA<FirebaseException>()),
      );
    });
  });

  group('PyricFirebaseAppCheckPlatform over FakeBridge', () {
    test('caches standard tokens, refreshes inside expiry buffer or on forceRefresh, and emits onTokenChange', () async {
      var mintCount = 0;
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        final op = frame['op'] as Map<String, dynamic>;
        if (op['method'] == 'appCheck.getToken') {
          mintCount += 1;
          final tokenNum = mintCount;
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'token': 'jwt-standard-$tokenNum',
                'expireTimeMillis': nowMillis + 3600000,
              },
            });
          });
        }
      };

      PyricFirebaseAppCheckPlatform.registerWith(
        bridgeClient: bridgeClient,
        isTokenAutoRefreshEnabled: false,
        clockMillis: () => nowMillis,
      );
      final appCheck = FirebaseAppCheckPlatform.instanceFor(app: defaultApp)
          as PyricFirebaseAppCheckPlatform;
      expect(
        identical(appCheck, FirebaseAppCheckPlatform.instanceFor(app: defaultApp)),
        isTrue,
      );

      final emittedTokens = <String?>[];
      final sub = appCheck.onTokenChange.listen(emittedTokens.add);
      try {
        await appCheck.activate(
          providerAndroid: const AndroidPlayIntegrityProvider(),
        );
        expect(appCheck.isActivated, isTrue);
        expect(appCheck.providerKind, equals('play-integrity'));

        final first = await appCheck.getToken(false);
        expect(first, equals('jwt-standard-1'));
        expect(mintCount, equals(1));

        final sentOp = fakeBridge.opNamed('appCheck.getToken')['op'] as Map<String, dynamic>;
        expect(sentOp['provider'], equals('play-integrity'));
        expect(sentOp['appId'], equals(_testOptions.appId));
        expect(sentOp['projectId'], equals(_testOptions.projectId));
        expect(sentOp['forceRefresh'], isFalse);

        // Cached read while fresh makes zero bridge calls and emits no duplicate token event.
        final cached = await appCheck.getTokenResult(false);
        expect(cached, isNotNull);
        expect(cached!.token, equals('jwt-standard-1'));
        expect(
          cached.expirationTime,
          equals(DateTime.fromMillisecondsSinceEpoch(nowMillis + 3600000)),
        );
        expect(mintCount, equals(1));

        // Advancing into the 5-minute refresh buffer triggers a fresh mint on getToken(false).
        nowMillis += 3350000;
        final refreshedFromBuffer = await appCheck.getToken(false);
        expect(refreshedFromBuffer, equals('jwt-standard-2'));
        expect(mintCount, equals(2));

        // Explicit forceRefresh: true always mints a fresh token.
        final forced = await appCheck.getToken(true);
        expect(forced, equals('jwt-standard-3'));
        expect(mintCount, equals(3));

        await settle();
        expect(
          emittedTokens,
          equals(<String?>['jwt-standard-1', 'jwt-standard-2', 'jwt-standard-3']),
        );
      } finally {
        await sub.cancel();
      }
    });

    test('coalesces concurrent getToken(false) requests and isolates getLimitedUseToken from standard cache', () async {
      var standardMintCount = 0;
      var limitedMintCount = 0;
      final pendingStandardReplies = <void Function()>[];

      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        final op = frame['op'] as Map<String, dynamic>;
        if (op['method'] == 'appCheck.getToken') {
          standardMintCount += 1;
          final n = standardMintCount;
          pendingStandardReplies.add(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'token': 'coalesced-jwt-$n',
                'expireTimeMillis': nowMillis + 3600000,
              },
            });
          });
        } else if (op['method'] == 'appCheck.getLimitedUseToken') {
          limitedMintCount += 1;
          final n = limitedMintCount;
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'token': 'limited-use-jwt-$n',
                'expireTimeMillis': nowMillis + 300000,
              },
            });
          });
        }
      };

      await bridgeClient.connect();
      final appCheck = PyricFirebaseAppCheckPlatform(
        appInstance: defaultApp,
        bridgeClient: bridgeClient,
        isTokenAutoRefreshEnabled: false,
        clockMillis: () => nowMillis,
      );
      final emitted = <String?>[];
      final sub = appCheck.onTokenChange.listen(emitted.add);

      try {
        final f1 = appCheck.getToken(false);
        final f2 = appCheck.getToken(false);
        await until(() => pendingStandardReplies.length == 1);
        expect(standardMintCount, equals(1));
        pendingStandardReplies.removeAt(0)();

        final results = await Future.wait(<Future<String?>>[f1, f2]);
        expect(results, equals(<String?>['coalesced-jwt-1', 'coalesced-jwt-1']));

        final limited1 = await appCheck.getLimitedUseToken();
        final limited2 = await appCheck.getLimitedUseToken();
        expect(limited1, equals('limited-use-jwt-1'));
        expect(limited2, equals('limited-use-jwt-2'));
        expect(limitedMintCount, equals(2));

        // Standard cached token and onTokenChange stream remain untouched by getLimitedUseToken.
        expect(await appCheck.getToken(false), equals('coalesced-jwt-1'));
        expect(standardMintCount, equals(1));
        await settle();
        expect(emitted, equals(<String?>['coalesced-jwt-1']));
      } finally {
        await sub.cancel();
        await appCheck.dispose();
      }
    });

    test('opWithAppCheck attaches standard or limited-use appCheckToken to bridge operations', () async {
      final capturedAiOps = <Map<String, dynamic>>[];
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        final op = frame['op'] as Map<String, dynamic>;
        final method = op['method'];
        if (method == 'appCheck.getToken') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'token': 'attached-standard-jwt',
                'expireTimeMillis': nowMillis + 3600000,
              },
            });
          });
        } else if (method == 'appCheck.getLimitedUseToken') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'token': 'attached-limited-jwt',
                'expireTimeMillis': nowMillis + 300000,
              },
            });
          });
        } else if (method == 'ai.generateContent') {
          capturedAiOps.add(op);
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{'text': 'ok'},
            });
          });
        }
      };

      final appCheck = PyricFirebaseAppCheckPlatform(
        appInstance: defaultApp,
        bridgeClient: bridgeClient,
        isTokenAutoRefreshEnabled: false,
        clockMillis: () => nowMillis,
      );
      try {
        await appCheck.opWithAppCheck(
          'ai.generateContent',
          <String, dynamic>{'model': 'gemini-2.5-flash'},
        );
        await appCheck.opWithAppCheck(
          'ai.generateContent',
          <String, dynamic>{'model': 'gemini-2.5-flash'},
          limitedUse: true,
        );
        expect(capturedAiOps.length, equals(2));
        expect(capturedAiOps[0]['appCheckToken'], equals('attached-standard-jwt'));
        expect(capturedAiOps[1]['appCheckToken'], equals('attached-limited-jwt'));
      } finally {
        await appCheck.dispose();
      }
    });

    test('schedules proactive refresh when auto-refresh is enabled and wraps bridge errors as FirebaseException', () async {
      var mintCount = 0;
      var failNext = false;
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') return;
        final op = frame['op'] as Map<String, dynamic>;
        if (op['method'] == 'appCheck.getToken') {
          if (failNext) {
            scheduleMicrotask(() {
              fakeBridge.current.deliver(<String, dynamic>{
                'type': 'worker-res',
                'id': frame['id'],
                'ok': false,
                'error': <String, dynamic>{
                  'code': 'appCheck/throttled',
                  'message': 'Too many attestation attempts.',
                },
              });
            });
            return;
          }
          mintCount += 1;
          final n = mintCount;
          // Expire just outside the 5-minute buffer (+300020ms) so auto-refresh fires in 20ms!
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': frame['id'],
              'ok': true,
              'value': <String, dynamic>{
                'token': 'auto-jwt-$n',
                'expireTimeMillis': nowMillis + (n == 1 ? 300020 : 3600000),
              },
            });
          });
        }
      };

      final appCheck = PyricFirebaseAppCheckPlatform(
        appInstance: defaultApp,
        bridgeClient: bridgeClient,
        isTokenAutoRefreshEnabled: true,
        clockMillis: () => nowMillis,
      );
      final emitted = <String?>[];
      final sub = appCheck.onTokenChange.listen(emitted.add);
      try {
        final initial = await appCheck.getToken(false);
        expect(initial, equals('auto-jwt-1'));

        await until(() => emitted.length >= 2);
        expect(emitted, equals(<String?>['auto-jwt-1', 'auto-jwt-2']));

        await appCheck.setTokenAutoRefreshEnabled(false);
        expect(appCheck.isTokenAutoRefreshEnabled, isFalse);

        failNext = true;
        await expectLater(
          appCheck.getToken(true),
          throwsA(
            isA<FirebaseException>()
                .having((e) => e.plugin, 'plugin', 'firebase_app_check')
                .having((e) => e.code, 'code', 'throttled'),
          ),
        );
      } finally {
        await sub.cancel();
        await appCheck.dispose();
      }
    });
  });
}
