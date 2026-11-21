import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_functions.dart';

void main() {
  group('Functions callable wire serializer', () {
    test('encodes JSON primitives, lists, nested maps, 64-bit ints, and BigInt wrappers', () {
      expect(encodeCallableData(null), isNull);
      expect(encodeCallableData(true), isTrue);
      expect(encodeCallableData(false), isFalse);
      expect(encodeCallableData(42), equals(42));
      expect(encodeCallableData(3.5), equals(3.5));
      expect(encodeCallableData('hello'), equals('hello'));
      expect(
        encodeCallableData(9007199254740993),
        equals(<String, Object?>{
          '@type': int64TypeUrl,
          'value': '9007199254740993',
        }),
      );
      expect(
        encodeCallableData(-9007199254740993),
        equals(<String, Object?>{
          '@type': int64TypeUrl,
          'value': '-9007199254740993',
        }),
      );
      expect(
        encodeCallableData(BigInt.parse('9007199254740993')),
        equals(<String, Object?>{
          '@type': int64TypeUrl,
          'value': '9007199254740993',
        }),
      );
      expect(
        encodeCallableData(<String, Object?>{
          'items': <Object?>[1, 'two', false, null],
          'nested': <String, Object?>{'count': 7},
        }),
        equals(<String, Object?>{
          'items': <Object?>[1, 'two', false, null],
          'nested': <String, Object?>{'count': 7},
        }),
      );
    });

    test('rejects non-finite doubles and non-String map keys', () {
      expect(
        () => encodeCallableData(double.nan),
        throwsArgumentError,
      );
      expect(
        () => encodeCallableData(double.infinity),
        throwsArgumentError,
      );
      expect(
        () => encodeCallableData(double.negativeInfinity),
        throwsArgumentError,
      );
      expect(
        () => encodeCallableData(<Object?, Object?>{123: 'bad-key'}),
        throwsArgumentError,
      );
    });

    test('decodes Int64Value and UInt64Value with full 64-bit precision', () {
      final decodedInt64 = decodeCallableData(<String, Object?>{
        '@type': int64TypeUrl,
        'value': '9007199254740993',
      });
      expect(decodedInt64, isA<int>());
      expect(decodedInt64, equals(9007199254740993));

      final decodedNeg64 = decodeCallableData(<String, Object?>{
        '@type': int64TypeUrl,
        'value': '-9007199254740993',
      });
      expect(decodedNeg64, equals(-9007199254740993));

      final decodedHugeUint64 = decodeCallableData(<String, Object?>{
        '@type': uint64TypeUrl,
        'value': '18446744073709551615',
      });
      expect(
        decodedHugeUint64,
        equals(BigInt.parse('18446744073709551615')),
      );
    });

    test('decodes nested containers and rejects unknown @type wrappers', () {
      final nested = decodeCallableData(<String, Object?>{
        'id': <String, Object?>{
          '@type': int64TypeUrl,
          'value': '9007199254740995',
        },
        'tags': <Object?>[
          'alpha',
          <String, Object?>{'@type': uint64TypeUrl, 'value': '77'},
        ],
      }) as Map<String, dynamic>;

      expect(nested['id'], equals(9007199254740995));
      expect(nested['tags'], equals(<Object?>['alpha', 77]));

      expect(
        () => decodeCallableData(<String, Object?>{
          '@type': 'type.googleapis.com/unknown.CustomMessage',
          'value': '123',
        }),
        throwsFormatException,
      );
    });
  });

  group('Functions URL resolution and off-machine guard', () {
    test('parses region vs custom domain and normalizes emulator origins', () {
      final def = parseRegionOrCustomDomain(null);
      expect(def.region, equals('us-central1'));
      expect(def.customDomain, isNull);

      final regional = parseRegionOrCustomDomain('europe-west1');
      expect(regional.region, equals('europe-west1'));
      expect(regional.customDomain, isNull);

      final custom = parseRegionOrCustomDomain('http://127.0.0.1:5001/');
      expect(custom.region, equals('us-central1'));
      expect(custom.customDomain, equals('http://127.0.0.1:5001'));

      expect(
        normalizeEmulatorOrigin('10.0.2.2', 5001),
        equals('http://127.0.0.1:5001'),
      );
      expect(
        normalizeEmulatorOrigin('::1', 5001),
        equals('http://[::1]:5001'),
      );
    });

    test('resolves named callables onto emulator or local gateway and blocks off-machine customDomain', () {
      final emulatorTarget = resolveNamedCallableTarget(
        name: '/pyricCallableEcho',
        projectId: 'demo-functions',
        region: 'europe-west1',
        customDomain: null,
        emulatorOrigin: 'http://127.0.0.1:5001',
        gatewayOrigin: null,
      );
      expect(
        emulatorTarget.uri.toString(),
        equals('http://127.0.0.1:5001/demo-functions/europe-west1/pyricCallableEcho'),
      );

      final loopbackCustomDomain = resolveNamedCallableTarget(
        name: 'customFn',
        projectId: 'demo-functions',
        region: 'us-central1',
        customDomain: 'http://10.0.2.2:5050/functions',
        emulatorOrigin: null,
        gatewayOrigin: null,
      );
      expect(
        loopbackCustomDomain.uri.toString(),
        equals('http://127.0.0.1:5050/functions/customFn'),
      );

      expect(
        () => resolveNamedCallableTarget(
          name: 'remoteFn',
          projectId: 'demo-functions',
          region: 'us-central1',
          customDomain: 'https://functions.example.com',
          emulatorOrigin: null,
          gatewayOrigin: 'http://127.0.0.1:4400',
        ),
        throwsA(
          isA<FirebaseFunctionsException>().having(
            (e) => e.code,
            'code',
            equals('unavailable'),
          ),
        ),
      );
    });

    test('rewrites cloudfunctions.net and run.app URLs onto local gateway and refuses arbitrary external URLs', () {
      const gateway = 'http://127.0.0.1:4510';

      final cfTarget = resolveUrlCallableTarget(
        rawUrl: 'https://europe-west1-demo-functions.cloudfunctions.net/echoWidget',
        projectId: 'demo-functions',
        emulatorOrigin: null,
        gatewayOrigin: gateway,
      );
      expect(
        cfTarget.uri.toString(),
        equals('http://127.0.0.1:4510/demo-functions/europe-west1/echoWidget'),
      );

      final regionalRun = resolveUrlCallableTarget(
        rawUrl: 'https://callableecho-123456789.us-central1.run.app',
        projectId: 'demo-functions',
        emulatorOrigin: null,
        gatewayOrigin: gateway,
      );
      expect(
        regionalRun.uri.toString(),
        equals('http://127.0.0.1:4510/demo-functions/us-central1/callableecho?__pyric_run_service=1'),
      );

      final legacyRun = resolveUrlCallableTarget(
        rawUrl: 'https://callableecho-abc123xyz-uc.a.run.app',
        projectId: 'demo-functions',
        emulatorOrigin: null,
        gatewayOrigin: gateway,
      );
      expect(
        legacyRun.uri.toString(),
        equals('http://127.0.0.1:4510/demo-functions/-/callableecho?__pyric_run_service=1'),
      );
      expect(legacyRun.ambiguousRunWarning, isNotNull);

      expect(
        () => resolveUrlCallableTarget(
          rawUrl: 'https://api.example.org/callable',
          projectId: 'demo-functions',
          emulatorOrigin: null,
          gatewayOrigin: gateway,
        ),
        throwsA(
          isA<FirebaseFunctionsException>().having(
            (e) => e.code,
            'code',
            equals('unavailable'),
          ),
        ),
      );
    });
  });

  group('Functions HTTP status and wire error mapping', () {
    test('maps canonical HTTP statuses and structured HttpsError payloads', () {
      expect(codeForHttpStatus(200), equals('ok'));
      expect(codeForHttpStatus(0), equals('internal'));
      expect(codeForHttpStatus(400), equals('invalid-argument'));
      expect(codeForHttpStatus(401), equals('unauthenticated'));
      expect(codeForHttpStatus(403), equals('permission-denied'));
      expect(codeForHttpStatus(404), equals('not-found'));
      expect(codeForHttpStatus(409), equals('aborted'));
      expect(codeForHttpStatus(429), equals('resource-exhausted'));
      expect(codeForHttpStatus(499), equals('cancelled'));
      expect(codeForHttpStatus(500), equals('internal'));
      expect(codeForHttpStatus(501), equals('unimplemented'));
      expect(codeForHttpStatus(503), equals('unavailable'));
      expect(codeForHttpStatus(504), equals('deadline-exceeded'));
      expect(codeForHttpStatus(418), equals('unknown'));

      final err = errorForCallableResponse(400, <String, Object?>{
        'error': <String, Object?>{
          'status': 'FAILED_PRECONDITION',
          'message': 'Quota check failed',
          'details': <String, Object?>{
            'limit': <String, Object?>{
              '@type': int64TypeUrl,
              'value': '9007199254740999',
            },
          },
        },
      });
      expect(err, isNotNull);
      expect(err!.code, equals('failed-precondition'));
      expect(err.message, equals('Quota check failed'));
      expect(err.details, equals(<String, Object?>{'limit': 9007199254740999}));
    });
  });
}
