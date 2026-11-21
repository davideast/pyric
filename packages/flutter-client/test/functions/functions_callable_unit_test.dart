import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_functions.dart';

void main() {
  HttpOverrides? previousHttpOverrides;
  late HttpServer server;
  late int port;
  Future<void> Function(HttpRequest request)? handler;

  setUpAll(() {
    previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
  });

  tearDownAll(() {
    HttpOverrides.global = previousHttpOverrides;
  });

  setUp(() async {
    await FirebaseFunctions.clearInstancesForTest();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    port = server.port;
    server.listen((request) async {
      final activeHandler = handler;
      if (activeHandler != null) {
        await activeHandler(request);
      } else {
        request.response.statusCode = 404;
        await request.response.close();
      }
    });
  });

  tearDown(() async {
    handler = null;
    await server.close(force: true);
    await FirebaseFunctions.clearInstancesForTest();
  });

  group('FirebaseFunctions HttpsCallable unit contract', () {
    test('invokes named callable via call() and direct function syntax with data/result envelopes', () async {
      final observedPaths = <String>[];
      final observedBodies = <Map<String, dynamic>>[];

      handler = (request) async {
        observedPaths.add(request.uri.path);
        final raw = await utf8.decoder.bind(request).join();
        observedBodies.add(jsonDecode(raw) as Map<String, dynamic>);
        request.response.statusCode = 200;
        request.response.headers.contentType = ContentType.json;
        if (request.uri.path.endsWith('/withDataEnvelope')) {
          request.response.write(jsonEncode(<String, Object?>{
            'data': <String, Object?>{'ok': true, 'envelope': 'data'},
          }));
        } else {
          request.response.write(jsonEncode(<String, Object?>{
            'result': <String, Object?>{
              'echo': observedBodies.last['data'],
              'big': <String, Object?>{
                '@type': int64TypeUrl,
                'value': '9007199254740993',
              },
            },
          }));
        }
        await request.response.close();
      };

      final functions = FirebaseFunctions(projectId: 'demo-unit-project');
      functions.useFunctionsEmulator('10.0.2.2', port);

      final echoCallable = functions.httpsCallable('echoPayload');
      final res1 = await echoCallable.call<Map<String, dynamic>>(<String, Object?>{
        'greeting': 'hi',
      });
      expect(res1.data['echo'], equals(<String, Object?>{'greeting': 'hi'}));
      expect(res1.data['big'], equals(9007199254740993));

      final dataEnvelopeCallable = functions.httpsCallable('withDataEnvelope');
      final res2 = await dataEnvelopeCallable(const <String, Object?>{'n': 1});
      expect(res2.data, equals(<String, Object?>{'ok': true, 'envelope': 'data'}));

      expect(
        observedPaths,
        equals(<String>[
          '/demo-unit-project/us-central1/echoPayload',
          '/demo-unit-project/us-central1/withDataEnvelope',
        ]),
      );
      await functions.dispose();
    });

    test('attaches Authorization Bearer and standard vs limited-use X-Firebase-AppCheck headers', () async {
      final seenHeaders = <Map<String, String>>[];
      final seenLimitedFlags = <bool>[];

      handler = (request) async {
        seenHeaders.add(<String, String>{
          if (request.headers.value('authorization') != null)
            'authorization': request.headers.value('authorization')!,
          if (request.headers.value('x-firebase-appcheck') != null)
            'x-firebase-appcheck': request.headers.value('x-firebase-appcheck')!,
        });
        request.response.statusCode = 200;
        request.response.headers.contentType = ContentType.json;
        request.response.write('{"result":{"accepted":true}}');
        await request.response.close();
      };

      final functions = FirebaseFunctions(
        projectId: 'demo-unit-project',
        authTokenProvider: () async => 'jwt-id-token-123',
        appCheckTokenProvider: ({required bool limitedUse}) async {
          seenLimitedFlags.add(limitedUse);
          return limitedUse ? 'appcheck-limited-999' : 'appcheck-cached-111';
        },
      )..useFunctionsEmulator('127.0.0.1', port);

      await functions.httpsCallable('standardCheck').call(null);
      await functions
          .httpsCallable(
            'consumeCheck',
            options: const HttpsCallableOptions(limitedUseAppCheckToken: true),
          )
          .call(null);

      expect(seenLimitedFlags, equals(<bool>[false, true]));
      expect(
        seenHeaders,
        equals(<Map<String, String>>[
          <String, String>{
            'authorization': 'Bearer jwt-id-token-123',
            'x-firebase-appcheck': 'appcheck-cached-111',
          },
          <String, String>{
            'authorization': 'Bearer jwt-id-token-123',
            'x-firebase-appcheck': 'appcheck-limited-999',
          },
        ]),
      );

      final failingAppCheckFunctions = FirebaseFunctions(
        projectId: 'demo-unit-project',
        appCheckTokenProvider: ({required bool limitedUse}) async {
          throw StateError('app-check-mint-failed');
        },
      )..useFunctionsEmulator('127.0.0.1', port);

      final nonLimitedRes =
          await failingAppCheckFunctions.httpsCallable('nonLimited').call(null);
      expect((nonLimitedRes.data as Map)['accepted'], isTrue);

      await expectLater(
        () => failingAppCheckFunctions
            .httpsCallable(
              'limitedMustPropagate',
              options: const HttpsCallableOptions(limitedUseAppCheckToken: true),
            )
            .call(null),
        throwsA(isA<StateError>()),
      );

      await functions.dispose();
      await failingAppCheckFunctions.dispose();
    });

    test('enforces client timeout with deadline-exceeded and instance dispose with cancelled', () async {
      handler = (request) async {
        await Future<void>.delayed(const Duration(milliseconds: 250));
        try {
          request.response.statusCode = 200;
          request.response.write('{"result":"late"}');
          await request.response.close();
        } catch (_) {}
      };

      final functions = FirebaseFunctions(projectId: 'demo-unit-project')
        ..useFunctionsEmulator('127.0.0.1', port);

      final fastTimeoutCallable = functions.httpsCallable(
        'slowFn',
        options: const HttpsCallableOptions(
          timeout: Duration(milliseconds: 40),
        ),
      );
      await expectLater(
        () => fastTimeoutCallable.call(null),
        throwsA(
          isA<FirebaseFunctionsException>().having(
            (e) => e.code,
            'code',
            equals('deadline-exceeded'),
          ),
        ),
      );

      final inFlight = functions.httpsCallable('slowFn').call(null);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await functions.dispose();
      await expectLater(
        inFlight,
        throwsA(
          isA<FirebaseFunctionsException>().having(
            (e) => e.code,
            'code',
            equals('cancelled'),
          ),
        ),
      );
    });

    test('streams SSE Chunk and terminal Result across split frames and surfaces mid-stream errors', () async {
      handler = (request) async {
        expect(
          request.headers.value('accept'),
          equals('text/event-stream'),
        );
        final bodyMap =
            jsonDecode(await utf8.decoder.bind(request).join()) as Map<String, dynamic>;
        final reqData = bodyMap['data'] as Map<String, dynamic>?;
        request.response.statusCode = 200;
        request.response.bufferOutput = false;
        request.response.headers.set('content-type', 'text/event-stream');

        if (reqData?['failAfterFirst'] == true) {
          request.response.add(utf8.encode('data: {"message":"first-chunk"}\n\n'));
          await request.response.flush();
          request.response.add(
            utf8.encode(
              'data: {"error":{"status":"FAILED_PRECONDITION","message":"stream aborted","details":{"step":1}}}\n\n',
            ),
          );
          await request.response.close();
          return;
        }

        request.response.add(utf8.encode(': keepalive heartbeat\n\n'));
        request.response.add(utf8.encode('data: {"mes'));
        await request.response.flush();
        await Future<void>.delayed(const Duration(milliseconds: 10));
        request.response.add(utf8.encode('sage":"chunk-1"}\n\n'));
        request.response.add(utf8.encode('data: {"message":"chunk-2"}\n\n'));
        request.response.add(
          utf8.encode('data: {"result":{"summary":"complete","count":2}}\n\n'),
        );
        await request.response.close();
      };

      final functions = FirebaseFunctions(projectId: 'demo-unit-project')
        ..useFunctionsEmulator('127.0.0.1', port);

      final events = await functions
          .httpsCallableFromUri(
            Uri.parse('http://127.0.0.1:$port/demo-unit-project/us-central1/streamFn'),
          )
          .stream<String, Map<String, dynamic>>(<String, Object?>{'ok': true})
          .toList();

      expect(events, hasLength(3));
      expect((events[0] as Chunk<String, Map<String, dynamic>>).partialData, equals('chunk-1'));
      expect((events[1] as Chunk<String, Map<String, dynamic>>).partialData, equals('chunk-2'));
      expect(
        (events[2] as Result<String, Map<String, dynamic>>).result.data,
        equals(<String, Object?>{'summary': 'complete', 'count': 2}),
      );

      final partialBeforeError = <String>[];
      Object? caughtError;
      try {
        await for (final item in functions
            .httpsCallable('streamFn')
            .stream<String, Map<String, dynamic>>(
              <String, Object?>{'failAfterFirst': true},
            )) {
          if (item is Chunk<String, Map<String, dynamic>>) {
            partialBeforeError.add(item.partialData);
          }
        }
      } catch (error) {
        caughtError = error;
      }

      expect(partialBeforeError, equals(<String>['first-chunk']));
      expect(caughtError, isA<FirebaseFunctionsException>());
      final fnErr = caughtError! as FirebaseFunctionsException;
      expect(fnErr.code, equals('failed-precondition'));
      expect(fnErr.message, equals('stream aborted'));
      expect(fnErr.details, equals(<String, Object?>{'step': 1}));

      await functions.dispose();
    });
  });
}
