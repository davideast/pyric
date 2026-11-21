import 'dart:async';

import 'package:firebase_core/firebase_core.dart' show Firebase;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_ai.dart';
import 'package:pyric_firestore/pyric_app_check.dart';

import '../helpers/fake_bridge.dart';

class _TestFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final resolved = options ??
        const FirebaseOptions(
          apiKey: 'test-key',
          appId: '1:777:android:aiunary',
          messagingSenderId: '777',
          projectId: 'demo-ai-unary',
        );
    final created = FirebaseAppPlatform(appName, resolved);
    _apps[appName] = created;
    return created;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps[name]!;
  }
}

class _StaticTokenAppCheckPlatform extends FirebaseAppCheckPlatform {
  final String? tokenValue;

  _StaticTokenAppCheckPlatform(this.tokenValue);

  @override
  Future<String?> getToken(bool forceRefresh) async => tokenValue;

  @override
  Future<String> getLimitedUseToken() async => tokenValue ?? '';
}

void main() {
  late FakeBridge fakeBridge;
  late PyricBridgeClient bridgeClient;

  setUp(() async {
    FirebasePlatform.instance = _TestFirebasePlatform();
    await FirebaseAI.clearInstancesForTest();
    await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
    fakeBridge = FakeBridge();
    bridgeClient = PyricBridgeClient(channelFactory: fakeBridge.connect);
  });

  tearDown(() async {
    await FirebaseAI.clearInstancesForTest();
    await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
    await bridgeClient.disconnect();
  });

  group('GenerativeModel unary generateContent, countTokens, and App Check wiring', () {
    test('dispatches ai.generateContent and ai.countTokens without appCheck when ungated', () async {
      var limitedSeq = 0;
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') {
          return;
        }
        final op = frame['op'] as Map<String, dynamic>;
        final id = frame['id'] as String;
        if (op['method'] == 'ai.generateContent') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': <String, dynamic>{
                'modelVersion': 'gemini-2.5-flash',
                'responseId': 'r-ungated-1',
                'candidates': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'index': 0,
                    'finishReason': 'STOP',
                    'content': <String, dynamic>{
                      'role': 'model',
                      'parts': <Map<String, dynamic>>[
                        <String, dynamic>{'text': 'Hello from Pyric AIBroker!'},
                      ],
                    },
                  },
                ],
                'usageMetadata': <String, dynamic>{
                  'promptTokenCount': 5,
                  'candidatesTokenCount': 6,
                  'totalTokenCount': 11,
                },
              },
            });
          });
        } else if (op['method'] == 'ai.countTokens') {
          limitedSeq += 1;
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': <String, dynamic>{
                'totalTokens': 8 + limitedSeq,
                'promptTokensDetails': <Map<String, dynamic>>[
                  <String, dynamic>{'modality': 'TEXT', 'tokenCount': 8 + limitedSeq},
                ],
              },
            });
          });
        }
      };

      final ai = FirebaseAI.googleAI(bridgeClient: bridgeClient);
      final model = ai.generativeModel(
        model: 'gemini-2.5-flash',
        systemInstruction: Content.system('Reply concisely.'),
        generationConfig: GenerationConfig(temperature: 0.4, maxOutputTokens: 128),
        safetySettings: const <SafetySetting>[
          SafetySetting(HarmCategory.harassment, HarmBlockThreshold.medium),
        ],
      );

      final generated = await model.generateContent(
        <Content>[Content.text('Say hello')],
      );
      expect(generated.text, equals('Hello from Pyric AIBroker!'));
      expect(generated.usageMetadata?.totalTokenCount, equals(11));

      final genOp = fakeBridge.opNamed('ai.generateContent')['op'] as Map<String, dynamic>;
      expect(genOp['model'], equals('models/gemini-2.5-flash'));
      expect(genOp.containsKey('appCheck'), isFalse);
      final genReq = genOp['request'] as Map<String, dynamic>;
      expect(
        (genReq['generationConfig'] as Map<String, dynamic>)['temperature'],
        equals(0.4),
      );

      // Per-call GenerationConfig overrides model-level default.
      await model.generateContent(
        <Content>[Content.text('Override temperature')],
        generationConfig: GenerationConfig(temperature: 0.9),
      );
      final overrideOp =
          fakeBridge.opNamed('ai.generateContent')['op'] as Map<String, dynamic>;
      expect(
        ((overrideOp['request'] as Map<String, dynamic>)['generationConfig']
            as Map<String, dynamic>)['temperature'],
        equals(0.9),
      );

      final counted = await model.countTokens(
        <Content>[Content.text('Count these tokens')],
      );
      expect(counted.totalTokens, equals(9));
      final countOp = fakeBridge.opNamed('ai.countTokens')['op'] as Map<String, dynamic>;
      expect(countOp['model'], equals('models/gemini-2.5-flash'));
      expect(countOp.containsKey('appCheck'), isFalse);
    });

    test('attaches cached standard and per-op limited-use tokens from registered PyricFirebaseAppCheckPlatform', () async {
      final app = await Firebase.initializeApp();
      var standardMints = 0;
      var limitedMints = 0;

      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') {
          return;
        }
        final op = frame['op'] as Map<String, dynamic>;
        final id = frame['id'] as String;
        final method = op['method'] as String;
        if (method == 'appCheck.getToken') {
          standardMints += 1;
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': <String, dynamic>{
                'token': 'std-jwt-$standardMints',
                'expireTimeMillis':
                    DateTime.now().millisecondsSinceEpoch + 3600 * 1000,
              },
            });
          });
        } else if (method == 'appCheck.getLimitedUseToken') {
          limitedMints += 1;
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': <String, dynamic>{
                'token': 'lim-jwt-$limitedMints',
                'expireTimeMillis':
                    DateTime.now().millisecondsSinceEpoch + 300 * 1000,
              },
            });
          });
        } else if (method == 'ai.generateContent') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': <String, dynamic>{
                'candidates': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'index': 0,
                    'finishReason': 'STOP',
                    'content': <String, dynamic>{
                      'role': 'model',
                      'parts': <Map<String, dynamic>>[
                        <String, dynamic>{'text': 'Gated answer'},
                      ],
                    },
                  },
                ],
              },
            });
          });
        } else if (method == 'ai.countTokens') {
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': <String, dynamic>{'totalTokens': 4},
            });
          });
        }
      };

      PyricFirebaseAppCheckPlatform.registerWith(
        bridgeClient: bridgeClient,
        isTokenAutoRefreshEnabled: false,
      );
      final appCheck = FirebaseAppCheckPlatform.instanceFor(app: app)
          as PyricFirebaseAppCheckPlatform;
      await appCheck.activate(providerAndroid: const AndroidDebugProvider());

      // Automatic discovery via registered PyricFirebaseAppCheckPlatform!
      final standardAi = FirebaseAI.googleAI(app: app);
      final standardModel = standardAi.generativeModel(model: 'gemini-2.5-flash');

      final res = await standardModel.generateContent(<Content>[Content.text('Hi')]);
      expect(res.text, equals('Gated answer'));
      final countRes = await standardModel.countTokens(<Content>[Content.text('Hi')]);
      expect(countRes.totalTokens, equals(4));
      expect(standardMints, equals(1));

      final genOp = fakeBridge.opNamed('ai.generateContent')['op'] as Map<String, dynamic>;
      expect(genOp['appCheck'], equals(<String, dynamic>{'token': 'std-jwt-1'}));
      final countOp = fakeBridge.opNamed('ai.countTokens')['op'] as Map<String, dynamic>;
      expect(countOp['appCheck'], equals(<String, dynamic>{'token': 'std-jwt-1'}));

      // Limited-use mode mints a fresh token on each AI call.
      final limitedAi = FirebaseAI.vertexAI(
        app: app,
        appCheck: appCheck,
        useLimitedUseAppCheckTokens: true,
      );
      final limitedModel = limitedAi.generativeModel(model: 'gemini-2.5-flash');
      await limitedModel.generateContent(<Content>[Content.text('Turn 1')]);
      await limitedModel.countTokens(<Content>[Content.text('Turn 1')]);
      expect(limitedMints, equals(2));
      final lastCountOp =
          fakeBridge.opNamed('ai.countTokens')['op'] as Map<String, dynamic>;
      expect(lastCountOp['appCheck'], equals(<String, dynamic>{'token': 'lim-jwt-2'}));
    });

    test('sends null or invalid App Check claim when unactivated or forged and surfaces 401 refusal', () async {
      final app = await Firebase.initializeApp();
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') {
          return;
        }
        final op = frame['op'] as Map<String, dynamic>;
        final id = frame['id'] as String;
        if (op['method'] == 'ai.generateContent' ||
            op['method'] == 'ai.countTokens') {
          final claim = op['appCheck'] as Map<String, dynamic>?;
          final token = claim?['token'];
          if (token != 'valid-token') {
            scheduleMicrotask(() {
              fakeBridge.current.deliver(<String, dynamic>{
                'type': 'worker-res',
                'id': id,
                'ok': false,
                'error': <String, dynamic>{
                  'code': 'ai/UNAUTHENTICATED',
                  'message': 'Firebase App Check token is invalid.',
                },
              });
            });
          }
        }
      };

      final unactivatedAppCheck = PyricFirebaseAppCheckPlatform(
        appInstance: app,
        bridgeClient: bridgeClient,
        isTokenAutoRefreshEnabled: false,
      );
      final missingTokenModel = FirebaseAI.googleAI(
        app: app,
        appCheck: unactivatedAppCheck,
        bridgeClient: bridgeClient,
      ).generativeModel(model: 'gemini-2.5-flash');

      await expectLater(
        missingTokenModel.generateContent(<Content>[Content.text('Blocked')]),
        throwsA(
          isA<FirebaseAIException>()
              .having((err) => err.code, 'code', equals('unauthenticated'))
              .having((err) => err.httpStatusCode, 'httpStatusCode', equals(401))
              .having(
                (err) => err.message,
                'message',
                contains('Firebase App Check token is invalid.'),
              ),
        ),
      );
      final missingOp =
          fakeBridge.opNamed('ai.generateContent')['op'] as Map<String, dynamic>;
      expect(missingOp['appCheck'], equals(<String, dynamic>{'token': null}));

      final forgedAppCheck = _StaticTokenAppCheckPlatform('forged.jwt.token');
      final forgedModel = FirebaseAI.googleAI(
        app: app,
        appCheck: forgedAppCheck,
        bridgeClient: bridgeClient,
      ).generativeModel(model: 'gemini-2.5-flash');

      await expectLater(
        forgedModel.countTokens(<Content>[Content.text('Blocked count')]),
        throwsA(
          isA<FirebaseAIException>()
              .having((err) => err.code, 'code', equals('unauthenticated'))
              .having((err) => err.httpStatusCode, 'httpStatusCode', equals(401)),
        ),
      );
      final forgedOp =
          fakeBridge.opNamed('ai.countTokens')['op'] as Map<String, dynamic>;
      expect(
        forgedOp['appCheck'],
        equals(<String, dynamic>{'token': 'forged.jwt.token'}),
      );

      await unactivatedAppCheck.dispose();
    });
  });
}
