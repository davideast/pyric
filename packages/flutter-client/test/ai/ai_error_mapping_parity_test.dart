import 'dart:async';

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
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

  group('FirebaseAIException error mapping parity', () {
    test('maps invalid-argument, permission-denied, unauthenticated, quota-exceeded, and unavailable across generateContent and countTokens', () async {
      final cases = <({
        String wireCode,
        String message,
        String expectedCode,
        int expectedHttp,
        String expectedRpc,
        Type expectedType,
      })>[
        (
          wireCode: 'ai/INVALID_ARGUMENT',
          message: 'GenerateContentRequest.contents: contents is not specified',
          expectedCode: 'invalid-argument',
          expectedHttp: 400,
          expectedRpc: 'INVALID_ARGUMENT',
          expectedType: FirebaseAIException,
        ),
        (
          wireCode: 'ai/PERMISSION_DENIED',
          message: 'Caller does not have permission to access model.',
          expectedCode: 'permission-denied',
          expectedHttp: 403,
          expectedRpc: 'PERMISSION_DENIED',
          expectedType: FirebaseAIException,
        ),
        (
          wireCode: 'ai/UNAUTHENTICATED',
          message: 'Firebase App Check token is invalid.',
          expectedCode: 'unauthenticated',
          expectedHttp: 401,
          expectedRpc: 'UNAUTHENTICATED',
          expectedType: FirebaseAIException,
        ),
        (
          wireCode: 'ai/RESOURCE_EXHAUSTED',
          message: 'Quota exceeded for metric generate_content_requests.',
          expectedCode: 'quota-exceeded',
          expectedHttp: 429,
          expectedRpc: 'RESOURCE_EXHAUSTED',
          expectedType: QuotaExceeded,
        ),
        (
          wireCode: 'ai/UNAVAILABLE',
          message: 'The model is currently overloaded. Please try again later.',
          expectedCode: 'unavailable',
          expectedHttp: 503,
          expectedRpc: 'UNAVAILABLE',
          expectedType: ServerException,
        ),
      ];

      var activeCase = cases.first;
      fakeBridge.onFrame = (frame) {
        if (frame['type'] != 'worker-op') {
          return;
        }
        final op = frame['op'] as Map<String, dynamic>;
        final method = op['method'] as String;
        if (method == 'ai.generateContent' || method == 'ai.countTokens') {
          final id = frame['id'] as String;
          scheduleMicrotask(() {
            fakeBridge.current.deliver(<String, dynamic>{
              'type': 'worker-res',
              'id': id,
              'ok': false,
              'error': <String, dynamic>{
                'code': activeCase.wireCode,
                'message': activeCase.message,
              },
            });
          });
        }
      };

      final model = FirebaseAI.googleAI(bridgeClient: bridgeClient)
          .generativeModel(model: 'gemini-2.5-flash');

      for (final testCase in cases) {
        activeCase = testCase;

        for (final opRunner in <Future<Object?> Function()>[
          () => model.generateContent(<Content>[Content.text('probe')]),
          () => model.countTokens(<Content>[Content.text('probe')]),
        ]) {
          FirebaseAIException? caught;
          try {
            await opRunner();
          } on FirebaseAIException catch (err) {
            caught = err;
          }
          expect(caught, isNotNull, reason: 'Expected ${testCase.wireCode}');
          expect(caught.runtimeType, equals(testCase.expectedType));
          expect(caught!.code, equals(testCase.expectedCode));
          expect(caught.httpStatusCode, equals(testCase.expectedHttp));
          expect(caught.status, equals(testCase.expectedHttp));
          expect(caught.wireStatus, equals(testCase.expectedRpc));
          expect(caught.message, equals(testCase.message));
          expect(
            caught.wireEnvelope?['error'],
            equals(<String, dynamic>{
              'code': testCase.expectedHttp,
              'message': testCase.message,
              'status': testCase.expectedRpc,
            }),
          );
        }
      }
    });

    test('specializes InvalidApiKey, ServiceApiNotEnabled, and UnsupportedUserLocation from wire ErrorInfo details', () {
      final invalidKey = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'ai/INVALID_ARGUMENT',
          message: 'API key not valid. Please pass a valid API key.',
          envelope: <String, dynamic>{
            'aiEnvelope': <String, dynamic>{
              'error': <String, dynamic>{
                'code': 400,
                'message': 'API key not valid. Please pass a valid API key.',
                'status': 'INVALID_ARGUMENT',
                'details': <Map<String, dynamic>>[
                  <String, dynamic>{
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    'reason': 'API_KEY_INVALID',
                    'domain': 'googleapis.com',
                  },
                ],
              },
            },
          },
        ),
      );
      expect(invalidKey, isA<InvalidApiKey>());
      expect(invalidKey.code, equals('invalid-argument'));
      expect(invalidKey.httpStatusCode, equals(400));
      expect(invalidKey.errorDetails?.single['reason'], equals('API_KEY_INVALID'));

      final disabledApi = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'ai/PERMISSION_DENIED',
          message: 'Firebase AI Logic API has not been used in project demo.',
          envelope: <String, dynamic>{
            'error': <String, dynamic>{
              'code': 403,
              'message': 'Firebase AI Logic API has not been used in project demo.',
              'status': 'PERMISSION_DENIED',
              'details': <Map<String, dynamic>>[
                <String, dynamic>{
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  'reason': 'SERVICE_DISABLED',
                },
              ],
            },
          },
        ),
      );
      expect(disabledApi, isA<ServiceApiNotEnabled>());
      expect(disabledApi.code, equals('permission-denied'));
      expect(disabledApi.httpStatusCode, equals(403));

      final unsupportedLocation = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'ai/FAILED_PRECONDITION',
          message: 'User location is not supported for the API use.',
        ),
      );
      expect(unsupportedLocation, isA<UnsupportedUserLocation>());
      expect(unsupportedLocation.code, equals('invalid-argument'));
      expect(unsupportedLocation.httpStatusCode, equals(400));
      expect(unsupportedLocation.wireStatus, equals('FAILED_PRECONDITION'));

      // Stripped PyricBridgeClient relay (envelope == null) still specializes cleanly.
      final strippedInvalidKey = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'ai/INVALID_ARGUMENT',
          message: 'API key not valid. Please pass a valid API key.',
        ),
      );
      expect(strippedInvalidKey, isA<InvalidApiKey>());
      expect(strippedInvalidKey.code, equals('invalid-argument'));

      final strippedDisabledApi = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'ai/PERMISSION_DENIED',
          message: 'Firebase AI Logic API has not been used in project demo.',
        ),
      );
      expect(strippedDisabledApi, isA<ServiceApiNotEnabled>());
      expect(strippedDisabledApi.code, equals('permission-denied'));

      final reasonOnlyUnsupportedLocation = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'ai/FAILED_PRECONDITION',
          message: 'Precondition check failed.',
          envelope: <String, dynamic>{
            'error': <String, dynamic>{
              'code': 400,
              'message': 'Precondition check failed.',
              'status': 'FAILED_PRECONDITION',
              'details': <Map<String, dynamic>>[
                <String, dynamic>{
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  'reason': 'USER_LOCATION_NOT_SUPPORTED',
                },
              ],
            },
          },
        ),
      );
      expect(reasonOnlyUnsupportedLocation, isA<UnsupportedUserLocation>());
    });

    test('maps retired-model 404, deadline-exceeded 504, internal 500, kebab-case codes, and FirebaseException', () {
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

      final timeoutErr = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'deadline-exceeded',
          message: 'Remote sandbox op timed out after 35000ms.',
        ),
      );
      expect(timeoutErr, isA<ServerException>());
      expect(timeoutErr.code, equals('deadline-exceeded'));
      expect(timeoutErr.httpStatusCode, equals(504));
      expect(timeoutErr.wireEnvelope?['error']?['code'], equals(504));

      final internalErr = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'ai/INTERNAL',
          message: 'Unexpected upstream failure.',
        ),
      );
      expect(internalErr, isA<ServerException>());
      expect(internalErr.code, equals('internal'));
      expect(internalErr.httpStatusCode, equals(500));

      final bareUnavailable = mapBridgeErrorToFirebaseAIException(
        const PyricBridgeException(
          code: 'unavailable',
          message: 'The bridge connection was lost.',
        ),
      );
      expect(bareUnavailable, isA<ServerException>());
      expect(bareUnavailable.code, equals('unavailable'));
      expect(bareUnavailable.httpStatusCode, equals(503));

      final appCheckFailure = mapBridgeErrorToFirebaseAIException(
        FirebaseException(
          plugin: 'firebase_app_check',
          code: 'appCheck/permission-denied',
          message: 'App Check provider rejected attestation.',
        ),
      );
      expect(appCheckFailure.code, equals('permission-denied'));
      expect(appCheckFailure.httpStatusCode, equals(403));
    });
  });
}
