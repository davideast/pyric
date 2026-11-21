import 'dart:async';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show Firebase, FirebaseApp;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_ai.dart';
import 'package:pyric_firestore/pyric_app_check.dart';

import '../helpers/fake_bridge.dart';

class _TestFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  static const FirebaseOptions _defaultOptions = FirebaseOptions(
    apiKey: 'test-api-key',
    appId: '1:100:android:test',
    messagingSenderId: '100',
    projectId: 'demo-ai-concurrency',
  );

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final resolvedName = name ?? defaultFirebaseAppName;
    final created = FirebaseAppPlatform(resolvedName, options ?? _defaultOptions);
    _apps[resolvedName] = created;
    return created;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(name, _defaultOptions),
    );
  }
}

class _DelayedAppCheckPlatform extends FirebaseAppCheckPlatform {
  final Future<String?> Function() _tokenLoader;

  _DelayedAppCheckPlatform(this._tokenLoader);

  @override
  Future<String?> getToken(bool forceRefresh) => _tokenLoader();

  @override
  Future<String> getLimitedUseToken() async => (await _tokenLoader()) ?? '';
}

Map<String, dynamic> _textChunkSnap(String subId, String text) {
  return <String, dynamic>{
    'type': 'worker-snap',
    'subId': subId,
    'value': <String, dynamic>{
      'chunk': <String, dynamic>{
        'candidates': <Map<String, dynamic>>[
          <String, dynamic>{
            'index': 0,
            'finishReason': 'STOP',
            'content': <String, dynamic>{
              'role': 'model',
              'parts': <Map<String, dynamic>>[
                <String, dynamic>{'text': text},
              ],
            },
          },
        ],
      },
    },
  };
}

Map<String, dynamic> _doneSnap(String subId) {
  return <String, dynamic>{
    'type': 'worker-snap',
    'subId': subId,
    'value': const <String, dynamic>{'done': true},
  };
}

String _promptTextFromSubFrame(Map<String, dynamic> subFrame) {
  final sub = subFrame['sub'] as Map<String, dynamic>;
  final request = sub['request'] as Map<String, dynamic>;
  final contents = request['contents'] as List<dynamic>;
  final lastTurn = contents.last as Map<String, dynamic>;
  final parts = lastTurn['parts'] as List<dynamic>;
  return (parts.first as Map<String, dynamic>)['text'] as String;
}

void main() {
  group('Concurrent AI stream multiplexing, cancellation, and ChatSession safety', () {
    late FakeBridge fakeBridge;
    late PyricBridgeClient client;
    late FirebaseApp app;
    late GenerativeModel model;

    setUp(() async {
      FirebasePlatform.instance = _TestFirebasePlatform();
      await FirebaseAI.clearInstancesForTest();
      await PyricFirebaseAppCheckPlatform.clearInstancesForTest();

      fakeBridge = FakeBridge();
      client = PyricBridgeClient(
        channelFactory: fakeBridge.connect,
        retryInitialConnection: true,
        reconnectDelay: (_) => const Duration(milliseconds: 10),
      );
      await client.connect();

      app = await Firebase.initializeApp(name: 'ai-concurrent-app');
      model = FirebaseAI.googleAI(
        app: app,
        bridgeClient: client,
      ).generativeModel(model: 'gemini-2.5-flash');
    });

    tearDown(() async {
      await FirebaseAI.clearInstancesForTest();
      await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
      await client.disconnect();
    });

    test('multiplexes 3 concurrent streams and cancels middle stream without cross-talk', () async {
      final chunksA = <String?>[];
      final chunksB = <String?>[];
      final chunksC = <String?>[];
      final doneA = Completer<void>();
      final doneC = Completer<void>();
      final firstB = Completer<void>();
      Object? errorC;

      final subA = model
          .generateContentStream(<Content>[Content.text('prompt-A')])
          .listen((r) => chunksA.add(r.text), onDone: doneA.complete);
      final subB = model
          .generateContentStream(<Content>[Content.text('prompt-B')])
          .listen((r) {
            chunksB.add(r.text);
            if (!firstB.isCompleted) {
              firstB.complete();
            }
          });
      final subC = model
          .generateContentStream(<Content>[Content.text('prompt-C')])
          .listen(
            (r) => chunksC.add(r.text),
            onError: (Object err) => errorC = err,
            onDone: doneC.complete,
          );

      await until(() => fakeBridge.ofType('worker-sub').length == 3);
      final subIdByPrompt = <String, String>{
        for (final frame in fakeBridge.ofType('worker-sub'))
          _promptTextFromSubFrame(frame): frame['subId'] as String,
      };
      final idA = subIdByPrompt['prompt-A']!;
      final idB = subIdByPrompt['prompt-B']!;
      final idC = subIdByPrompt['prompt-C']!;
      expect(<String>{idA, idB, idC}, hasLength(3));

      fakeBridge.current.deliver(_textChunkSnap(idA, 'A1-'));
      fakeBridge.current.deliver(_textChunkSnap(idB, 'B1-'));
      fakeBridge.current.deliver(_textChunkSnap(idC, 'C1-'));

      await firstB.future;
      await subB.cancel();

      await until(() => fakeBridge.ofType('worker-unsub').length == 1);
      expect(fakeBridge.ofType('worker-unsub').single['subId'], equals(idB));

      // Late frame on cancelled stream B is ignored; streams A and C continue.
      fakeBridge.current.deliver(_textChunkSnap(idB, 'B2-ignored'));
      fakeBridge.current.deliver(_textChunkSnap(idA, 'A2'));
      fakeBridge.current.deliver(_doneSnap(idA));
      fakeBridge.current.deliver(<String, dynamic>{
        'type': 'worker-snap',
        'subId': idC,
        'value': <String, dynamic>{
          '__error': <String, dynamic>{
            'code': 'ai/UNAVAILABLE',
            'message': 'Upstream model capacity temporarily unavailable.',
          },
        },
      });

      await doneA.future;
      await doneC.future;

      expect(chunksA, equals(<String?>['A1-', 'A2']));
      expect(chunksB, equals(<String?>['B1-']));
      expect(chunksC, equals(<String?>['C1-']));
      expect(
        errorC,
        isA<ServerException>()
            .having((e) => e.code, 'code', equals('unavailable'))
            .having((e) => e.httpStatusCode, 'httpStatusCode', equals(503)),
      );

      await until(() => fakeBridge.ofType('worker-unsub').length == 3);

      // Reconnecting socket must NOT replay any of the 3 settled AI streams.
      fakeBridge.current.drop();
      await until(() => fakeBridge.sockets.length == 2 && client.isConnected);
      expect(fakeBridge.ofType('worker-sub'), hasLength(3));

      await subA.cancel();
      await subC.cancel();
    });

    test('cancelling one stream during async App Check resolution only subscribes survivor', () async {
      final tokenGate = Completer<String?>();
      final gatedModel = FirebaseAI.googleAI(
        app: app,
        appCheck: _DelayedAppCheckPlatform(() => tokenGate.future),
        bridgeClient: client,
      ).generativeModel(model: 'gemini-2.5-flash');

      final survivorChunks = <String?>[];
      final survivorDone = Completer<void>();

      final abortedSub = gatedModel
          .generateContentStream(<Content>[Content.text('aborted-before-token')])
          .listen((_) {});
      final survivorSub = gatedModel
          .generateContentStream(<Content>[Content.text('survives-token-wait')])
          .listen((r) => survivorChunks.add(r.text), onDone: survivorDone.complete);

      await settle();
      await abortedSub.cancel();
      expect(fakeBridge.ofType('worker-sub'), isEmpty);

      tokenGate.complete('valid.rs256.jwt');
      await until(() => fakeBridge.ofType('worker-sub').length == 1);

      final subFrame = fakeBridge.ofType('worker-sub').single;
      expect(_promptTextFromSubFrame(subFrame), equals('survives-token-wait'));
      final subId = subFrame['subId'] as String;

      fakeBridge.current.deliver(_textChunkSnap(subId, 'delivered'));
      fakeBridge.current.deliver(_doneSnap(subId));

      await survivorDone.future;
      expect(survivorChunks, equals(<String?>['delivered']));
      await survivorSub.cancel();
    });

    test('synchronous cancel inside listener coordinates cleanly with back-to-back {done: true}', () async {
      final seen = <String?>[];
      final cancelDone = Completer<void>();
      late final StreamSubscription<GenerateContentResponse> sub;

      sub = model
          .generateContentStream(<Content>[Content.text('rapid-burst')])
          .listen((chunk) {
            seen.add(chunk.text);
            unawaited(sub.cancel().then((_) => cancelDone.complete()));
          });

      await until(() => fakeBridge.ofType('worker-sub').length == 1);
      final subId = fakeBridge.ofType('worker-sub').single['subId'] as String;

      // Deliver two chunks plus {done: true} in the same synchronous burst.
      fakeBridge.current.deliver(_textChunkSnap(subId, 'burst-1'));
      fakeBridge.current.deliver(_textChunkSnap(subId, 'burst-2'));
      fakeBridge.current.deliver(_doneSnap(subId));

      await cancelDone.future;
      await until(() => fakeBridge.ofType('worker-unsub').length == 1);
      expect(fakeBridge.ofType('worker-unsub').single['subId'], equals(subId));
      expect(seen, equals(<String?>['burst-1']));
    });

    test('independent pause and resume across concurrent streams preserves per-stream order', () async {
      final out1 = <String?>[];
      final out2 = <String?>[];
      final done1 = Completer<void>();
      final done2 = Completer<void>();

      final sub1 = model
          .generateContentStream(<Content>[Content.text('paused-stream')])
          .listen((r) => out1.add(r.text), onDone: done1.complete);
      final sub2 = model
          .generateContentStream(<Content>[Content.text('flowing-stream')])
          .listen((r) => out2.add(r.text), onDone: done2.complete);

      await until(() => fakeBridge.ofType('worker-sub').length == 2);
      final ids = <String, String>{
        for (final frame in fakeBridge.ofType('worker-sub'))
          _promptTextFromSubFrame(frame): frame['subId'] as String,
      };

      sub1.pause();
      await settle();

      fakeBridge.current.deliver(_textChunkSnap(ids['paused-stream']!, 'P1-'));
      fakeBridge.current.deliver(_textChunkSnap(ids['paused-stream']!, 'P2'));
      fakeBridge.current.deliver(_doneSnap(ids['paused-stream']!));

      fakeBridge.current.deliver(_textChunkSnap(ids['flowing-stream']!, 'F1-'));
      fakeBridge.current.deliver(_textChunkSnap(ids['flowing-stream']!, 'F2'));
      fakeBridge.current.deliver(_doneSnap(ids['flowing-stream']!));

      await done2.future;
      expect(out2, equals(<String?>['F1-', 'F2']));
      expect(out1, isEmpty);

      sub1.resume();
      await done1.future;
      expect(out1, equals(<String?>['P1-', 'P2']));

      await sub1.cancel();
      await sub2.cancel();
    });

    test('unlistened ChatSession.sendMessageStream does not deadlock subsequent chat turns', () async {
      fakeBridge.onFrame = (frame) {
        if (frame['type'] == 'worker-op') {
          final op = frame['op'] as Map<String, dynamic>;
          if (op['method'] == 'ai.generateContent') {
            scheduleMicrotask(() {
              fakeBridge.current.deliver(<String, dynamic>{
                'type': 'worker-res',
                'id': frame['id'],
                'ok': true,
                'value': <String, dynamic>{
                  'candidates': <Map<String, dynamic>>[
                    <String, dynamic>{
                      'index': 0,
                      'finishReason': 'STOP',
                      'content': <String, dynamic>{
                        'role': 'model',
                        'parts': <Map<String, dynamic>>[
                          <String, dynamic>{'text': 'unary-reply'},
                        ],
                      },
                    },
                  ],
                },
              });
            });
          }
        }
      };

      final chat = model.startChat();
      // Create a stream without ever calling .listen(...) on it.
      final _ = chat.sendMessageStream(Content.text('never-listened'));

      final unaryRes = await chat.sendMessage(Content.text('active-turn-1'));
      expect(unaryRes.text, equals('unary-reply'));
      expect(chat.history, hasLength(2));
    });

    test('concurrent ChatSession turns serialize in FIFO order and skip cancelled queued stream', () async {
      fakeBridge.onFrame = (frame) {
        if (frame['type'] == 'worker-op') {
          final op = frame['op'] as Map<String, dynamic>;
          if (op['method'] == 'ai.generateContent') {
            final req = op['request'] as Map<String, dynamic>;
            final contents = req['contents'] as List<dynamic>;
            scheduleMicrotask(() {
              fakeBridge.current.deliver(<String, dynamic>{
                'type': 'worker-res',
                'id': frame['id'],
                'ok': true,
                'value': <String, dynamic>{
                  'candidates': <Map<String, dynamic>>[
                    <String, dynamic>{
                      'index': 0,
                      'finishReason': 'STOP',
                      'content': <String, dynamic>{
                        'role': 'model',
                        'parts': <Map<String, dynamic>>[
                          <String, dynamic>{'text': 'turn3-saw-${contents.length}-turns'},
                        ],
                      },
                    },
                  ],
                },
              });
            });
          }
        }
      };

      final chat = model.startChat();
      final turn1Chunks = <String?>[];
      final turn1Done = Completer<void>();

      final sub1 = chat
          .sendMessageStream(Content.text('turn-1'))
          .listen((r) => turn1Chunks.add(r.text), onDone: turn1Done.complete);
      final sub2 = chat
          .sendMessageStream(Content.text('turn-2-cancelled-while-queued'))
          .listen((_) {});
      final turn3Future = chat.sendMessage(Content.text('turn-3'));

      await until(() => fakeBridge.ofType('worker-sub').length == 1);
      // Cancel turn 2 while turn 1 is still active on the wire.
      await sub2.cancel();

      final sub1Id = fakeBridge.ofType('worker-sub').single['subId'] as String;
      fakeBridge.current.deliver(_textChunkSnap(sub1Id, 'model-1'));
      fakeBridge.current.deliver(_doneSnap(sub1Id));

      await turn1Done.future;
      final turn3Res = await turn3Future;

      expect(fakeBridge.ofType('worker-sub'), hasLength(1));
      expect(turn1Chunks, equals(<String?>['model-1']));
      // Turn 3 must see [turn-1 user, model-1, turn-3 user] = 3 turns (turn 2 skipped).
      expect(turn3Res.text, equals('turn3-saw-3-turns'));
      expect(chat.history, hasLength(4));
      await sub1.cancel();
    });

    test('streams multimodal InlineDataPart, skips ThoughtPart in text, and preserves multi-candidate metadata', () async {
      final pngBytes = Uint8List.fromList(<int>[137, 80, 78, 71, 13, 10, 26, 10]);
      final chat = model.startChat();
      final chunks = <GenerateContentResponse>[];
      final done = Completer<void>();

      final sub = chat
          .sendMessageStream(
            Content.multi(<Part>[
              const TextPart('Describe PNG'),
              InlineDataPart('image/png', pngBytes),
            ]),
          )
          .listen(chunks.add, onDone: done.complete);

      await until(() => fakeBridge.ofType('worker-sub').length == 1);
      final subFrame = fakeBridge.ofType('worker-sub').single;
      final subId = subFrame['subId'] as String;
      final sentParts = (((subFrame['sub'] as Map)['request'] as Map)['contents'] as List)
          .single['parts'] as List<dynamic>;
      expect(
        ((sentParts[1] as Map)['inlineData'] as Map)['data'],
        equals('iVBORw0KGgo='),
      );

      fakeBridge.current.deliver(<String, dynamic>{
        'type': 'worker-snap',
        'subId': subId,
        'value': <String, dynamic>{
          'chunk': <String, dynamic>{
            'candidates': <Map<String, dynamic>>[
              <String, dynamic>{
                'index': 0,
                'finishReason': 'STOP',
                'content': <String, dynamic>{
                  'role': 'model',
                  'parts': <Map<String, dynamic>>[
                    <String, dynamic>{
                      'text': 'Inspecting PNG magic header.',
                      'thought': true,
                      'thoughtSignature': 'sig-stream-thought',
                    },
                    <String, dynamic>{'text': 'Valid 8-byte PNG.'},
                    <String, dynamic>{
                      'inlineData': <String, dynamic>{
                        'mimeType': 'image/png',
                        'data': 'iVBORw0KGgo=',
                      },
                    },
                  ],
                },
              },
              <String, dynamic>{
                'index': 1,
                'finishReason': 'STOP',
                'content': <String, dynamic>{
                  'role': 'model',
                  'parts': <Map<String, dynamic>>[
                    <String, dynamic>{'text': 'Alternate candidate text.'},
                  ],
                },
              },
            ],
            'usageMetadata': <String, dynamic>{
              'promptTokenCount': 20,
              'candidatesTokenCount': 12,
              'thoughtsTokenCount': 7,
              'totalTokenCount': 39,
            },
          },
        },
      });
      fakeBridge.current.deliver(_doneSnap(subId));

      await done.future;
      final chunk = chunks.single;
      expect(chunk.text, equals('Valid 8-byte PNG.'));
      expect(chunk.thoughtSummary, equals('Inspecting PNG magic header.'));
      expect(chunk.inlineDataParts.single.bytes, equals(pngBytes));
      expect(chunk.candidates, hasLength(2));
      expect(chunk.candidates[1].text, equals('Alternate candidate text.'));
      expect(chunk.usageMetadata?.promptTokenCount, equals(20));
      expect(chunk.usageMetadata?.candidatesTokenCount, equals(12));
      expect(chunk.usageMetadata?.thoughtsTokenCount, equals(7));
      expect(chunk.usageMetadata?.totalTokenCount, equals(39));

      final historyTurns = chat.history.toList();
      expect(historyTurns, hasLength(2));
      expect(historyTurns[1].parts.whereType<ThoughtPart>().single.thoughtSignature, equals('sig-stream-thought'));
      expect(historyTurns[1].parts.whereType<InlineDataPart>().single.bytes, equals(pngBytes));
      await sub.cancel();
    });

    test('maps streaming __error statuses across all TASK.md canonical error codes', () async {
      const cases = <({String wireCode, String expectedCode, int expectedHttp, Type expectedType})>[
        (
          wireCode: 'ai/INVALID_ARGUMENT',
          expectedCode: 'invalid-argument',
          expectedHttp: 400,
          expectedType: FirebaseAIException,
        ),
        (
          wireCode: 'ai/PERMISSION_DENIED',
          expectedCode: 'permission-denied',
          expectedHttp: 403,
          expectedType: FirebaseAIException,
        ),
        (
          wireCode: 'ai/UNAUTHENTICATED',
          expectedCode: 'unauthenticated',
          expectedHttp: 401,
          expectedType: FirebaseAIException,
        ),
        (
          wireCode: 'ai/RESOURCE_EXHAUSTED',
          expectedCode: 'quota-exceeded',
          expectedHttp: 429,
          expectedType: QuotaExceeded,
        ),
        (
          wireCode: 'ai/UNAVAILABLE',
          expectedCode: 'unavailable',
          expectedHttp: 503,
          expectedType: ServerException,
        ),
      ];

      for (var i = 0; i < cases.length; i++) {
        final tc = cases[i];
        Object? caught;
        final done = Completer<void>();
        final sub = model
            .generateContentStream(<Content>[Content.text('err-case-$i')])
            .listen(
              (_) {},
              onError: (Object err) => caught = err,
              onDone: done.complete,
            );

        await until(() => fakeBridge.ofType('worker-sub').length == i + 1);
        final subId = fakeBridge.ofType('worker-sub').last['subId'] as String;

        fakeBridge.current.deliver(<String, dynamic>{
          'type': 'worker-snap',
          'subId': subId,
          'value': <String, dynamic>{
            '__error': <String, dynamic>{
              'code': tc.wireCode,
              'message': 'Failure for ${tc.wireCode}',
            },
          },
        });

        await done.future;
        expect(caught, isA<FirebaseAIException>());
        final aiErr = caught as FirebaseAIException;
        expect(aiErr.runtimeType, equals(tc.expectedType));
        expect(aiErr.code, equals(tc.expectedCode));
        expect(aiErr.httpStatusCode, equals(tc.expectedHttp));
        expect(aiErr.wireEnvelope?['error'], isA<Map<String, dynamic>>());
        await until(() => fakeBridge.ofType('worker-unsub').length == i + 1);
        await sub.cancel();
      }
    });
  });
}
