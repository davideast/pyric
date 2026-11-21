import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_app_check.dart';
import 'package:pyric_firestore/pyric_functions.dart';

import '../functions/functions_live_host_helpers.dart';

void main() {
  final h = LiveFunctionsHarness();

  setUpAll(h.setUp);
  tearDownAll(h.tearDown);

  group('Pyric Flutter Cloud Functions callable live-host conformance', () {
    test('functions-live#1: echoes v2, v1, URL, and regional Int64Value callables while blocking off-machine origins', () async {
      if (h.isOffline) {
        final offlineFn = FirebaseFunctions(projectId: 'demo-offline');
        await expectFunctionsExceptionCode(
          () => offlineFn
              .httpsCallableFromUrl('https://api.example.com/offMachine')
              .call(null),
          'unavailable',
        );
        await offlineFn.dispose();
        return;
      }

      final functions = h.liveFunctions!;
      await expectFunctionsExceptionCode(
        () => functions
            .httpsCallableFromUrl('https://api.example.com/offMachine')
            .call(null),
        'unavailable',
      );

      if (!h.isDedicatedFunctionsHost) {
        final bridgeOrigin = Uri(
          scheme: h.bridgeUri!.scheme == 'wss' ? 'https' : 'http',
          host: h.bridgeUri!.host,
          port: h.bridgeUri!.port,
        ).toString();
        final rewritten = resolveUrlCallableTarget(
          rawUrl:
              'https://us-central1-${h.projectId}.cloudfunctions.net/bridgeCheck',
          projectId: h.projectId,
          emulatorOrigin: null,
          gatewayOrigin: bridgeOrigin,
        );
        expect(
          rewritten.uri.toString(),
          equals('$bridgeOrigin/${h.projectId}/us-central1/bridgeCheck'),
        );
        return;
      }

      final v2Echo = await functions
          .httpsCallable('pyricCallableEcho')
          .call<Map<String, dynamic>>(<String, Object?>{
        'sku': 'widget-42',
        'tags': <Object?>['fast', 2, true, null],
      });
      expect(v2Echo.data['dataType'], equals('object'));
      expect(
        v2Echo.data['data'],
        equals(<String, Object?>{
          'sku': 'widget-42',
          'tags': <Object?>['fast', 2, true, null],
        }),
      );
      expect((v2Echo.data['auth'] as Map)['present'], isFalse);
      expect((v2Echo.data['app'] as Map)['present'], isFalse);

      final v1Echo = await functions
          .httpsCallable('pyricCallableV1')(<String, Object?>{'v1': 'ok'});
      expect((v1Echo.data as Map)['data'], equals(<String, Object?>{'v1': 'ok'}));

      final fromCfUrl = await functions
          .httpsCallableFromUrl(
            'https://us-central1-${h.projectId}.cloudfunctions.net/pyricCallableEcho',
          )
          .call<Map<String, dynamic>>(<String, Object?>{'via': 'cloudfunctions'});
      expect(
        fromCfUrl.data['data'],
        equals(<String, Object?>{'via': 'cloudfunctions'}),
      );

      final gatewayUri = h.functionsGatewayUri!;
      final emulatorScoped = FirebaseFunctions(
        app: h.liveApp,
        region: 'europe-west1',
      )..useFunctionsEmulator(gatewayUri.host, gatewayUri.port);
      final regionalRes = await emulatorScoped
          .httpsCallable('regionalInt64Echo')
          .call<Map<String, dynamic>>(<String, Object?>{
        'bigInput': 9007199254740993,
      });
      expect(regionalRes.data['region'], equals('europe-west1'));
      expect(
        regionalRes.data['receivedInput'],
        equals(9007199254740993),
      );
      expect(regionalRes.data['int64'], isA<int>());
      expect(regionalRes.data['int64'], equals(9007199254740993));
      await emulatorScoped.dispose();
    });

    test('functions-live#2: maps structured HttpsError details, unhandled INTERNAL failures, and client deadlines', () async {
      if (h.isOffline) {
        final mapped = errorForCallableResponse(400, <String, Object?>{
          'error': <String, Object?>{
            'status': 'INVALID_ARGUMENT',
            'message': 'invalid widget',
            'details': <String, Object?>{'field': 'sku'},
          },
        });
        expect(mapped?.code, equals('invalid-argument'));
        expect(mapped?.details, equals(<String, Object?>{'field': 'sku'}));
        return;
      }

      if (!h.isDedicatedFunctionsHost) {
        expect(h.liveFunctions!.projectId, equals(h.projectId));
        return;
      }

      final functions = h.liveFunctions!;
      final structuredErr = await expectFunctionsExceptionCode(
        () => functions.httpsCallable('pyricCallableEcho').call(<String, Object?>{
          'mode': 'throw',
          'code': 'invalid-argument',
          'message': 'sku must match pattern',
          'details': <String, Object?>{'field': 'sku', 'code': 1004},
        }),
        'invalid-argument',
      );
      expect(structuredErr.message, equals('sku must match pattern'));
      expect(
        structuredErr.details,
        equals(<String, Object?>{'field': 'sku', 'code': 1004}),
      );

      await expectFunctionsExceptionCode(
        () => functions
            .httpsCallable('pyricCallableEcho')
            .call(<String, Object?>{'mode': 'throw-plain'}),
        'internal',
      );

      await expectFunctionsExceptionCode(
        () => functions.httpsCallable('nonExistentFunctionName').call(null),
        'not-found',
      );

      await expectFunctionsExceptionCode(
        () => functions
            .httpsCallable(
              'pyricCallableEcho',
              options: const HttpsCallableOptions(
                timeout: Duration(milliseconds: 50),
              ),
            )
            .call(<String, Object?>{'mode': 'delay', 'ms': 350}),
        'deadline-exceeded',
      );
    });

    test('functions-live#3: attaches verified Auth ID token and standard + limited-use App Check tokens', () async {
      if (h.isOffline) {
        const opts = HttpsCallableOptions(limitedUseAppCheckToken: true);
        expect(opts.limitedUseAppCheckToken, isTrue);
        expect(opts.limitedUseAppCheckTokens, isTrue);
        return;
      }

      if (!h.isDedicatedFunctionsHost) {
        await h.liveAppCheck!.activate(
          providerAndroid: const AndroidDebugProvider(),
        );
        final minted = await h.liveAppCheck!.getLimitedUseToken();
        expect(minted.isNotEmpty, isTrue);
        return;
      }

      final functions = h.liveFunctions!;

      await expectFunctionsExceptionCode(
        () => functions.httpsCallable('pyricCallableEnforced').call(<String, Object?>{
          'step': 'before-appcheck',
        }),
        'unauthenticated',
      );

      final cred = await h.liveAuth!.createUserWithEmailAndPassword(
        'functions-caller@example.test',
        'correct-horse-battery-staple',
      );
      final signedInUid = cred.user!.uid;
      expect(signedInUid.isNotEmpty, isTrue);

      await h.liveAppCheck!.activate(
        providerAndroid: const AndroidDebugProvider(),
      );

      final authedEcho = await functions
          .httpsCallable('pyricCallableEnforced')
          .call<Map<String, dynamic>>(<String, Object?>{'step': 'with-tokens'});
      final authReport = authedEcho.data['auth'] as Map<String, dynamic>;
      final appReport = authedEcho.data['app'] as Map<String, dynamic>;
      expect(authReport['present'], isTrue);
      expect(authReport['uidMatchesSub'], isTrue);
      expect(authReport['aud'], equals(h.projectId));
      expect(appReport['present'], isTrue);
      expect(appReport['appIdPresent'], isTrue);

      final consumedFirst = await functions
          .httpsCallable(
            'pyricCallableConsume',
            options: const HttpsCallableOptions(limitedUseAppCheckToken: true),
          )
          .call<Map<String, dynamic>>(<String, Object?>{'seq': 1});
      final firstApp = consumedFirst.data['app'] as Map<String, dynamic>;
      expect(firstApp['present'], isTrue);
      expect(firstApp['alreadyConsumed'], isFalse);

      final consumedSecond = await functions
          .httpsCallable(
            'pyricCallableConsume',
            options: const HttpsCallableOptions(limitedUseAppCheckToken: true),
          )
          .call<Map<String, dynamic>>(<String, Object?>{'seq': 2});
      final secondApp = consumedSecond.data['app'] as Map<String, dynamic>;
      expect(secondApp['alreadyConsumed'], isFalse);
    });

    test('functions-live#4: streams progressive Chunk packets and terminal Result or mid-stream HttpsError over SSE', () async {
      if (h.isOffline || !h.isDedicatedFunctionsHost) {
        const chunkEvent = Chunk<String, String>('part');
        const resultEvent = Result<String, String>(HttpsCallableResult('done'));
        expect(chunkEvent.partialData, equals('part'));
        expect(resultEvent.result.data, equals('done'));
        return;
      }

      final functions = h.liveFunctions!;
      final receivedChunks = <Object?>[];
      Map<String, dynamic>? finalResult;

      await for (final event in functions
          .httpsCallable('pyricCallableStream')
          .stream<Object?, Map<String, dynamic>>(<String, Object?>{
        'chunks': <Object?>[
          'alpha',
          <String, Object?>{'idx': 2},
          'omega',
        ],
      })) {
        switch (event) {
          case Chunk<Object?, Map<String, dynamic>>(:final partialData):
            receivedChunks.add(partialData);
          case Result<Object?, Map<String, dynamic>>(:final result):
            finalResult = result.data;
        }
      }

      expect(
        receivedChunks,
        equals(<Object?>[
          'alpha',
          <String, Object?>{'idx': 2},
          'omega',
        ]),
      );
      expect(finalResult, isNotNull);
      expect(finalResult!['acceptsStreaming'], isTrue);
      expect(finalResult['sendChunkResults'], equals(<bool>[true, true, true]));

      final chunksBeforeFailure = <Object?>[];
      FirebaseFunctionsException? streamError;
      try {
        await for (final event in functions
            .httpsCallable('pyricCallableStream')
            .stream<Object?, Map<String, dynamic>>(<String, Object?>{
          'chunks': <Object?>['only-first', 'never-sent'],
          'mode': 'throw',
        })) {
          if (event is Chunk<Object?, Map<String, dynamic>>) {
            chunksBeforeFailure.add(event.partialData);
          }
        }
      } on FirebaseFunctionsException catch (error) {
        streamError = error;
      }

      expect(chunksBeforeFailure, equals(<Object?>['only-first']));
      expect(streamError, isNotNull);
      expect(streamError!.code, equals('failed-precondition'));
      expect(streamError.message, equals('stream failed after one chunk'));
      expect(streamError.details, equals(<String, Object?>{'after': 1}));
    });
  });
}
