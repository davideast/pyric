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
  });
}
