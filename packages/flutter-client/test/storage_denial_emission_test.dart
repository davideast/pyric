import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/src/transport/bridge_frame_codec.dart';

void main() {
  group('parseBridgeError storage denial classification', () {
    test('marks storage/unauthorized as a denial even without denialContext', () {
      final parsed = parseBridgeError(
        const {'code': 'storage/unauthorized', 'message': 'Object read denied.'},
        defaultCode: 'unknown',
        defaultMessage: 'Unknown error',
      );
      expect(parsed.isDenial, isTrue);
      expect(parsed.exception.code, equals('storage/unauthorized'));
    });

    test('marks bare unauthorized as a denial even without denialContext', () {
      final parsed = parseBridgeError(
        const {'code': 'unauthorized', 'message': 'Upload denied.'},
        defaultCode: 'unknown',
        defaultMessage: 'Unknown error',
      );
      expect(parsed.isDenial, isTrue);
    });

    test('does not mark unrelated errors without denialContext as denials', () {
      final parsed = parseBridgeError(
        const {'code': 'not-found', 'message': 'Missing object.'},
        defaultCode: 'unknown',
        defaultMessage: 'Unknown error',
      );
      expect(parsed.isDenial, isFalse);
    });

    test('does not fire isDenial on auth/internal-error containing PERMISSION_DENIED text', () {
      final parsed = parseBridgeError(
        const {
          'code': 'auth/internal-error',
          'message': '{"error":{"message":"Email not allowlisted.","status":"PERMISSION_DENIED"}}',
        },
        defaultCode: 'unknown',
        defaultMessage: 'Unknown error',
      );
      expect(parsed.isDenial, isFalse);
    });

    test('marks canonical permission-denied codes as denials', () {
      for (final code in const [
        'permission-denied',
        'PERMISSION_DENIED',
        'firestore/permission-denied',
        'database/permission-denied',
      ]) {
        final parsed = parseBridgeError(
          {'code': code, 'message': 'Denied'},
          defaultCode: 'unknown',
          defaultMessage: 'Unknown error',
        );
        expect(parsed.isDenial, isTrue, reason: 'Expected $code to be classified as denial');
      }
    });
  });
}
