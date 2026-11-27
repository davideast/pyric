import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_ai.dart';
import 'package:pyric_firestore/pyric_app_check.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import '../auth/mock_bridge_helper.dart';

void main() {
  test('P2-F11a/b: Schema preserves 64-bit int bounds and rejects non-finite doubles', () {
    const big = 9007199254740993;
    final intSchema = Schema.integer(minimum: big, maximum: big + 2);
    final json = intSchema.toJson();
    expect(json['minimum'], big);
    expect(json['maximum'], big + 2);

    expect(() => Schema.number(minimum: double.nan), throwsArgumentError);
    expect(() => Schema.number(maximum: double.infinity), throwsArgumentError);
    expect(() => Schema.number(minimum: double.negativeInfinity), throwsArgumentError);
  });

  test('P2-F11c: ChatSession.sendMessageStream retains empty TextPart/ThoughtPart carrying thoughtSignature', () async {
    setupMockFirebase();
    final harness = MockBridgeHarness();
    final client = harness.createClient();
    harness.channel.toServerController.stream.listen((raw) {
      if (raw is! String) return;
      if (raw.contains('"type":"attach"')) {
        harness.ackAttach(clientSessionId: 'sess-ai-sig');
        return;
      }
      if (raw.contains('"type":"worker-sub"')) {
        final msg = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
        final subId = msg['subId'];
        harness.sendToClient({
          'type': 'worker-snap',
          'subId': subId,
          'value': {
            'chunk': {
              'candidates': [
                {
                  'content': {
                    'role': 'model',
                    'parts': [
                      {'text': '', 'thoughtSignature': 'sig-text'},
                      {'text': '', 'thought': true, 'thoughtSignature': 'sig-thought'},
                    ],
                  },
                },
              ],
            },
          },
        });
        harness.sendToClient({
          'type': 'worker-snap',
          'subId': subId,
          'value': {'done': true},
        });
      }
    });
    await client.connect();
    await pumpEventQueue();

    final model = GenerativeModel(
      modelName: 'gemini-2.5-flash',
      isVertexAI: false,
      bridgeClient: client,
      appCheckResolver: () async => null,
    );
    final chat = model.startChat();
    await chat.sendMessageStream(Content.text('hi')).toList();
    expect(chat.history.length, 2);
    final modelParts = chat.history.last.parts;
    expect(modelParts.length, 2);
    expect((modelParts[0] as TextPart).thoughtSignature, 'sig-text');
    expect((modelParts[1] as ThoughtPart).thoughtSignature, 'sig-thought');
    await client.disconnect();
  });

  test('P2-F02: streamAiGenerateContent fails on premature onDone and on timeout without silent truncation', () async {
    setupMockFirebase();
    final harness = MockBridgeHarness();
    final client = harness.createClient();
    harness.channel.toServerController.stream.listen((raw) {
      if (raw is String && raw.contains('"type":"attach"')) {
        harness.ackAttach(clientSessionId: 'sess-ai-p2');
      }
    });
    await client.connect();
    await pumpEventQueue();

    final timeoutStream = streamAiGenerateContent<String>(
      bridgeClient: client,
      buildSubPayload: () async => {
        'target': {'service': 'ai', 'op': 'streamGenerateContent'},
      },
      decodeChunk: (raw) => jsonEncode(raw),
      mapError: (err) => err,
      timeout: const Duration(milliseconds: 60),
    );
    await expectLater(
      timeoutStream,
      emitsError(isA<PyricBridgeException>().having((e) => e.code, 'code', 'deadline-exceeded')),
    );

    final dropErrors = <Object>[];
    final dropStream = streamAiGenerateContent<String>(
      bridgeClient: client,
      buildSubPayload: () async => {
        'target': {'service': 'ai', 'op': 'streamGenerateContent'},
      },
      decodeChunk: (raw) => raw.toString(),
      mapError: (err) => err,
    );
    final sub = dropStream.listen((_) {}, onError: dropErrors.add);
    await pumpEventQueue();
    await client.disconnect();
    await pumpEventQueue();
    expect(dropErrors, isNotEmpty);
    expect((dropErrors.first as PyricBridgeException).code, 'unavailable');
    await sub.cancel();
  });

  test('P2-F05b/c: explicit appCheck is excluded from shared cache and GenerativeModel resolves bridge dynamically', () async {
    await FirebaseAI.clearInstancesForTest();
    final harnessA = MockBridgeHarness();
    final harnessB = MockBridgeHarness();
    final clientA = harnessA.createClient();
    final clientB = harnessB.createClient();
    final customAppCheck = PyricFirebaseAppCheckPlatform(bridgeClient: clientA);

    final withExplicit = FirebaseAI.googleAI(appCheck: customAppCheck);
    final withDefault = FirebaseAI.googleAI();
    expect(identical(withExplicit, withDefault), isFalse);

    PyricBridgeClient active = clientA;
    final model = GenerativeModel(
      modelName: 'gemini-2.5-flash',
      isVertexAI: false,
      bridgeClient: clientA,
      bridgeClientProvider: () => active,
      appCheckResolver: () async => null,
    );
    expect(identical(model.bridgeClient, clientA), isTrue);
    active = clientB;
    expect(identical(model.bridgeClient, clientB), isTrue);

    await customAppCheck.dispose();
    await clientA.disconnect();
    await clientB.disconnect();
    await FirebaseAI.clearInstancesForTest();
  });
}
