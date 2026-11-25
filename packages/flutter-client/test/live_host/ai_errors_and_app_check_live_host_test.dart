import 'dart:async';
import 'dart:convert';
import 'dart:io';

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

  group('Pyric Flutter AI Logic specialized errors, deadlines, and stream App Check', () {
    test(
      'specializes InvalidApiKey, ServiceApiNotEnabled, and UnsupportedUserLocation from ErrorInfo details and fallback messages',
      () async {
        final bridgeUri = resolveLiveAiBridgeUri();
        if (bridgeUri == null) {
          final offline = mapBridgeErrorToFirebaseAIException(
            const PyricBridgeException(
              code: 'ai/INVALID_ARGUMENT',
              message: 'Request credential rejected.',
              envelope: <String, dynamic>{
                'error': <String, dynamic>{
                  'code': 400,
                  'message': 'Request credential rejected.',
                  'status': 'INVALID_ARGUMENT',
                  'details': <Map<String, dynamic>>[
                    <String, dynamic>{
                      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                      'reason': 'API_KEY_INVALID',
                    },
                  ],
                },
              },
            ),
          );
          expect(offline, isA<InvalidApiKey>());
          expect(offline.errorDetails?.single['reason'], equals('API_KEY_INVALID'));
          return;
        }

        final ctx = await connectLiveAiApp(bridgeUri, 'specialized-errors');
        try {
          final model = FirebaseAI.googleAI(
            app: ctx.app,
            bridgeClient: ctx.client,
            engine: scriptedAiEngineWire(),
          ).generativeModel(model: 'gemini-2.5-flash');

          await expectLater(
            model.generateContent(
              <Content>[Content.text('Probe FLUTTER_AI_ERR_INVALID_KEY_DETAIL')],
            ),
            throwsA(
              isA<InvalidApiKey>()
                  .having((err) => err.code, 'code', equals('invalid-argument'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(400))
                  .having((err) => err.wireStatus, 'wireStatus', equals('INVALID_ARGUMENT'))
                  .having(
                    (err) => err.errorDetails?.single['reason'],
                    'reason',
                    equals('API_KEY_INVALID'),
                  ),
            ),
          );

          await expectLater(
            model.generateContent(
              <Content>[Content.text('Probe FLUTTER_AI_ERR_INVALID_KEY_MSG')],
            ),
            throwsA(
              isA<InvalidApiKey>()
                  .having((err) => err.code, 'code', equals('invalid-argument'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(400)),
            ),
          );

          await expectLater(
            model.generateContent(
              <Content>[Content.text('Probe FLUTTER_AI_ERR_DISABLED_DETAIL')],
            ),
            throwsA(
              isA<ServiceApiNotEnabled>()
                  .having((err) => err.code, 'code', equals('permission-denied'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(403))
                  .having((err) => err.wireStatus, 'wireStatus', equals('PERMISSION_DENIED'))
                  .having(
                    (err) => err.errorDetails?.single['reason'],
                    'reason',
                    equals('SERVICE_DISABLED'),
                  ),
            ),
          );

          await expectLater(
            model.generateContent(
              <Content>[Content.text('Probe FLUTTER_AI_ERR_DISABLED_MSG')],
            ),
            throwsA(
              isA<ServiceApiNotEnabled>()
                  .having((err) => err.code, 'code', equals('permission-denied'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(403)),
            ),
          );

          await expectLater(
            model.generateContent(
              <Content>[Content.text('Probe FLUTTER_AI_ERR_LOCATION_DETAIL')],
            ),
            throwsA(
              isA<UnsupportedUserLocation>()
                  .having((err) => err.code, 'code', equals('invalid-argument'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(400))
                  .having((err) => err.wireStatus, 'wireStatus', equals('FAILED_PRECONDITION'))
                  .having(
                    (err) => err.errorDetails?.single['reason'],
                    'reason',
                    equals('USER_LOCATION_NOT_SUPPORTED'),
                  ),
            ),
          );

          await expectLater(
            model.generateContent(
              <Content>[Content.text('Probe FLUTTER_AI_ERR_LOCATION_MSG')],
            ),
            throwsA(
              isA<UnsupportedUserLocation>()
                  .having((err) => err.code, 'code', equals('invalid-argument'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(400)),
            ),
          );

          await expectLater(
            model
                .generateContentStream(
                  <Content>[Content.text('Probe FLUTTER_AI_STREAM_ERR_LOCATION_DETAIL')],
                )
                .toList(),
            throwsA(
              isA<UnsupportedUserLocation>()
                  .having(
                    (err) => err.errorDetails?.single['reason'],
                    'reason',
                    equals('USER_LOCATION_NOT_SUPPORTED'),
                  ),
            ),
          );
        } finally {
          await ctx.client.disconnect();
        }
      },
    );

    test(
      'maps native RETIRED_MODEL 404 details, 504 DEADLINE_EXCEEDED wire errors, and op timeouts',
      () async {
        final bridgeUri = resolveLiveAiBridgeUri();
        if (bridgeUri == null) {
          final retired = mapBridgeErrorToFirebaseAIException(
            const PyricBridgeException(
              code: 'ai/NOT_FOUND',
              message: 'Gemini 1.5 models are retired as of September 24, 2025.',
              envelope: <String, dynamic>{
                'error': <String, dynamic>{
                  'code': 404,
                  'message': 'Gemini 1.5 models are retired as of September 24, 2025.',
                  'status': 'NOT_FOUND',
                  'details': <Map<String, dynamic>>[
                    <String, dynamic>{
                      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                      'reason': 'RETIRED_MODEL',
                    },
                  ],
                },
              },
            ),
          );
          expect(retired.code, equals('not-found'));
          expect(retired.httpStatusCode, equals(404));
          expect(retired.errorDetails?.single['reason'], equals('RETIRED_MODEL'));
          return;
        }

        final ctx = await connectLiveAiApp(bridgeUri, 'retired-and-deadline');
        try {
          final ai = FirebaseAI.googleAI(
            app: ctx.app,
            bridgeClient: ctx.client,
            engine: scriptedAiEngineWire(),
          );
          final retiredModel = ai.generativeModel(model: 'gemini-1.5-flash');

          for (final op in <Future<Object?> Function()>[
            () => retiredModel.generateContent(<Content>[Content.text('Check retired unary')]),
            () => retiredModel.countTokens(<Content>[Content.text('Check retired count')]),
            () => retiredModel
                .generateContentStream(<Content>[Content.text('Check retired stream')])
                .toList(),
          ]) {
            await expectLater(
              op(),
              throwsA(
                isA<FirebaseAIException>()
                    .having((err) => err.code, 'code', equals('not-found'))
                    .having((err) => err.httpStatusCode, 'httpStatusCode', equals(404))
                    .having((err) => err.wireStatus, 'wireStatus', equals('NOT_FOUND'))
                    .having(
                      (err) => err.errorDetails?.single['reason'],
                      'reason',
                      equals('RETIRED_MODEL'),
                    ),
              ),
            );
          }

          final activeModel = ai.generativeModel(model: 'gemini-2.5-flash');
          await expectLater(
            activeModel.generateContent(
              <Content>[Content.text('Probe FLUTTER_AI_ERR_DEADLINE_WIRE')],
            ),
            throwsA(
              isA<ServerException>()
                  .having((err) => err.code, 'code', equals('deadline-exceeded'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(504))
                  .having((err) => err.wireStatus, 'wireStatus', equals('DEADLINE_EXCEEDED')),
            ),
          );

          final silentServer = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
          final silentSockets = <WebSocket>[];
          unawaited(
            silentServer.forEach((HttpRequest request) async {
              if (!WebSocketTransformer.isUpgradeRequest(request)) {
                request.response.statusCode = HttpStatus.notFound;
                await request.response.close();
                return;
              }
              final socket = await WebSocketTransformer.upgrade(request);
              silentSockets.add(socket);
              socket.listen((dynamic raw) {
                final decoded = jsonDecode(raw as String) as Map<String, dynamic>;
                if (decoded['type'] == 'attach') {
                  socket.add(
                    jsonEncode(<String, dynamic>{
                      'type': 'attach-ack',
                      'protocol': 1,
                      'bridgeVersion': '0.0.0-test',
                      'peerConnected': true,
                      'clientSessionId': 'silent-deadline-session',
                    }),
                  );
                } else if (decoded['type'] == 'ping') {
                  socket.add(jsonEncode(<String, dynamic>{'type': 'pong', 'id': decoded['id']}));
                }
              });
            }),
          );

          final timeoutClient = PyricBridgeClient(
            uri: Uri.parse('ws://127.0.0.1:${silentServer.port}/__pyric/sandbox'),
            headers: <String, dynamic>{'Host': '127.0.0.1:${silentServer.port}'},
            defaultOpTimeout: const Duration(milliseconds: 40),
          );
          try {
            await timeoutClient.connect();
            final timeoutModel = FirebaseAI.googleAI(
              app: ctx.app,
              bridgeClient: timeoutClient,
            ).generativeModel(model: 'gemini-2.5-flash');

            await expectLater(
              timeoutModel.generateContent(<Content>[Content.text('Slow request')]),
              throwsA(
                isA<ServerException>()
                    .having((err) => err.code, 'code', equals('deadline-exceeded'))
                    .having((err) => err.httpStatusCode, 'httpStatusCode', equals(504))
                    .having((err) => err.wireStatus, 'wireStatus', equals('DEADLINE_EXCEEDED')),
              ),
            );
          } finally {
            await timeoutClient.disconnect();
            for (final ws in silentSockets) {
              await ws.close();
            }
            await silentServer.close(force: true);
          }
        } finally {
          await ctx.client.disconnect();
        }
      },
    );

    test(
      'enforces stream App Check (unactivated, standard cached, limited-use) and stream safety/quota mapping',
      () async {
        final bridgeUri = resolveLiveAiBridgeUri();
        if (bridgeUri == null) {
          final quota = mapBridgeErrorToFirebaseAIException(
            const PyricBridgeException(
              code: 'ai/RESOURCE_EXHAUSTED',
              message: 'Offline stream quota check.',
            ),
          );
          expect(quota, isA<QuotaExceeded>());
          return;
        }

        final ctx = await connectLiveAiApp(bridgeUri, 'stream-security-and-blocks');
        PyricFirebaseAppCheckPlatform? unactivatedAppCheck;
        try {
          unactivatedAppCheck = PyricFirebaseAppCheckPlatform(
            appInstance: ctx.app,
            bridgeClient: ctx.client,
            isTokenAutoRefreshEnabled: false,
          );
          final unactivatedStreamModel = FirebaseAI.googleAI(
            app: ctx.app,
            appCheck: unactivatedAppCheck,
            bridgeClient: ctx.client,
            engine: scriptedAiEngineWire(),
          ).generativeModel(model: 'gemini-2.5-flash');

          await expectLater(
            unactivatedStreamModel
                .generateContentStream(<Content>[Content.text('Unactivated stream request')])
                .toList(),
            throwsA(
              isA<FirebaseAIException>()
                  .having((err) => err.code, 'code', equals('unauthenticated'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(401))
                  .having((err) => err.wireStatus, 'wireStatus', equals('UNAUTHENTICATED')),
            ),
          );

          PyricFirebaseAppCheckPlatform.registerWith(
            bridgeClient: ctx.client,
            isTokenAutoRefreshEnabled: false,
          );
          final liveAppCheck = FirebaseAppCheckPlatform.instanceFor(app: ctx.app)
              as PyricFirebaseAppCheckPlatform;
          await liveAppCheck.activate(providerAndroid: const AndroidPlayIntegrityProvider());

          final standardStreamModel = FirebaseAI.googleAI(
            app: ctx.app,
            appCheck: liveAppCheck,
          ).generativeModel(model: 'gemini-2.5-flash');
          final stdChunks = await standardStreamModel
              .generateContentStream(
                <Content>[Content.text('Run FLUTTER_AI_APPCHECK_STREAM_STD')],
              )
              .map((chunk) => chunk.text)
              .toList();
          expect(stdChunks, equals(<String?>['Standard ', 'stream ', 'verified.']));

          final limitedStreamModel = FirebaseAI.vertexAI(
            app: ctx.app,
            appCheck: liveAppCheck,
            useLimitedUseAppCheckTokens: true,
          ).generativeModel(model: 'gemini-2.5-flash');
          final limChunks = await limitedStreamModel
              .generateContentStream(
                <Content>[Content.text('Run FLUTTER_AI_APPCHECK_STREAM_LIM')],
              )
              .map((chunk) => chunk.text)
              .toList();
          expect(limChunks, equals(<String?>['Limited ', 'stream ', 'verified.']));

          final safetyChunks = await standardStreamModel
              .generateContentStream(
                <Content>[Content.text('Run FLUTTER_AI_STREAM_SAFETY_BLOCK')],
              )
              .toList();
          expect(safetyChunks.single.text, isNull);
          expect(safetyChunks.single.candidates.single.finishReason, equals(FinishReason.safety));

          final recitationChunks = await standardStreamModel
              .generateContentStream(
                <Content>[Content.text('Run FLUTTER_AI_STREAM_RECITATION_BLOCK')],
              )
              .toList();
          expect(recitationChunks.single.text, isNull);
          expect(
            recitationChunks.single.candidates.single.finishReason,
            equals(FinishReason.recitation),
          );

          await expectLater(
            standardStreamModel
                .generateContentStream(<Content>[Content.text('Run FLUTTER_AI_STREAM_ERR_QUOTA')])
                .toList(),
            throwsA(
              isA<QuotaExceeded>()
                  .having((err) => err.code, 'code', equals('quota-exceeded'))
                  .having((err) => err.httpStatusCode, 'httpStatusCode', equals(429)),
            ),
          );
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
