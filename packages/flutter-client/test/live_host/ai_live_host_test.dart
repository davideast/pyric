import 'dart:convert';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase, FirebaseApp;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_ai.dart';
import 'package:pyric_firestore/pyric_app_check.dart';

class _LiveAiFirebasePlatform extends FirebasePlatform {
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
          appId: '1:424242424242:android:flutterailive',
          messagingSenderId: '424242424242',
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
        appId: '1:424242424242:android:flutterailive',
        messagingSenderId: '424242424242',
        projectId: 'demo-flutter-live',
      ),
    );
    _apps[name] = created;
    return created;
  }
}

class _ForgedAppCheckPlatform extends FirebaseAppCheckPlatform {
  final String? tokenValue;

  _ForgedAppCheckPlatform(this.tokenValue);

  @override
  Future<String?> getToken(bool forceRefresh) async => tokenValue;

  @override
  Future<String> getLimitedUseToken() async => tokenValue ?? '';
}

Uri? _resolveLiveBridgeUri() {
  final liveRaw = Platform.environment['PYRIC_LIVE_BRIDGE_URL']?.trim() ?? '';
  if (liveRaw.isNotEmpty) {
    return Uri.parse(liveRaw);
  }
  final fallbackRaw = Platform.environment['PYRIC_BRIDGE_URL']?.trim() ?? '';
  if (fallbackRaw.isNotEmpty) {
    return Uri.parse(fallbackRaw);
  }
  return null;
}

String _resolveLiveProjectId() {
  final raw = Platform.environment['PYRIC_LIVE_PROJECT_ID']?.trim() ?? '';
  if (raw.isNotEmpty) {
    return raw;
  }
  return 'demo-flutter-live';
}

Map<String, dynamic> _scriptedAiEngineWire() {
  return <String, dynamic>{
    'kind': 'scripted',
    'script': <Map<String, dynamic>>[
      <String, dynamic>{
        'match': 'FLUTTER_AI_JSON_RECIPE',
        'respond': <String, dynamic>{
          'json': <String, dynamic>{
            'dish': 'Matcha Pancakes',
            'servings': 2,
          },
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_THOUGHT_AND_TOOL',
        'respond': <String, dynamic>{
          'modelVersion': 'gemini-2.5-flash',
          'responseId': 'resp-live-tool-1',
          'candidates': <Map<String, dynamic>>[
            <String, dynamic>{
              'index': 0,
              'finishReason': 'STOP',
              'content': <String, dynamic>{
                'role': 'model',
                'parts': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'text': 'Need current weather for Kyoto.',
                    'thought': true,
                    'thoughtSignature': 'sig-live-thought-1',
                  },
                  <String, dynamic>{
                    'functionCall': <String, dynamic>{
                      'name': 'getCurrentWeather',
                      'args': <String, dynamic>{
                        'city': 'Kyoto',
                        'unit': 'celsius',
                      },
                      'id': 'call-kyoto-1',
                    },
                    'thoughtSignature': 'sig-live-fn-1',
                  },
                ],
              },
            },
          ],
          'usageMetadata': <String, dynamic>{
            'promptTokenCount': 12,
            'candidatesTokenCount': 9,
            'thoughtsTokenCount': 6,
            'totalTokenCount': 27,
          },
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_SAFETY_BLOCK',
        'respond': <String, dynamic>{
          'candidates': <Map<String, dynamic>>[
            <String, dynamic>{
              'index': 0,
              'finishReason': 'SAFETY',
              'finishMessage': 'Candidate blocked by safety filter.',
              'safetyRatings': <Map<String, dynamic>>[
                <String, dynamic>{
                  'category': 'HARM_CATEGORY_DANGEROUS_CONTENT',
                  'probability': 'HIGH',
                  'blocked': true,
                },
              ],
            },
          ],
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_RECITATION_BLOCK',
        'respond': <String, dynamic>{
          'candidates': <Map<String, dynamic>>[
            <String, dynamic>{
              'index': 0,
              'finishReason': 'RECITATION',
              'finishMessage': 'Candidate blocked due to recitation.',
            },
          ],
        },
      },
      <String, dynamic>{
        'match': 'FLUTTER_AI_QUOTA_ERR',
        'respond': <String, dynamic>{
          'error': <String, dynamic>{
            'code': 429,
            'message': 'Quota exhausted for model gemini-2.5-flash.',
            'status': 'RESOURCE_EXHAUSTED',
          },
        },
      },
    ],
  };
}

Future<({FirebaseApp app, PyricBridgeClient client})> _connectLiveApp(
  Uri bridgeUri,
  String suffix,
) async {
  final projectId = _resolveLiveProjectId();
  final liveApp = await Firebase.initializeApp(
    name: 'flutter-ai-$suffix-${DateTime.now().microsecondsSinceEpoch}',
    options: FirebaseOptions(
      apiKey: 'demo-flutter-live-api-key',
      appId: '1:424242424242:android:flutterailive',
      messagingSenderId: '424242424242',
      projectId: projectId,
    ),
  );
  final client = PyricBridgeClient(
    uri: bridgeUri,
    headers: <String, dynamic>{'Host': '${bridgeUri.host}:${bridgeUri.port}'},
  );
  await client.connect();
  return (app: liveApp, client: client);
}

void main() {
  HttpOverrides? previousHttpOverrides;

  setUp(() async {
    previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    FirebasePlatform.instance = _LiveAiFirebasePlatform();
    await FirebaseAI.clearInstancesForTest();
    await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
  });

  tearDown(() async {
    await FirebaseAI.clearInstancesForTest();
    await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
    HttpOverrides.global = previousHttpOverrides;
  });

  group('Pyric Flutter AI Logic live-host conformance', () {
    test(
      'executes unary generateContent and structured JSON, ThoughtPart, and FunctionCall decoding',
      () async {
        final bridgeUri = _resolveLiveBridgeUri();
        if (bridgeUri == null) {
          final offlineApp = await Firebase.initializeApp(name: 'offline-ai-1');
          final googleAi = FirebaseAI.googleAI(app: offlineApp);
          expect(
            googleAi.generativeModel(model: 'gemini-2.5-flash').model,
            equals('models/gemini-2.5-flash'),
          );
          return;
        }

        final ctx = await _connectLiveApp(bridgeUri, 'unary');
        try {
          final model = FirebaseAI.googleAI(
            app: ctx.app,
            bridgeClient: ctx.client,
            engine: _scriptedAiEngineWire(),
          ).generativeModel(
            model: 'gemini-2.5-flash',
            systemInstruction:
                Content.system('You are a deterministic test assistant.'),
            generationConfig: GenerationConfig(
              temperature: 0.2,
              maxOutputTokens: 256,
            ),
            safetySettings: const <SafetySetting>[
              SafetySetting(
                HarmCategory.dangerousContent,
                HarmBlockThreshold.medium,
              ),
            ],
          );

          final recipeResponse = await model.generateContent(
            <Content>[Content.text('Return FLUTTER_AI_JSON_RECIPE')],
            generationConfig: GenerationConfig(
              responseMimeType: 'application/json',
            ),
          );
          expect(recipeResponse.text, isNotNull);
          final decodedRecipe =
              jsonDecode(recipeResponse.text!) as Map<String, dynamic>;
          expect(decodedRecipe['dish'], equals('Matcha Pancakes'));
          expect(decodedRecipe['servings'], equals(2));
          expect(
            recipeResponse.usageMetadata?.totalTokenCount,
            greaterThan(0),
          );

          final toolResponse = await model.generateContent(
            <Content>[Content.text('Invoke FLUTTER_AI_THOUGHT_AND_TOOL')],
          );
          expect(toolResponse.text, isNull);
          expect(
            toolResponse.thoughtSummary,
            equals('Need current weather for Kyoto.'),
          );
          expect(toolResponse.functionCalls, hasLength(1));
          final fnCall = toolResponse.functionCalls.single;
          expect(fnCall.name, equals('getCurrentWeather'));
          expect(fnCall.args['city'], equals('Kyoto'));
          expect(fnCall.thoughtSignature, equals('sig-live-fn-1'));
          expect(toolResponse.usageMetadata?.thoughtsTokenCount, equals(6));
        } finally {
          await ctx.client.disconnect();
        }
      },
    );

    test(
      'handles SAFETY and RECITATION blocked candidates and maps 429/400 wire errors to FirebaseAIException',
      () async {
        final bridgeUri = _resolveLiveBridgeUri();
        if (bridgeUri == null) {
          final mapped = mapBridgeErrorToFirebaseAIException(
            const PyricBridgeException(
              code: 'ai/RESOURCE_EXHAUSTED',
              message: 'Offline quota check',
            ),
          );
          expect(mapped.code, equals('quota-exceeded'));
          return;
        }

        final ctx = await _connectLiveApp(bridgeUri, 'blocks');
        try {
          final model = FirebaseAI.googleAI(
            app: ctx.app,
            bridgeClient: ctx.client,
            engine: _scriptedAiEngineWire(),
          ).generativeModel(model: 'gemini-2.5-flash');

          final safetyBlocked = await model.generateContent(
            <Content>[Content.text('Trigger FLUTTER_AI_SAFETY_BLOCK')],
          );
          expect(safetyBlocked.text, isNull);
          expect(
            safetyBlocked.candidates.single.finishReason,
            equals(FinishReason.safety),
          );
          expect(
            safetyBlocked.candidates.single.safetyRatings?.single.category,
            equals(HarmCategory.dangerousContent),
          );

          final recitationBlocked = await model.generateContent(
            <Content>[Content.text('Trigger FLUTTER_AI_RECITATION_BLOCK')],
          );
          expect(recitationBlocked.text, isNull);
          expect(
            recitationBlocked.candidates.single.finishReason,
            equals(FinishReason.recitation),
          );

          await expectLater(
            model.generateContent(
              <Content>[Content.text('Trigger FLUTTER_AI_QUOTA_ERR')],
            ),
            throwsA(
              isA<QuotaExceeded>()
                  .having((err) => err.code, 'code', equals('quota-exceeded'))
                  .having(
                    (err) => err.httpStatusCode,
                    'httpStatusCode',
                    equals(429),
                  ),
            ),
          );

          await expectLater(
            model.countTokens(const <Content>[]),
            throwsA(
              isA<FirebaseAIException>()
                  .having((err) => err.code, 'code', equals('invalid-argument'))
                  .having(
                    (err) => err.httpStatusCode,
                    'httpStatusCode',
                    equals(400),
                  ),
            ),
          );
        } finally {
          await ctx.client.disconnect();
        }
      },
    );

    test(
      'counts prompt tokens deterministically via ai.countTokens across Google AI and Vertex AI models',
      () async {
        final bridgeUri = _resolveLiveBridgeUri();
        if (bridgeUri == null) {
          final vertexModel = FirebaseAI.vertexAI(location: 'europe-west1')
              .generativeModel(model: 'gemini-2.5-flash');
          expect(
            vertexModel.model,
            equals('publishers/google/models/gemini-2.5-flash'),
          );
          return;
        }

        final ctx = await _connectLiveApp(bridgeUri, 'tokens');
        try {
          final model = FirebaseAI.vertexAI(
            app: ctx.app,
            location: 'us-central1',
            bridgeClient: ctx.client,
            engine: _scriptedAiEngineWire(),
          ).generativeModel(
            model: 'gemini-2.5-flash',
            systemInstruction: Content.system('Count system tokens too.'),
          );

          final shortCount = await model.countTokens(
            <Content>[Content.text('short prompt')],
          );
          final longCount = await model.countTokens(
            <Content>[
              Content.text(
                'a substantially longer prompt containing many additional words for deterministic token counting',
              ),
            ],
          );
          expect(shortCount.totalTokens, greaterThan(0));
          expect(longCount.totalTokens, greaterThan(shortCount.totalTokens));
        } finally {
          await ctx.client.disconnect();
        }
      },
    );

    test(
      'enforces RS256 App Check tokens across missing, forged, standard, and limited-use claims',
      () async {
        final bridgeUri = _resolveLiveBridgeUri();
        if (bridgeUri == null) {
          final offlineAppCheck =
              PyricFirebaseAppCheckPlatform(isTokenAutoRefreshEnabled: false);
          expect(offlineAppCheck.isActivated, isFalse);
          await offlineAppCheck.dispose();
          return;
        }

        final ctx = await _connectLiveApp(bridgeUri, 'appcheck');
        PyricFirebaseAppCheckPlatform? unactivatedAppCheck;
        try {
          unactivatedAppCheck = PyricFirebaseAppCheckPlatform(
            appInstance: ctx.app,
            bridgeClient: ctx.client,
            isTokenAutoRefreshEnabled: false,
          );
          final missingTokenModel = FirebaseAI.vertexAI(
            app: ctx.app,
            appCheck: unactivatedAppCheck,
            bridgeClient: ctx.client,
            engine: _scriptedAiEngineWire(),
          ).generativeModel(model: 'gemini-2.5-flash');

          await expectLater(
            missingTokenModel.generateContent(
              <Content>[Content.text('Unactivated App Check request')],
            ),
            throwsA(
              isA<FirebaseAIException>()
                  .having((err) => err.code, 'code', equals('unauthenticated'))
                  .having(
                    (err) => err.httpStatusCode,
                    'httpStatusCode',
                    equals(401),
                  ),
            ),
          );

          final forgedModel = FirebaseAI.googleAI(
            app: ctx.app,
            appCheck: _ForgedAppCheckPlatform('forged.invalid.jwt'),
            bridgeClient: ctx.client,
          ).generativeModel(model: 'gemini-2.5-flash');

          await expectLater(
            forgedModel.countTokens(
              <Content>[Content.text('Forged App Check token request')],
            ),
            throwsA(
              isA<FirebaseAIException>()
                  .having((err) => err.code, 'code', equals('unauthenticated'))
                  .having(
                    (err) => err.httpStatusCode,
                    'httpStatusCode',
                    equals(401),
                  ),
            ),
          );

          PyricFirebaseAppCheckPlatform.registerWith(
            bridgeClient: ctx.client,
            isTokenAutoRefreshEnabled: false,
          );
          final liveAppCheck =
              FirebaseAppCheckPlatform.instanceFor(app: ctx.app)
                  as PyricFirebaseAppCheckPlatform;
          await liveAppCheck.activate(
            providerAndroid: const AndroidPlayIntegrityProvider(),
          );

          final verifiedModel = FirebaseAI.vertexAI(
            app: ctx.app,
            location: 'us-central1',
          ).generativeModel(model: 'gemini-2.5-flash');

          final verifiedGen = await verifiedModel.generateContent(
            <Content>[Content.text('Authenticated App Check prompt')],
          );
          expect(
            verifiedGen.text,
            contains('Authenticated App Check prompt'),
          );

          final verifiedCount = await verifiedModel.countTokens(
            <Content>[Content.text('Authenticated App Check prompt')],
          );
          expect(verifiedCount.totalTokens, greaterThan(0));

          final limitedUseModel = FirebaseAI.googleAI(
            app: ctx.app,
            appCheck: liveAppCheck,
            useLimitedUseAppCheckTokens: true,
          ).generativeModel(model: 'gemini-2.5-flash');
          final limitedGen = await limitedUseModel.generateContent(
            <Content>[Content.text('Limited-use App Check prompt')],
          );
          expect(limitedGen.text, contains('Limited-use App Check prompt'));
        } finally {
          await unactivatedAppCheck?.dispose();
          await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
          await FirebaseAI.clearInstancesForTest();
          await ctx.client.disconnect();
        }
      },
    );
  });
}
