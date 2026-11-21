import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_ai.dart';

import '../helpers/fake_bridge.dart';

void main() {
  late FakeBridge fakeBridge;
  late PyricBridgeClient bridgeClient;

  setUp(() async {
    await FirebaseAI.clearInstancesForTest();
    fakeBridge = FakeBridge();
    bridgeClient = PyricBridgeClient(channelFactory: fakeBridge.connect);
  });

  tearDown(() async {
    await FirebaseAI.clearInstancesForTest();
    await bridgeClient.disconnect();
  });

  group('Multimodal InlineDataPart and code-execution part round-trips', () {
    test('round-trips full 0..255 binary spectrum and multi-part media over FakeBridge', () async {
      final fullSpectrum = Uint8List.fromList(
        List<int>.generate(256, (index) => index),
      );
      final pcmClip = Uint8List.fromList(<int>[0, 127, 255, 64, 32, 16, 8, 1]);

      Map<String, dynamic>? capturedRequest;
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') {
          return;
        }
        final op = frame['op'] as Map<String, dynamic>;
        if (op['method'] == 'ai.generateContent') {
          capturedRequest = Map<String, dynamic>.from(op['request'] as Map);
          final id = frame['id'] as String;
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
                        <String, dynamic>{
                          'inlineData': <String, dynamic>{
                            'mimeType': 'image/webp',
                            'data': base64Encode(fullSpectrum),
                            'willContinue': false,
                          },
                          'thoughtSignature': 'sig-media-out',
                        },
                        <String, dynamic>{
                          'inlineData': <String, dynamic>{
                            'mimeType': 'audio/pcm',
                            'data': base64Encode(pcmClip),
                          },
                        },
                        <String, dynamic>{
                          'text': 'Processed two media attachments.',
                        },
                      ],
                    },
                  },
                ],
              },
            });
          });
        }
      };

      final model = FirebaseAI.googleAI(bridgeClient: bridgeClient)
          .generativeModel(model: 'gemini-2.5-flash');

      final response = await model.generateContent(<Content>[
        Content.multi(<Part>[
          const TextPart('Compare this frame and audio sample:'),
          InlineDataPart('image/png', fullSpectrum, willContinue: true),
          InlineDataPart('audio/pcm', pcmClip),
          const FileData('video/mp4', 'gs://demo-bucket/clip.mp4'),
        ]),
      ]);

      expect(capturedRequest, isNotNull);
      final sentParts = ((capturedRequest!['contents'] as List).single
          as Map<String, dynamic>)['parts'] as List;
      expect(sentParts, hasLength(4));
      final sentImageInline =
          (sentParts[1] as Map<String, dynamic>)['inlineData']
              as Map<String, dynamic>;
      expect(sentImageInline['mimeType'], equals('image/png'));
      expect(sentImageInline['willContinue'], isTrue);
      expect(base64Decode(sentImageInline['data'] as String), equals(fullSpectrum));

      expect(response.text, equals('Processed two media attachments.'));
      final inlineOutputs = response.inlineDataParts.toList();
      expect(inlineOutputs, hasLength(2));
      expect(inlineOutputs[0].mimeType, equals('image/webp'));
      expect(inlineOutputs[0].bytes, equals(fullSpectrum));
      expect(inlineOutputs[0].willContinue, isFalse);
      expect(inlineOutputs[0].thoughtSignature, equals('sig-media-out'));
      expect(inlineOutputs[1].mimeType, equals('audio/pcm'));
      expect(inlineOutputs[1].bytes, equals(pcmClip));
    });

    test('defensively copies InlineDataPart bytes and prevents post-construction mutation', () {
      final source = Uint8List.fromList(<int>[10, 20, 30, 40]);
      final part = InlineDataPart('application/octet-stream', source);

      // Mutating caller's source buffer must not mutate InlineDataPart.bytes.
      source[0] = 99;
      expect(part.bytes, equals(<int>[10, 20, 30, 40]));
      expect(
        base64Decode((part.toJson()['inlineData'] as Map)['data'] as String),
        equals(<int>[10, 20, 30, 40]),
      );

      // Mutating InlineDataPart.bytes view directly throws UnsupportedError.
      expect(() => part.bytes[1] = 77, throwsUnsupportedError);
    });

    test('decodes URL-safe, unpadded, whitespace-wrapped, and empty base64 payloads', () {
      // Bytes [251, 239, 255] encode to standard '+//+' and URL-safe '-__-'.
      final trickyBytes = Uint8List.fromList(<int>[251, 239, 255, 254]);
      final urlSafeUnpadded =
          base64UrlEncode(trickyBytes).replaceAll('=', '');
      final decodedUrlSafe = decodeWirePart(<String, dynamic>{
        'inlineData': <String, dynamic>{
          'mimeType': 'image/jpeg',
          'data': urlSafeUnpadded,
        },
      }) as InlineDataPart;
      expect(decodedUrlSafe.bytes, equals(trickyBytes));

      final wrappedMime = '${base64Encode(trickyBytes).substring(0, 4)}\r\n'
          '${base64Encode(trickyBytes).substring(4)}\n';
      final decodedWrapped = decodeWirePart(<String, dynamic>{
        'inlineData': <String, dynamic>{
          'mimeType': 'image/jpeg',
          'data': wrappedMime,
        },
      }) as InlineDataPart;
      expect(decodedWrapped.bytes, equals(trickyBytes));

      final decodedEmpty = decodeWirePart(<String, dynamic>{
        'inlineData': <String, dynamic>{
          'mimeType': 'application/octet-stream',
          'data': '   ',
        },
      }) as InlineDataPart;
      expect(decodedEmpty.bytes, isEmpty);

      expect(
        () => decodeWirePart(<String, dynamic>{
          'inlineData': <String, dynamic>{
            'mimeType': 'image/png',
            'data': 12345,
          },
        }),
        throwsA(isA<SerializationException>()),
      );
    });

    test('round-trips ExecutableCodePart and CodeExecutionResultPart on wire', () {
      final rawContent = <String, dynamic>{
        'role': 'model',
        'parts': <Map<String, dynamic>>[
          <String, dynamic>{
            'executableCode': <String, dynamic>{
              'language': 'PYTHON',
              'code': 'print(6 * 7)',
            },
            'thoughtSignature': 'sig-exec-1',
          },
          <String, dynamic>{
            'codeExecutionResult': <String, dynamic>{
              'outcome': 'OUTCOME_OK',
              'output': '42\n',
            },
          },
        ],
      };

      final content = decodeWireContent(rawContent);
      expect(content.parts, hasLength(2));
      final execPart = content.parts[0] as ExecutableCodePart;
      expect(execPart.language, equals(CodeExecutionLanguage.python));
      expect(execPart.code, equals('print(6 * 7)'));
      expect(execPart.thoughtSignature, equals('sig-exec-1'));

      final resPart = content.parts[1] as CodeExecutionResultPart;
      expect(resPart.outcome, equals(CodeExecutionOutcome.ok));
      expect(resPart.output, equals('42\n'));

      expect(content.toJson(), equals(rawContent));
    });
  });

  group('ThoughtPart filtering, candidateCount > 1, and UsageMetadata breakdown', () {
    test('filters ThoughtPart across thought-only, interleaved, and signature-only turns', () {
      // Thought-only response: text must be null while thoughtSummary concatenates thoughts.
      final thoughtOnly = decodeGenerateContentResponse(<String, dynamic>{
        'candidates': <Map<String, dynamic>>[
          <String, dynamic>{
            'index': 0,
            'finishReason': 'STOP',
            'content': <String, dynamic>{
              'role': 'model',
              'parts': <Map<String, dynamic>>[
                <String, dynamic>{'text': 'Step 1: analyze. ', 'thought': true},
                <String, dynamic>{'text': 'Step 2: verify.', 'thought': true},
              ],
            },
          },
        ],
      });
      expect(thoughtOnly.text, isNull);
      expect(
        thoughtOnly.thoughtSummary,
        equals('Step 1: analyze. Step 2: verify.'),
      );

      // Interleaved thought + text + signature-only thought parts.
      final interleaved = decodeGenerateContentResponse(<String, dynamic>{
        'candidates': <Map<String, dynamic>>[
          <String, dynamic>{
            'index': 0,
            'finishReason': 'STOP',
            'content': <String, dynamic>{
              'role': 'model',
              'parts': <Map<String, dynamic>>[
                <String, dynamic>{'text': 'Drafting intro. ', 'thought': true},
                <String, dynamic>{'text': 'Final answer: '},
                <String, dynamic>{
                  'thought': true,
                  'thoughtSignature': 'sig-empty-thought',
                },
                <String, dynamic>{'text': 'Checking math. ', 'thought': true},
                <String, dynamic>{'text': '42.'},
              ],
            },
          },
        ],
      });
      expect(interleaved.text, equals('Final answer: 42.'));
      expect(
        interleaved.thoughtSummary,
        equals('Drafting intro. Checking math. '),
      );
    });

    test('orders candidateCount > 1 by wire index and exposes per-candidate helpers', () async {
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') {
          return;
        }
        final op = frame['op'] as Map<String, dynamic>;
        if (op['method'] == 'ai.generateContent') {
          final id = frame['id'] as String;
          scheduleMicrotask(() {
            // Deliver candidates intentionally out of wire index order (2, 0, 1).
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': <String, dynamic>{
                'candidates': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'index': 2,
                    'finishReason': 'SAFETY',
                    'content': <String, dynamic>{
                      'role': 'model',
                      'parts': <Map<String, dynamic>>[
                        <String, dynamic>{'text': 'Withheld third candidate'},
                      ],
                    },
                  },
                  <String, dynamic>{
                    'index': 0,
                    'finishReason': 'STOP',
                    'content': <String, dynamic>{
                      'role': 'model',
                      'parts': <Map<String, dynamic>>[
                        <String, dynamic>{'text': 'Plan A', 'thought': true},
                        <String, dynamic>{'text': 'Primary candidate answer'},
                      ],
                    },
                  },
                  <String, dynamic>{
                    'index': 1,
                    'finishReason': 'STOP',
                    'content': <String, dynamic>{
                      'role': 'model',
                      'parts': <Map<String, dynamic>>[
                        <String, dynamic>{'text': 'Plan B', 'thought': true},
                        <String, dynamic>{'text': 'Secondary candidate answer'},
                        <String, dynamic>{
                          'functionCall': <String, dynamic>{
                            'name': 'altTool',
                            'args': <String, dynamic>{'k': 1},
                          },
                          'thoughtSignature': 'sig-alt',
                        },
                      ],
                    },
                  },
                ],
              },
            });
          });
        }
      };

      final model = FirebaseAI.googleAI(bridgeClient: bridgeClient)
          .generativeModel(
        model: 'gemini-2.5-flash',
        generationConfig: GenerationConfig(candidateCount: 3),
      );

      final response = await model.generateContent(
        <Content>[Content.text('Generate 3 candidates')],
      );

      expect(response.candidates, hasLength(3));
      expect(
        response.candidates.map((c) => c.index).toList(),
        equals(<int?>[0, 1, 2]),
      );

      // Primary response getters read candidate index 0.
      expect(response.text, equals('Primary candidate answer'));
      expect(response.thoughtSummary, equals('Plan A'));
      expect(response.functionCalls, isEmpty);

      // Candidate 1 preserves its own text, thoughtSummary, and functionCalls.
      expect(response.candidates[1].text, equals('Secondary candidate answer'));
      expect(response.candidates[1].thoughtSummary, equals('Plan B'));
      expect(response.candidates[1].functionCalls.single.name, equals('altTool'));

      // Candidate 2 was SAFETY-blocked, so its helpers return null / empty.
      expect(response.candidates[2].finishReason, equals(FinishReason.safety));
      expect(response.candidates[2].text, isNull);
      expect(response.candidates[2].thoughtSummary, isNull);
      expect(response.candidates[2].functionCalls, isEmpty);
      expect(response.candidates[2].inlineDataParts, isEmpty);
    });

    test('decodes full UsageMetadata multimodal token breakdown', () {
      final response = decodeGenerateContentResponse(<String, dynamic>{
        'candidates': <Map<String, dynamic>>[
          <String, dynamic>{
            'index': 0,
            'finishReason': 'STOP',
            'content': <String, dynamic>{
              'role': 'model',
              'parts': <Map<String, dynamic>>[
                <String, dynamic>{'text': 'Done'},
              ],
            },
          },
        ],
        'usageMetadata': <String, dynamic>{
          'promptTokenCount': 268,
          'candidatesTokenCount': 42,
          'thoughtsTokenCount': 80,
          'cachedContentTokenCount': 100,
          'toolUsePromptTokenCount': 18,
          'totalTokenCount': 508,
          'serviceTier': 'standard',
          'trafficType': 'ON_DEMAND',
          'promptTokensDetails': <Map<String, dynamic>>[
            <String, dynamic>{'modality': 'TEXT', 'tokenCount': 10},
            <String, dynamic>{'modality': 'IMAGE', 'tokenCount': 258},
          ],
          'candidatesTokensDetails': <Map<String, dynamic>>[
            <String, dynamic>{'modality': 'TEXT', 'tokenCount': 42},
          ],
          'cacheTokensDetails': <Map<String, dynamic>>[
            <String, dynamic>{'modality': 'DOCUMENT', 'tokenCount': 100},
          ],
          'toolUsePromptTokensDetails': <Map<String, dynamic>>[
            <String, dynamic>{'modality': 'TEXT', 'tokenCount': 18},
          ],
        },
      });

      final usage = response.usageMetadata!;
      expect(usage.promptTokenCount, equals(268));
      expect(usage.candidatesTokenCount, equals(42));
      expect(usage.thoughtsTokenCount, equals(80));
      expect(usage.cachedContentTokenCount, equals(100));
      expect(usage.toolUsePromptTokenCount, equals(18));
      expect(usage.totalTokenCount, equals(508));
      expect(usage.serviceTier, equals('standard'));
      expect(usage.trafficType, equals('ON_DEMAND'));
      expect(usage.promptTokensDetails, hasLength(2));
      expect(usage.promptTokensDetails![0].modality, equals(Modality.text));
      expect(usage.promptTokensDetails![1].modality, equals(Modality.image));
      expect(usage.promptTokensDetails![1].tokenCount, equals(258));
      expect(usage.candidatesTokensDetails!.single.tokenCount, equals(42));
      expect(usage.cacheTokensDetails!.single.modality, equals(Modality.document));
      expect(usage.toolUsePromptTokensDetails!.single.tokenCount, equals(18));
    });
  });
}
