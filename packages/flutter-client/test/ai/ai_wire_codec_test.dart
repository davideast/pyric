import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_flutter_client.dart';

void main() {
  group('Content and Part wire codec', () {
    test('serializes Content factory constructors to Gemini wire JSON', () {
      final pngBytes = Uint8List.fromList(<int>[137, 80, 78, 71, 13, 10]);

      final textTurn = Content.text('Summarize this image.');
      expect(
        textTurn.toJson(),
        equals(<String, dynamic>{
          'role': 'user',
          'parts': <Map<String, dynamic>>[
            <String, dynamic>{'text': 'Summarize this image.'},
          ],
        }),
      );

      final multiTurn = Content.multi(<Part>[
        const TextPart('Inspect image:'),
        InlineDataPart('image/png', pngBytes),
        const FileData('application/pdf', 'gs://demo-bucket/spec.pdf'),
      ]);
      expect(multiTurn.role, equals('user'));
      expect(multiTurn.parts, hasLength(3));
      expect(
        multiTurn.toJson()['parts'],
        equals(<Map<String, dynamic>>[
          <String, dynamic>{'text': 'Inspect image:'},
          <String, dynamic>{
            'inlineData': <String, dynamic>{
              'mimeType': 'image/png',
              'data': base64Encode(pngBytes),
            },
          },
          <String, dynamic>{
            'fileData': <String, dynamic>{
              'mimeType': 'application/pdf',
              'fileUri': 'gs://demo-bucket/spec.pdf',
            },
          },
        ]),
      );

      final systemTurn = Content.system('Answer tersely in JSON.');
      expect(systemTurn.role, equals('system'));

      final singleFnResp = Content.functionResponse(
        'lookupWeather',
        <String, Object?>{'tempC': 21, 'condition': 'Sunny'},
        id: 'call-1',
      );
      expect(singleFnResp.role, equals('user'));
      expect(
        singleFnResp.toJson(),
        equals(<String, dynamic>{
          'role': 'user',
          'parts': <Map<String, dynamic>>[
            <String, dynamic>{
              'functionResponse': <String, dynamic>{
                'name': 'lookupWeather',
                'response': <String, dynamic>{
                  'tempC': 21,
                  'condition': 'Sunny',
                },
                'id': 'call-1',
              },
            },
          ],
        }),
      );

      final batchedFnResp = Content.functionResponses(<FunctionResponse>[
        FunctionResponse('fnA', <String, Object?>{'ok': true}, id: 'c1'),
        FunctionResponse('fnB', <String, Object?>{'count': 2}, id: 'c2'),
      ]);
      expect(batchedFnResp.role, equals('user'));
      expect(batchedFnResp.parts, hasLength(2));
    });

    test('round-trips ThoughtPart, FunctionCall thoughtSignature, and InlineDataPart bytes', () {
      final rawCandidate = <String, dynamic>{
        'index': 0,
        'finishReason': 'STOP',
        'content': <String, dynamic>{
          'role': 'model',
          'parts': <Map<String, dynamic>>[
            <String, dynamic>{
              'text': 'Checking local weather tool first.',
              'thought': true,
              'thoughtSignature': 'sig-thought-1',
            },
            <String, dynamic>{
              'functionCall': <String, dynamic>{
                'name': 'getForecast',
                'args': <String, dynamic>{'city': 'Tokyo', 'days': 3},
                'id': 'fc-99',
              },
              'thoughtSignature': 'sig-fn-99',
            },
            <String, dynamic>{
              'inlineData': <String, dynamic>{
                'mimeType': 'audio/pcm',
                'data': base64Encode(<int>[1, 2, 3, 4]),
              },
            },
            <String, dynamic>{
              'text': 'Forecast retrieved.',
            },
          ],
        },
      };

      final decoded = decodeGenerateContentResponse(<String, dynamic>{
        'candidates': <Map<String, dynamic>>[rawCandidate],
      });

      // response.text skips ThoughtPart and returns only non-thought TextPart text.
      expect(decoded.text, equals('Forecast retrieved.'));
      expect(
        decoded.thoughtSummary,
        equals('Checking local weather tool first.'),
      );
      expect(decoded.functionCalls, hasLength(1));
      final fnCall = decoded.functionCalls.first;
      expect(fnCall.name, equals('getForecast'));
      expect(fnCall.id, equals('fc-99'));
      expect(fnCall.args, equals(<String, Object?>{'city': 'Tokyo', 'days': 3}));
      expect(fnCall.thoughtSignature, equals('sig-fn-99'));

      expect(decoded.inlineDataParts, hasLength(1));
      expect(decoded.inlineDataParts.first.mimeType, equals('audio/pcm'));
      expect(decoded.inlineDataParts.first.bytes, equals(<int>[1, 2, 3, 4]));

      // Re-serializing model history preserves thoughtSignature for broker replay.
      final reencoded = decoded.candidates.first.content.toJson();
      final reencodedParts = reencoded['parts'] as List<dynamic>;
      expect(
        (reencodedParts[1] as Map<String, dynamic>)['thoughtSignature'],
        equals('sig-fn-99'),
      );
    });

    test('throws SerializationException on malformed inlineData base64', () {
      expect(
        () => decodeWirePart(<String, dynamic>{
          'inlineData': <String, dynamic>{
            'mimeType': 'image/png',
            'data': '%%%not-valid-base64%%%',
          },
        }),
        throwsA(isA<SerializationException>()),
      );
    });
  });

  group('GenerationConfig, ThinkingConfig, and SafetySetting serialization', () {
    test('encodes full GenerationConfig and SafetySetting options', () {
      final config = GenerationConfig(
        temperature: 0.25,
        topP: 0.9,
        topK: 32,
        candidateCount: 2,
        maxOutputTokens: 512,
        stopSequences: <String>['END_TURN'],
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        responseMimeType: 'application/json',
        responseSchema: Schema.fromJsonMap(<String, dynamic>{
          'type': 'object',
          'properties': <String, dynamic>{
            'answer': <String, dynamic>{'type': 'string'},
          },
          'required': <String>['answer'],
        }),
        responseModalities: <ResponseModality>[ResponseModality.text],
        thinkingConfig: ThinkingConfig.withThinkingBudget(
          1024,
          includeThoughts: true,
        ),
      );
      final safety = <SafetySetting>[
        const SafetySetting(
          HarmCategory.harassment,
          HarmBlockThreshold.medium,
          HarmBlockMethod.severity,
        ),
        const SafetySetting(
          HarmCategory.dangerousContent,
          HarmBlockThreshold.high,
        ),
      ];

      final request = encodeGenerateContentRequest(
        prompt: <Content>[Content.text('Ping')],
        systemInstruction: Content.system('Be concise.'),
        generationConfig: config,
        safetySettings: safety,
      );

      expect(
        request['systemInstruction'],
        equals(<String, dynamic>{
          'role': 'system',
          'parts': <Map<String, dynamic>>[
            <String, dynamic>{'text': 'Be concise.'},
          ],
        }),
      );
      final genJson = request['generationConfig'] as Map<String, dynamic>;
      expect(genJson['temperature'], equals(0.25));
      expect(genJson['topP'], equals(0.9));
      expect(genJson['topK'], equals(32));
      expect(genJson['candidateCount'], equals(2));
      expect(genJson['maxOutputTokens'], equals(512));
      expect(genJson['stopSequences'], equals(<String>['END_TURN']));
      expect(genJson['responseMimeType'], equals('application/json'));
      expect(
        genJson['thinkingConfig'],
        equals(<String, dynamic>{
          'thinkingBudget': 1024,
          'includeThoughts': true,
        }),
      );
      expect(
        request['safetySettings'],
        equals(<Map<String, dynamic>>[
          <String, dynamic>{
            'category': 'HARM_CATEGORY_HARASSMENT',
            'threshold': 'BLOCK_MEDIUM_AND_ABOVE',
            'method': 'SEVERITY',
          },
          <String, dynamic>{
            'category': 'HARM_CATEGORY_DANGEROUS_CONTENT',
            'threshold': 'BLOCK_ONLY_HIGH',
          },
        ]),
      );
    });

    test('rejects ThinkingConfig specifying both thinkingBudget and thinkingLevel', () {
      final invalid = GenerationConfig(
        thinkingConfig: const ThinkingConfig(
          thinkingBudget: 256,
          thinkingLevel: ThinkingLevel.high,
        ),
      );
      expect(
        invalid.toJson,
        throwsA(
          isA<FirebaseAIException>().having(
            (err) => err.code,
            'code',
            equals('unsupported'),
          ),
        ),
      );
    });
  });

  group('Blocked responses, UsageMetadata, CountTokensResponse, and error mapping', () {
    test('returns null text and preserves ratings on SAFETY and RECITATION blocks', () {
      final safetyBlocked = decodeGenerateContentResponse(<String, dynamic>{
        'candidates': <Map<String, dynamic>>[
          <String, dynamic>{
            'index': 0,
            'finishReason': 'SAFETY',
            'finishMessage': 'Withheld by safety policy.',
            'safetyRatings': <Map<String, dynamic>>[
              <String, dynamic>{
                'category': 'HARM_CATEGORY_HATE_SPEECH',
                'probability': 'HIGH',
                'severity': 'HARM_SEVERITY_HIGH',
                'blocked': true,
              },
            ],
          },
        ],
      });

      expect(safetyBlocked.text, isNull);
      expect(safetyBlocked.functionCalls, isEmpty);
      expect(safetyBlocked.inlineDataParts, isEmpty);
      expect(safetyBlocked.candidates.single.finishReason, equals(FinishReason.safety));
      expect(safetyBlocked.candidates.single.finishReason!.isBlocked, isTrue);
      expect(
        safetyBlocked.candidates.single.safetyRatings!.single.category,
        equals(HarmCategory.hateSpeech),
      );
      expect(
        safetyBlocked.candidates.single.safetyRatings!.single.probability,
        equals(HarmProbability.high),
      );

      final recitationBlocked = decodeGenerateContentResponse(<String, dynamic>{
        'candidates': <Map<String, dynamic>>[
          <String, dynamic>{
            'index': 0,
            'finishReason': 'RECITATION',
            'content': <String, dynamic>{
              'role': 'model',
              'parts': <Map<String, dynamic>>[
                <String, dynamic>{'text': 'Partial withheld text'},
              ],
            },
          },
        ],
      });
      expect(recitationBlocked.text, isNull);
      expect(
        recitationBlocked.candidates.single.finishReason,
        equals(FinishReason.recitation),
      );

      final promptBlocked = decodeGenerateContentResponse(<String, dynamic>{
        'promptFeedback': <String, dynamic>{
          'blockReason': 'SAFETY',
          'blockReasonMessage': 'Prompt violated safety policy.',
          'safetyRatings': <Map<String, dynamic>>[
            <String, dynamic>{
              'category': 'HARM_CATEGORY_HARASSMENT',
              'probability': 'MEDIUM',
            },
          ],
        },
      });
      expect(promptBlocked.candidates, isEmpty);
      expect(promptBlocked.text, isNull);
      expect(promptBlocked.promptFeedback?.blockReason, equals(BlockReason.safety));
    });

    test('decodes UsageMetadata, CitationMetadata, and CountTokensResponse details', () {
      final response = decodeGenerateContentResponse(<String, dynamic>{
        'modelVersion': 'gemini-2.5-flash-001',
        'responseId': 'resp-42',
        'candidates': <Map<String, dynamic>>[
          <String, dynamic>{
            'index': 0,
            'finishReason': 'STOP',
            'citationMetadata': <String, dynamic>{
              'citations': <Map<String, dynamic>>[
                <String, dynamic>{
                  'startIndex': 0,
                  'endIndex': 12,
                  'uri': 'https://example.org/doc',
                  'license': 'CC-BY-4.0',
                },
              ],
            },
            'content': <String, dynamic>{
              'role': 'model',
              'parts': <Map<String, dynamic>>[
                <String, dynamic>{'text': 'Cited output'},
              ],
            },
          },
        ],
        'usageMetadata': <String, dynamic>{
          'promptTokenCount': 14,
          'candidatesTokenCount': 6,
          'thoughtsTokenCount': 5,
          'totalTokenCount': 25,
          'promptTokensDetails': <Map<String, dynamic>>[
            <String, dynamic>{'modality': 'TEXT', 'tokenCount': 14},
          ],
        },
      });

      expect(response.modelVersion, equals('gemini-2.5-flash-001'));
      expect(response.responseId, equals('resp-42'));
      expect(response.usageMetadata?.promptTokenCount, equals(14));
      expect(response.usageMetadata?.candidatesTokenCount, equals(6));
      expect(response.usageMetadata?.thoughtsTokenCount, equals(5));
      expect(response.usageMetadata?.totalTokenCount, equals(25));
      expect(
        response.usageMetadata?.promptTokensDetails?.single.modality,
        equals(Modality.text),
      );
      expect(
        response.candidates.single.citationMetadata?.citations.single.uri,
        equals(Uri.parse('https://example.org/doc')),
      );

      final countResp = decodeCountTokensResponse(<String, dynamic>{
        'totalTokens': 19,
        'totalBillableCharacters': 68,
        'promptTokensDetails': <Map<String, dynamic>>[
          <String, dynamic>{'modality': 'TEXT', 'tokenCount': 19},
        ],
      });
      expect(countResp.totalTokens, equals(19));
      expect(countResp.totalBillableCharacters, equals(68));
      expect(countResp.promptTokensDetails?.single.tokenCount, equals(19));
    });

    test('maps PyricBridgeException ai/<STATUS> codes and wire envelopes to FirebaseAIException', () {
      final unauthed = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'ai/UNAUTHENTICATED',
          message: 'Firebase App Check token is invalid.',
        ),
      );
      expect(unauthed.code, equals('unauthenticated'));
      expect(unauthed.status, equals(401));
      expect(unauthed.wireStatus, equals('UNAUTHENTICATED'));
      expect(
        unauthed.wireEnvelope?['error'],
        equals(<String, dynamic>{
          'code': 401,
          'message': 'Firebase App Check token is invalid.',
          'status': 'UNAUTHENTICATED',
        }),
      );

      final quota = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'ai/RESOURCE_EXHAUSTED',
          message: 'Quota exceeded for gemini-2.5-flash.',
          envelope: <String, dynamic>{
            'error': <String, dynamic>{
              'code': 429,
              'message': 'Quota exceeded for gemini-2.5-flash.',
              'status': 'RESOURCE_EXHAUSTED',
              'details': <Map<String, dynamic>>[
                <String, dynamic>{'@type': 'type.googleapis.com/google.rpc.QuotaFailure'},
              ],
            },
          },
        ),
      );
      expect(quota, isA<QuotaExceeded>());
      expect(quota.code, equals('quota-exceeded'));
      expect(quota.httpStatusCode, equals(429));
      expect(quota.errorDetails?.single['@type'], contains('QuotaFailure'));

      final unavailable = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'ai/UNAVAILABLE',
          message: 'Model backend temporarily unavailable.',
        ),
      );
      expect(unavailable, isA<ServerException>());
      expect(unavailable.code, equals('unavailable'));
      expect(unavailable.httpStatusCode, equals(503));
    });
  });
}
