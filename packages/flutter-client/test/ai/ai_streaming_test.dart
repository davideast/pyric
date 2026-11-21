import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/src/ai/ai_stream.dart';
import 'package:pyric_firestore/src/transport/bridge_client.dart';

import '../helpers/fake_bridge.dart';

void main() {
  group('streamAiGenerateContent bridge subscription lifecycle', () {
    late FakeBridge fakeBridge;
    late PyricBridgeClient client;

    setUp(() async {
      fakeBridge = FakeBridge();
      client = PyricBridgeClient(
        channelFactory: fakeBridge.connect,
        retryInitialConnection: true,
        reconnectDelay: (_) => const Duration(milliseconds: 10),
      );
      await client.connect();
    });

    tearDown(() async {
      await client.disconnect();
    });

    Map<String, dynamic> sampleSubPayload(String promptText) {
      return <String, dynamic>{
        'target': const <String, dynamic>{
          'service': 'ai',
          'op': 'streamGenerateContent',
        },
        'model': 'models/gemini-2.5-flash',
        'request': <String, dynamic>{
          'contents': <Map<String, dynamic>>[
            <String, dynamic>{
              'role': 'user',
              'parts': <Map<String, dynamic>>[
                <String, dynamic>{'text': promptText},
              ],
            },
          ],
        },
      };
    }

    String extractChunkText(Object? raw) {
      final map = Map<String, dynamic>.from(raw as Map);
      final candidates = map['candidates'] as List<dynamic>;
      final content = (candidates.first as Map)['content'] as Map;
      final parts = content['parts'] as List<dynamic>;
      return (parts.first as Map)['text'] as String;
    }

    test('delivers chunks in order, closes on {done: true}, and detaches sub before reconnect', () async {
      final stream = streamAiGenerateContent<String>(
        bridgeClient: client,
        buildSubPayload: () async => sampleSubPayload('count to three'),
        decodeChunk: extractChunkText,
        mapError: (err) => err,
      );

      final received = <String>[];
      final doneCompleter = Completer<void>();
      final sub = stream.listen(
        received.add,
        onDone: doneCompleter.complete,
      );

      await until(() => fakeBridge.ofType('worker-sub').length == 1);
      final subFrame = fakeBridge.ofType('worker-sub').single;
      final subId = subFrame['subId'] as String;
      final innerSub = subFrame['sub'] as Map<String, dynamic>;
      expect(
        innerSub['target'],
        equals(<String, dynamic>{
          'service': 'ai',
          'op': 'streamGenerateContent',
        }),
      );

      for (final token in <String>['one ', 'two ', 'three']) {
        fakeBridge.current.deliver(<String, dynamic>{
          'type': 'worker-snap',
          'subId': subId,
          'value': <String, dynamic>{
            'chunk': <String, dynamic>{
              'candidates': <Map<String, dynamic>>[
                <String, dynamic>{
                  'index': 0,
                  'content': <String, dynamic>{
                    'role': 'model',
                    'parts': <Map<String, dynamic>>[
                      <String, dynamic>{'text': token},
                    ],
                  },
                },
              ],
            },
          },
        });
      }
      fakeBridge.current.deliver(<String, dynamic>{
        'type': 'worker-snap',
        'subId': subId,
        'value': const <String, dynamic>{'done': true},
      });

      await doneCompleter.future;
      expect(received, equals(<String>['one ', 'two ', 'three']));

      // Verify worker-unsub was sent so _activeSubs removed subId.
      await until(() => fakeBridge.ofType('worker-unsub').length == 1);
      expect(fakeBridge.ofType('worker-unsub').single['subId'], equals(subId));

      // Drop and reconnect the socket: the completed AI stream must NOT replay.
      fakeBridge.current.drop();
      await until(() => fakeBridge.sockets.length == 2 && client.isConnected);
      expect(fakeBridge.ofType('worker-sub'), hasLength(1));

      await sub.cancel();
    });

    test('mid-stream StreamSubscription.cancel() sends worker-unsub and drops subsequent chunks', () async {
      final stream = streamAiGenerateContent<String>(
        bridgeClient: client,
        buildSubPayload: () async => sampleSubPayload('long stream'),
        decodeChunk: extractChunkText,
        mapError: (err) => err,
      );

      final received = <String>[];
      late final StreamSubscription<String> sub;
      final firstChunkSeen = Completer<void>();

      sub = stream.listen((chunk) {
        received.add(chunk);
        if (!firstChunkSeen.isCompleted) {
          firstChunkSeen.complete();
        }
      });

      await until(() => fakeBridge.ofType('worker-sub').length == 1);
      final subId = fakeBridge.ofType('worker-sub').single['subId'] as String;

      fakeBridge.current.deliver(<String, dynamic>{
        'type': 'worker-snap',
        'subId': subId,
        'value': <String, dynamic>{
          'chunk': <String, dynamic>{
            'candidates': <Map<String, dynamic>>[
              <String, dynamic>{
                'index': 0,
                'content': <String, dynamic>{
                  'role': 'model',
                  'parts': <Map<String, dynamic>>[
                    <String, dynamic>{'text': 'first-chunk'},
                  ],
                },
              },
            ],
          },
        },
      });

      await firstChunkSeen.future;
      await sub.cancel();

      await until(() => fakeBridge.ofType('worker-unsub').length == 1);
      expect(fakeBridge.ofType('worker-unsub').single['subId'], equals(subId));

      // Any in-flight chunk arriving after cancel is ignored cleanly.
      fakeBridge.current.deliver(<String, dynamic>{
        'type': 'worker-snap',
        'subId': subId,
        'value': <String, dynamic>{
          'chunk': <String, dynamic>{
            'candidates': <Map<String, dynamic>>[
              <String, dynamic>{
                'index': 0,
                'content': <String, dynamic>{
                  'role': 'model',
                  'parts': <Map<String, dynamic>>[
                    <String, dynamic>{'text': 'late-chunk'},
                  ],
                },
              },
            ],
          },
        },
      });
      await settle();
      expect(received, equals(<String>['first-chunk']));
    });

    test('propagates __error snapshot through mapError and closes stream cleanly', () async {
      final stream = streamAiGenerateContent<String>(
        bridgeClient: client,
        buildSubPayload: () async => sampleSubPayload('bad request'),
        decodeChunk: extractChunkText,
        mapError: (err) {
          if (err is PyricBridgeException) {
            return StateError('mapped:${err.code}:${err.message}');
          }
          return err;
        },
      );

      Object? caughtError;
      final doneCompleter = Completer<void>();
      stream.listen(
        (_) {},
        onError: (Object err) {
          caughtError = err;
        },
        onDone: doneCompleter.complete,
      );

      await until(() => fakeBridge.ofType('worker-sub').length == 1);
      final subId = fakeBridge.ofType('worker-sub').single['subId'] as String;

      fakeBridge.current.deliver(<String, dynamic>{
        'type': 'worker-snap',
        'subId': subId,
        'value': <String, dynamic>{
          '__error': <String, dynamic>{
            'code': 'ai/UNAUTHENTICATED',
            'message': 'Firebase App Check token is invalid.',
          },
        },
      });

      await doneCompleter.future;
      expect(caughtError, isA<StateError>());
      expect(
        caughtError.toString(),
        contains('mapped:ai/UNAUTHENTICATED:Firebase App Check token is invalid.'),
      );
    });

    test('cancelling before async payload preparation resolves sends zero worker-sub frames', () async {
      final gate = Completer<Map<String, dynamic>>();
      final stream = streamAiGenerateContent<String>(
        bridgeClient: client,
        buildSubPayload: () => gate.future,
        decodeChunk: extractChunkText,
        mapError: (err) => err,
      );

      final sub = stream.listen((_) {});
      await settle();
      await sub.cancel();

      gate.complete(sampleSubPayload('never sent'));
      await settle();
      expect(fakeBridge.ofType('worker-sub'), isEmpty);
    });
  });
}
