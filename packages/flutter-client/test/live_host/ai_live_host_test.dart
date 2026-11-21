import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show Firebase;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_ai.dart';
import 'package:pyric_firestore/pyric_app_check.dart';

import '../ai/ai_live_host_fixture.dart';

void main() {
  HttpOverrides? previousHttpOverrides;

  setUp(() async {
    previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    FirebasePlatform.instance = LiveAiFirebasePlatform();
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
        final bridgeUri = resolveLiveAiBridgeUri();
        if (bridgeUri == null) {
          final offlineApp = await Firebase.initializeApp(name: 'offline-ai-1');
          final googleAi = FirebaseAI.googleAI(app: offlineApp);
          expect(
            googleAi.generativeModel(model: 'gemini-2.5-flash').model,
            equals('models/gemini-2.5-flash'),
          );
          return;
        }

        final ctx = await connectLiveAiApp(bridgeUri, 'unary');
        try {
          final model = FirebaseAI.googleAI(
            app: ctx.app,
            bridgeClient: ctx.client,
            engine: scriptedAiEngineWire(),
          ).generativeModel(
            model: 'gemini-2.5-flash',
            systemInstruction: Content.system('You are a deterministic test assistant.'),
            generationConfig: GenerationConfig(temperature: 0.2, maxOutputTokens: 256),
            safetySettings: const <SafetySetting>[
              SafetySetting(HarmCategory.dangerousContent, HarmBlockThreshold.medium),
            ],
          );

          final recipeResponse = await model.generateContent(
            <Content>[Content.text('Return FLUTTER_AI_JSON_RECIPE')],
            generationConfig: GenerationConfig(responseMimeType: 'application/json'),
          );
          final decodedRecipe = jsonDecode(recipeResponse.text!) as Map<String, dynamic>;
          expect(decodedRecipe['dish'], equals('Matcha Pancakes'));
          expect(decodedRecipe['servings'], equals(2));
          expect(recipeResponse.usageMetadata?.totalTokenCount, greaterThan(0));

          final toolResponse = await model.generateContent(
            <Content>[Content.text('Invoke FLUTTER_AI_THOUGHT_AND_TOOL')],
          );
          expect(toolResponse.text, isNull);
          expect(toolResponse.thoughtSummary, equals('Need current weather for Kyoto.'));
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
        final bridgeUri = resolveLiveAiBridgeUri();
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

        final ctx = await connectLiveAiApp(bridgeUri, 'blocks');
        try {
          final model = FirebaseAI.googleAI(
            app: ctx.app,
            bridgeClient: ctx.client,
            engine: scriptedAiEngineWire(),
          ).generativeModel(model: 'gemini-2.5-flash');

          final safetyBlocked = await model.generateContent(
            <Content>[Content.text('Trigger FLUTTER_AI_SAFETY_BLOCK')],
          );
          expect(safetyBlocked.text, isNull);
          expect(safetyBlocked.candidates.single.finishReason, equals(FinishReason.safety));
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
            model.generateContent(<Content>[Content.text('Trigger FLUTTER_AI_QUOTA_ERR')]),
            throwsA(
              isA<QuotaExceeded>()
                  .having((err) => err.code, 'code', equals('quota-exceeded'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(429)),
            ),
          );

          await expectLater(
            model.countTokens(const <Content>[]),
            throwsA(
              isA<FirebaseAIException>()
                  .having((err) => err.code, 'code', equals('invalid-argument'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(400)),
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
        final bridgeUri = resolveLiveAiBridgeUri();
        if (bridgeUri == null) {
          final vertexModel = FirebaseAI.vertexAI(location: 'europe-west1')
              .generativeModel(model: 'gemini-2.5-flash');
          expect(vertexModel.model, equals('publishers/google/models/gemini-2.5-flash'));
          return;
        }

        final ctx = await connectLiveAiApp(bridgeUri, 'tokens');
        try {
          final model = FirebaseAI.vertexAI(
            app: ctx.app,
            location: 'us-central1',
            bridgeClient: ctx.client,
            engine: scriptedAiEngineWire(),
          ).generativeModel(
            model: 'gemini-2.5-flash',
            systemInstruction: Content.system('Count system tokens too.'),
          );

          final shortCount = await model.countTokens(<Content>[Content.text('short prompt')]);
          final longCount = await model.countTokens(<Content>[
            Content.text(
              'a substantially longer prompt containing many additional words for deterministic token counting',
            ),
          ]);
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
        final bridgeUri = resolveLiveAiBridgeUri();
        if (bridgeUri == null) {
          final offlineAppCheck =
              PyricFirebaseAppCheckPlatform(isTokenAutoRefreshEnabled: false);
          expect(offlineAppCheck.isActivated, isFalse);
          await offlineAppCheck.dispose();
          return;
        }

        final ctx = await connectLiveAiApp(bridgeUri, 'appcheck');
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
            engine: scriptedAiEngineWire(),
          ).generativeModel(model: 'gemini-2.5-flash');

          await expectLater(
            missingTokenModel.generateContent(
              <Content>[Content.text('Unactivated App Check request')],
            ),
            throwsA(
              isA<FirebaseAIException>()
                  .having((err) => err.code, 'code', equals('unauthenticated'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(401)),
            ),
          );

          final forgedModel = FirebaseAI.googleAI(
            app: ctx.app,
            appCheck: ForgedAppCheckPlatform('forged.invalid.jwt'),
            bridgeClient: ctx.client,
          ).generativeModel(model: 'gemini-2.5-flash');

          await expectLater(
            forgedModel.countTokens(<Content>[Content.text('Forged App Check token request')]),
            throwsA(
              isA<FirebaseAIException>()
                  .having((err) => err.code, 'code', equals('unauthenticated'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(401)),
            ),
          );

          PyricFirebaseAppCheckPlatform.registerWith(
            bridgeClient: ctx.client,
            isTokenAutoRefreshEnabled: false,
          );
          final liveAppCheck = FirebaseAppCheckPlatform.instanceFor(app: ctx.app)
              as PyricFirebaseAppCheckPlatform;
          await liveAppCheck.activate(providerAndroid: const AndroidPlayIntegrityProvider());

          final verifiedModel = FirebaseAI.vertexAI(
            app: ctx.app,
            location: 'us-central1',
          ).generativeModel(model: 'gemini-2.5-flash');

          final verifiedGen = await verifiedModel.generateContent(
            <Content>[Content.text('Authenticated App Check prompt')],
          );
          expect(verifiedGen.text, contains('Authenticated App Check prompt'));

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

    test(
      'streams generateContentStream chunks in order, supports early cancel worker-unsub, and gates stream App Check',
      () async {
        final bridgeUri = resolveLiveAiBridgeUri();
        if (bridgeUri == null) {
          final schema = Schema.enumString(enumValues: <String>['fast', 'accurate']);
          expect(schema.toJson()['format'], equals('enum'));
          return;
        }

        final ctx = await connectLiveAiApp(bridgeUri, 'stream');
        try {
          final model = FirebaseAI.googleAI(
            app: ctx.app,
            bridgeClient: ctx.client,
            engine: scriptedAiEngineWire(),
          ).generativeModel(model: 'gemini-2.5-flash');

          final fullChunks = await model
              .generateContentStream(<Content>[Content.text('Run FLUTTER_AI_STREAM_CHUNKS')])
              .map((chunk) => chunk.text)
              .toList();
          expect(fullChunks, equals(<String?>['Stream ', 'chunk ', 'complete!']));

          final partial = <String?>[];
          final firstArrived = Completer<void>();
          late final StreamSubscription<GenerateContentResponse> sub;
          sub = model
              .generateContentStream(<Content>[Content.text('Run FLUTTER_AI_STREAM_CANCEL')])
              .listen((chunk) {
            partial.add(chunk.text);
            if (!firstArrived.isCompleted) {
              firstArrived.complete();
            }
          });
          await firstArrived.future;
          await sub.cancel();
          expect(partial, hasLength(1));

          final forgedStreamModel = FirebaseAI.googleAI(
            app: ctx.app,
            appCheck: ForgedAppCheckPlatform('forged.invalid.jwt'),
            bridgeClient: ctx.client,
          ).generativeModel(model: 'gemini-2.5-flash');

          await expectLater(
            forgedStreamModel
                .generateContentStream(<Content>[Content.text('Forged stream request')])
                .toList(),
            throwsA(
              isA<FirebaseAIException>()
                  .having((err) => err.code, 'code', equals('unauthenticated')),
            ),
          );
        } finally {
          await ctx.client.disconnect();
        }
      },
    );

    test(
      'executes Schema structured output and multi-turn ChatSession tool calls, sendMessageStream, and block rollback',
      () async {
        final bridgeUri = resolveLiveAiBridgeUri();
        if (bridgeUri == null) {
          final decl = FunctionDeclaration(
            'lookupStock',
            'Fetch stock quote',
            parameters: <String, Schema>{'ticker': Schema.string()},
          );
          expect(decl.toJson()['name'], equals('lookupStock'));
          return;
        }

        final ctx = await connectLiveAiApp(bridgeUri, 'chat-schema');
        try {
          final ai = FirebaseAI.googleAI(
            app: ctx.app,
            bridgeClient: ctx.client,
            engine: scriptedAiEngineWire(),
          );

          final structuredSchema = Schema.object(
            properties: <String, Schema>{
              'status': Schema.enumString(enumValues: <String>['ok', 'degraded']),
              'count': Schema.integer(),
              'active': Schema.boolean(),
              'tags': Schema.array(items: Schema.string()),
            },
            optionalProperties: <String>['tags'],
            propertyOrdering: <String>['status', 'count', 'active', 'tags'],
          );
          final schemaRes = await ai
              .generativeModel(
                model: 'gemini-2.5-flash',
                generationConfig: GenerationConfig(
                  responseMimeType: 'application/json',
                  responseSchema: structuredSchema,
                ),
              )
              .generateContent(<Content>[Content.text('Synthesize schema output')]);
          final parsedJson = jsonDecode(schemaRes.text!) as Map<String, dynamic>;
          expect(parsedJson['status'], equals('ok'));
          expect(parsedJson['count'], equals(1));
          expect(parsedJson['active'], isTrue);

          final chatModel = ai.generativeModel(
            model: 'gemini-2.5-flash',
            tools: <Tool>[
              Tool.functionDeclarations(<FunctionDeclaration>[
                FunctionDeclaration(
                  'lookupStock',
                  'Look up ticker quote',
                  parameters: <String, Schema>{
                    'ticker': Schema.string(description: 'Ticker symbol'),
                  },
                ),
              ]),
            ],
            toolConfig: ToolConfig(functionCallingConfig: FunctionCallingConfig.auto()),
          );

          final chat = chatModel.startChat();
          final turn1 = await chat.sendMessage(
            Content.text('Quote FLUTTER_AI_CHAT_TOOL_START'),
          );
          final call = turn1.functionCalls.single;
          expect(call.name, equals('lookupStock'));
          expect(call.args['ticker'], equals('GOOG'));
          expect(call.thoughtSignature, isNotNull);
          expect(chat.history, hasLength(2));

          final turn2 = await chat.sendMessage(
            Content.functionResponse(
              call.name,
              <String, Object?>{'price': 198.25, 'currency': 'USD'},
              id: call.id,
            ),
          );
          expect(turn2.text, isNotNull);
          expect(chat.history, hasLength(4));

          final turn3Chunks = await chat
              .sendMessageStream(Content.text('Summarize FLUTTER_AI_CHAT_STREAM_TURN'))
              .map((c) => c.text)
              .toList();
          expect(turn3Chunks, equals(<String?>['GOOG trades ', 'at 198.25 USD.']));
          expect(chat.history, hasLength(6));

          final blockedTurn = await chat.sendMessage(
            Content.text('Check FLUTTER_AI_CHAT_SAFETY_TURN'),
          );
          expect(blockedTurn.candidates.single.finishReason, equals(FinishReason.safety));
          expect(chat.history, hasLength(6));
        } finally {
          await ctx.client.disconnect();
        }
      },
    );

    test(
      'round-trips multimodal InlineDataPart, candidateCount > 1 with ThoughtPart filtering, and error status parity',
      () async {
        final pngSignature = Uint8List.fromList(<int>[137, 80, 78, 71, 13, 10, 26, 10]);
        final bridgeUri = resolveLiveAiBridgeUri();
        if (bridgeUri == null) {
          final inline = InlineDataPart('image/png', pngSignature);
          expect((inline.toJson()['inlineData'] as Map)['data'], equals('iVBORw0KGgo='));
          return;
        }

        final ctx = await connectLiveAiApp(bridgeUri, 'multimodal');
        try {
          final model = FirebaseAI.googleAI(
            app: ctx.app,
            bridgeClient: ctx.client,
            engine: scriptedAiEngineWire(),
          ).generativeModel(
            model: 'gemini-2.5-flash',
            generationConfig: GenerationConfig(candidateCount: 2),
          );

          final multiRes = await model.generateContent(<Content>[
            Content.multi(<Part>[
              const TextPart('Inspect FLUTTER_AI_MULTIMODAL_CANDIDATES'),
              InlineDataPart('image/png', pngSignature),
            ]),
          ]);
          expect(multiRes.text, equals('Primary caption.'));
          expect(multiRes.thoughtSummary, equals('Analyzing 8-byte PNG header.'));
          expect(multiRes.inlineDataParts.single.bytes, equals(pngSignature));
          expect(multiRes.candidates, hasLength(2));
          expect(multiRes.candidates[1].text, equals('Secondary caption.'));
          expect(multiRes.usageMetadata?.promptTokenCount, equals(18));
          expect(multiRes.usageMetadata?.candidatesTokenCount, equals(14));
          expect(multiRes.usageMetadata?.thoughtsTokenCount, equals(5));
          expect(multiRes.usageMetadata?.totalTokenCount, equals(37));

          await expectLater(
            model.generateContent(<Content>[Content.text('Trigger FLUTTER_AI_PERMISSION_ERR')]),
            throwsA(
              isA<FirebaseAIException>()
                  .having((err) => err.code, 'code', equals('permission-denied'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(403)),
            ),
          );

          await expectLater(
            model.generateContent(<Content>[Content.text('Trigger FLUTTER_AI_UNAVAILABLE_ERR')]),
            throwsA(
              isA<ServerException>()
                  .having((err) => err.code, 'code', equals('unavailable'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(503)),
            ),
          );
        } finally {
          await ctx.client.disconnect();
        }
      },
    );

    test(
      'isolates concurrent generateContentStream cancellations on HostedRuntime without cross-stream interference',
      () async {
        final bridgeUri = resolveLiveAiBridgeUri();
        if (bridgeUri == null) {
          final unavailable = mapBridgeErrorToFirebaseAIException(
            const PyricBridgeException(code: 'ai/UNAVAILABLE', message: 'Offline check'),
          );
          expect(unavailable, isA<ServerException>());
          expect(unavailable.code, equals('unavailable'));
          return;
        }

        final ctx = await connectLiveAiApp(bridgeUri, 'concurrent-streams');
        try {
          final model = FirebaseAI.googleAI(
            app: ctx.app,
            bridgeClient: ctx.client,
            engine: scriptedAiEngineWire(),
          ).generativeModel(model: 'gemini-2.5-flash');

          final seenA = <String?>[];
          final firstA = Completer<void>();
          late final StreamSubscription<GenerateContentResponse> subA;
          subA = model
              .generateContentStream(
                <Content>[Content.text('Run FLUTTER_AI_CONCURRENT_CANCEL_A')],
              )
              .listen((chunk) {
            seenA.add(chunk.text);
            if (!firstA.isCompleted) {
              firstA.complete();
            }
          });

          final streamBFuture = model
              .generateContentStream(
                <Content>[Content.text('Run FLUTTER_AI_CONCURRENT_COMPLETE_B')],
              )
              .map((chunk) => chunk.text)
              .toList();

          await firstA.future;
          await subA.cancel();
          final seenB = await streamBFuture;

          expect(seenA, hasLength(1));
          expect(seenB, equals(<String?>['Parallel ', 'stream ', 'intact!']));
        } finally {
          await ctx.client.disconnect();
        }
      },
    );
  });
}
