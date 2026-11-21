import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_ai.dart';

import '../helpers/fake_bridge.dart';

void main() {
  group('GenerativeModel.generateContentStream & ChatSession', () {
    late FakeBridge fakeBridge;
    late PyricBridgeClient client;

    setUp(() async {
      await FirebaseAI.clearInstancesForTest();
      fakeBridge = FakeBridge();
      client = PyricBridgeClient(
        channelFactory: fakeBridge.connect,
        retryInitialConnection: true,
        reconnectDelay: (_) => const Duration(milliseconds: 10),
      );
      await client.connect();
    });

    tearDown(() async {
      await FirebaseAI.clearInstancesForTest();
      await client.disconnect();
    });

    test('GenerativeModel.generateContentStream streams decoded chunks and enforces App Check wire claim', () async {
      final ai = FirebaseAI.vertexAI(
        location: 'europe-west4',
        bridgeClient: client,
      );
      final model = ai.generativeModel(
        model: 'gemini-2.5-flash',
        systemInstruction: Content.system('Answer concisely.'),
        generationConfig: GenerationConfig(
          responseMimeType: 'application/json',
          responseSchema: Schema.object(
            properties: <String, Schema>{
              'city': Schema.string(),
              'tempC': Schema.number(),
            },
            propertyOrdering: <String>['city', 'tempC'],
          ),
        ),
      );

      final receivedTexts = <String?>[];
      final done = Completer<void>();
      final sub = model
          .generateContentStream(<Content>[Content.text('Tokyo weather JSON')])
          .listen(
            (chunk) => receivedTexts.add(chunk.text),
            onDone: done.complete,
          );

      await until(() => fakeBridge.ofType('worker-sub').length == 1);
      final subFrame = fakeBridge.ofType('worker-sub').single;
      final subId = subFrame['subId'] as String;
      final subBody = subFrame['sub'] as Map<String, dynamic>;
      expect(
        subBody['model'],
        equals('publishers/google/models/gemini-2.5-flash'),
      );
      final reqJson = subBody['request'] as Map<String, dynamic>;
      expect(
        (reqJson['generationConfig'] as Map)['responseSchema'],
        equals(<String, dynamic>{
          'type': 'object',
          'properties': <String, dynamic>{
            'city': <String, dynamic>{'type': 'string'},
            'tempC': <String, dynamic>{'type': 'number'},
          },
          'required': <String>['city', 'tempC'],
          'propertyOrdering': <String>['city', 'tempC'],
        }),
      );

      for (final chunkStr in <String>['{"city":"Tok', 'yo","tempC":21.5}']) {
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
                      <String, dynamic>{'text': chunkStr},
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

      await done.future;
      expect(
        receivedTexts,
        equals(<String?>['{"city":"Tok', 'yo","tempC":21.5}']),
      );
      await sub.cancel();
    });

    test('ChatSession.sendMessage preserves history, rolls back blocked/failed turns, and threads FunctionCall thoughtSignature', () async {
      var callIndex = 0;
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') {
          return;
        }
        final op = frame['op'] as Map<String, dynamic>;
        if (op['method'] != 'ai.generateContent') {
          return;
        }
        final id = frame['id'] as String;
        final currentCall = callIndex++;
        scheduleMicrotask(() {
          if (currentCall == 0) {
            // Turn 0: emit a signed FunctionCall
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
                        <String, dynamic>{
                          'functionCall': <String, dynamic>{
                            'id': 'fc-weather-1',
                            'name': 'get_weather',
                            'args': <String, dynamic>{'city': 'Kyoto'},
                          },
                          'thoughtSignature': 'sig-kyoto-48chars',
                        },
                      ],
                    },
                  },
                ],
              },
            });
          } else if (currentCall == 1) {
            // Turn 1: verify prior model turn carried thoughtSignature and functionResponse used role 'user'
            final req = op['request'] as Map<String, dynamic>;
            final contents = req['contents'] as List<dynamic>;
            expect(contents, hasLength(3));
            final modelTurn = contents[1] as Map<String, dynamic>;
            final modelPart = (modelTurn['parts'] as List).single as Map<String, dynamic>;
            expect(modelPart['thoughtSignature'], equals('sig-kyoto-48chars'));
            final fnRespTurn = contents[2] as Map<String, dynamic>;
            expect(fnRespTurn['role'], equals('user'));

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
                        <String, dynamic>{
                          'text': 'It is 19C and sunny in Kyoto.',
                          'thoughtSignature': 'sig-final-answer',
                        },
                      ],
                    },
                  },
                ],
              },
            });
          } else if (currentCall == 2) {
            // Turn 2: blocked response (FinishReason.safety) -> must NOT enter history
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': <String, dynamic>{
                'candidates': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'index': 0,
                    'finishReason': 'SAFETY',
                    'content': <String, dynamic>{
                      'role': 'model',
                      'parts': const <Map<String, dynamic>>[],
                    },
                  },
                ],
              },
            });
          } else {
            // Turn 3: wire failure -> must NOT enter history or poison queue
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': id,
              'ok': false,
              'error': <String, dynamic>{
                'code': 'ai/RESOURCE_EXHAUSTED',
                'message': 'Quota exceeded for metric.',
              },
            });
          }
        });
      };

      final ai = FirebaseAI.googleAI(bridgeClient: client);
      final model = ai.generativeModel(
        model: 'gemini-2.5-flash',
        tools: <Tool>[
          Tool.functionDeclarations(<FunctionDeclaration>[
            FunctionDeclaration(
              'get_weather',
              'Look up city weather',
              parameters: <String, Schema>{
                'city': Schema.string(),
              },
            ),
          ]),
        ],
        toolConfig: ToolConfig(
          functionCallingConfig: FunctionCallingConfig.any(<String>['get_weather']),
        ),
      );

      final chat = model.startChat();
      expect(chat.history, isEmpty);

      final firstRes = await chat.sendMessage(
        Content.text('What is the weather in Kyoto?'),
      );
      expect(firstRes.functionCalls, hasLength(1));
      final fnCall = firstRes.functionCalls.first;
      expect(fnCall.name, equals('get_weather'));
      expect(fnCall.args, equals(<String, Object?>{'city': 'Kyoto'}));
      expect(fnCall.thoughtSignature, equals('sig-kyoto-48chars'));
      expect(chat.history, hasLength(2));

      final secondRes = await chat.sendMessage(
        Content.functionResponse(
          fnCall.name,
          <String, Object?>{'tempC': 19, 'condition': 'Sunny'},
          id: fnCall.id,
        ),
      );
      expect(secondRes.text, equals('It is 19C and sunny in Kyoto.'));
      expect(chat.history, hasLength(4));

      // Blocked turn leaves history at 4 items
      final blockedRes = await chat.sendMessage(Content.text('Blocked prompt'));
      expect(blockedRes.candidates.first.finishReason, equals(FinishReason.safety));
      expect(blockedRes.text, isNull);
      expect(chat.history, hasLength(4));

      // Failed turn throws QuotaExceeded and leaves history at 4 items
      await expectLater(
        () => chat.sendMessage(Content.text('Over-quota prompt')),
        throwsA(
          isA<QuotaExceeded>().having(
            (e) => e.code,
            'code',
            equals('quota-exceeded'),
          ),
        ),
      );
      expect(chat.history, hasLength(4));
    });

    test('ChatSession.sendMessageStream aggregates chunks into history and excludes cancelled/errored/blocked streams', () async {
      var streamIndex = 0;
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-sub') {
          return;
        }
        final subId = frame['subId'] as String;
        final currentStream = streamIndex++;
        scheduleMicrotask(() {
          if (currentStream == 0) {
            // Stream 0: 2 text chunks -> aggregated into single model turn
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
                          <String, dynamic>{'text': 'Hello '},
                        ],
                      },
                    },
                  ],
                },
              },
            });
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
                            'text': 'stream world!',
                            'thoughtSignature': 'sig-stream-0',
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            });
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-snap',
              'subId': subId,
              'value': const <String, dynamic>{'done': true},
            });
          } else if (currentStream == 1) {
            // Stream 1: consumer will cancel after first chunk -> excluded from history
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
                          <String, dynamic>{'text': 'Partial...'},
                        ],
                      },
                    },
                  ],
                },
              },
            });
          } else if (currentStream == 2) {
            // Stream 2: finishes with RECITATION block -> excluded from history
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-snap',
              'subId': subId,
              'value': <String, dynamic>{
                'chunk': <String, dynamic>{
                  'candidates': <Map<String, dynamic>>[
                    <String, dynamic>{
                      'index': 0,
                      'finishReason': 'RECITATION',
                      'content': <String, dynamic>{
                        'role': 'model',
                        'parts': const <Map<String, dynamic>>[],
                      },
                    },
                  ],
                },
              },
            });
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-snap',
              'subId': subId,
              'value': const <String, dynamic>{'done': true},
            });
          } else {
            // Stream 3: mid-stream __error -> excluded from history
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-snap',
              'subId': subId,
              'value': <String, dynamic>{
                '__error': <String, dynamic>{
                  'code': 'ai/INVALID_ARGUMENT',
                  'message': 'Bad stream request.',
                },
              },
            });
          }
        });
      };

      final chat = FirebaseAI.googleAI(bridgeClient: client)
          .generativeModel(model: 'gemini-2.5-flash')
          .startChat();

      // Stream 0 succeeds
      final chunks0 = await chat
          .sendMessageStream(Content.text('Greet me'))
          .map((c) => c.text)
          .toList();
      expect(chunks0, equals(<String?>['Hello ', 'stream world!']));
      final historyAfter0 = chat.history.toList();
      expect(historyAfter0, hasLength(2));
      final aggregatedPart = historyAfter0[1].parts.single as TextPart;
      expect(aggregatedPart.text, equals('Hello stream world!'));
      expect(aggregatedPart.thoughtSignature, equals('sig-stream-0'));

      // Stream 1 cancelled mid-stream -> sends worker-unsub and leaves history at 2
      final firstSeen = Completer<void>();
      late final StreamSubscription<GenerateContentResponse> sub1;
      sub1 = chat.sendMessageStream(Content.text('Cancel me')).listen((_) {
        if (!firstSeen.isCompleted) {
          firstSeen.complete();
        }
      });
      await firstSeen.future;
      await sub1.cancel();
      expect(chat.history, hasLength(2));

      // Stream 2 blocked with RECITATION -> leaves history at 2
      final chunks2 =
          await chat.sendMessageStream(Content.text('Recite copyrighted')).toList();
      expect(chunks2.single.candidates.first.finishReason, equals(FinishReason.recitation));
      expect(chat.history, hasLength(2));

      // Stream 3 errors -> throws FirebaseAIException and leaves history at 2
      await expectLater(
        chat.sendMessageStream(Content.text('Trigger error')).toList(),
        throwsA(
          isA<FirebaseAIException>().having(
            (e) => e.code,
            'code',
            equals('invalid-argument'),
          ),
        ),
      );
      expect(chat.history, hasLength(2));
    });

    test('defensively clones initial history, serializes pipelined turns in FIFO order, and excludes PromptFeedback blocks', () async {
      final initialTurns = <Content>[
        Content.text('Seed user turn'),
        Content.model(<Part>[const TextPart('Seed model reply', thoughtSignature: 'sig-seed')]),
      ];

      final recordedContentsCounts = <int>[];
      var callSeq = 0;
      fakeBridge.onFrame = (frame) {
        if (frame['type'] == 'worker-sub') {
          final subId = frame['subId'] as String;
          final sub = frame['sub'] as Map<String, dynamic>;
          final req = sub['request'] as Map<String, dynamic>;
          recordedContentsCounts.add((req['contents'] as List).length);
          Future<void>.delayed(const Duration(milliseconds: 15), () {
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
                            'functionCall': <String, dynamic>{
                              'id': 'fc-stream-1',
                              'name': 'lookup_ticket',
                              'args': <String, dynamic>{'id': 42},
                            },
                            'thoughtSignature': 'sig-stream-fc-42',
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            });
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-snap',
              'subId': subId,
              'value': const <String, dynamic>{'done': true},
            });
          });
        } else if (frame['type'] == 'worker-op') {
          final op = frame['op'] as Map<String, dynamic>;
          if (op['method'] != 'ai.generateContent') {
            return;
          }
          final id = frame['id'] as String;
          final req = op['request'] as Map<String, dynamic>;
          recordedContentsCounts.add((req['contents'] as List).length);
          final idx = callSeq++;
          scheduleMicrotask(() {
            if (idx == 0) {
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
                          <String, dynamic>{
                            'text': 'Ticket 42 is resolved.',
                            'thoughtSignature': 'sig-ticket-done',
                          },
                        ],
                      },
                    },
                  ],
                },
              });
            } else {
              // Prompt-level block with empty candidates
              fakeBridge.current.deliver(<String, dynamic>{
                'type': 'worker-res',
                'id': id,
                'ok': true,
                'value': <String, dynamic>{
                  'promptFeedback': <String, dynamic>{
                    'blockReason': 'PROHIBITED_CONTENT',
                    'safetyRatings': const <Map<String, dynamic>>[],
                  },
                },
              });
            }
          });
        }
      };

      final chat = FirebaseAI.googleAI(bridgeClient: client)
          .generativeModel(model: 'gemini-2.5-flash')
          .startChat(history: initialTurns);

      // Mutating caller's initial list or returned history view must not mutate session state.
      initialTurns.clear();
      expect(chat.history, hasLength(2));

      // Pipeline sendMessageStream followed immediately by sendMessage(functionResponses)
      final streamTurn = chat.sendMessageStream(Content.text('Check ticket 42'));
      final unaryTurnFuture = chat.sendMessage(
        Content.functionResponses(<FunctionResponse>[
          FunctionResponse('lookup_ticket', <String, Object?>{'status': 'resolved'}, id: 'fc-stream-1'),
        ]),
      );

      final streamedChunks = await streamTurn.toList();
      expect(streamedChunks.single.functionCalls.single.name, equals('lookup_ticket'));

      final unaryRes = await unaryTurnFuture;
      expect(unaryRes.text, equals('Ticket 42 is resolved.'));
      // Stream saw 3 turns (2 seed + 1 new); pipelined unary waited and saw 5 turns (4 committed + 1 new).
      expect(recordedContentsCounts, equals(<int>[3, 5]));
      expect(chat.history, hasLength(6));

      // PromptFeedback block leaves history unchanged at 6 turns.
      final promptBlocked = await chat.sendMessage(Content.text('Prohibited prompt'));
      expect(promptBlocked.promptFeedback?.blockReason, equals(BlockReason.prohibitedContent));
      expect(chat.history, hasLength(6));
    });
  });
}
