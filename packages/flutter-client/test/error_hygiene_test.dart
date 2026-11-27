import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/src/auth/auth_wire_codec.dart';
import 'package:pyric_firestore/src/storage/storage_wire_codec.dart';
import 'package:pyric_firestore/src/transport/exceptions.dart';

void main() {
  group('S1-07 concise exception toString()', () {
    test('PyricBridgeException keeps denialContext property without dumping it in toString', () {
      final largeAst = <String, dynamic>{
        'rule': <String, dynamic>{'line': 42, 'file': 'firestore.rules'},
        'expressionTrace': List<String>.filled(200, 'request.auth.uid == resource.data.ownerId'),
      };
      final err = PyricBridgeException(
        code: 'permission-denied',
        message: 'Permission denied on playlists/pl-bob-only',
        denialContext: largeAst,
      );

      expect(err.denialContext, same(largeAst));
      expect(err.toString(), equals('PyricBridgeException(permission-denied): Permission denied on playlists/pl-bob-only'));
      expect(err.toString(), isNot(contains('denialContext')));
      expect(err.toString(), isNot(contains('expressionTrace')));
    });

    test('mapToStorageFirebaseException omits raw transport stackTrace from FirebaseException.toString', () {
      final rawTrace = StackTrace.fromString(
        List<String>.generate(
          80,
          (i) => '#$i      _WebSocketTransport._onFrame (package:pyric_firestore/src/transport/ws.dart:${100 + i}:12)',
        ).join('\n'),
      );
      final bridgeErr = PyricBridgeException(
        code: 'storage/unauthorized',
        message: 'User is not authorized to perform the desired action.',
        denialContext: <String, dynamic>{'rule': 'allow read: if false;'},
      );

      final mapped = mapToStorageFirebaseException(bridgeErr, rawTrace);
      expect(mapped.plugin, equals('firebase_storage'));
      expect(mapped.code, equals('unauthorized'));
      expect(mapped.stackTrace, isNull);
      expect(
        mapped.toString(),
        equals('[firebase_storage/unauthorized] User is not authorized to perform the desired action.'),
      );
      expect(mapped.toString(), isNot(contains('_WebSocketTransport')));
    });

    test('mapToStorageFirebaseException strips existing stackTrace on firebase_storage FirebaseException', () {
      final existing = FirebaseException(
        plugin: 'firebase_storage',
        code: 'unauthorized',
        message: 'Denied by rules',
        stackTrace: StackTrace.fromString('#0 internalFrame (dart:async/zone.dart:1:1)'),
      );
      final mapped = mapToStorageFirebaseException(existing, StackTrace.current);
      expect(mapped.stackTrace, isNull);
      expect(mapped.toString(), equals('[firebase_storage/unauthorized] Denied by rules'));
    });
  });

  group('S1-09 blocking function JSON error parsing', () {
    test('extracts message and maps PERMISSION_DENIED status from raw JSON error body', () {
      const bridgeErr = PyricBridgeException(
        code: 'auth/internal-error',
        message: '{"error":{"message":"Your email address is not on the allowlist.","status":"PERMISSION_DENIED"}}',
      );
      final mapped = mapBridgeAuthError(bridgeErr);
      expect(mapped, isA<FirebaseAuthException>());
      final authErr = mapped as FirebaseAuthException;
      expect(authErr.code, equals('permission-denied'));
      expect(authErr.message, equals('Your email address is not on the allowlist.'));
      expect(authErr.toString(), isNot(contains('{"error"')));
    });

    test('handles prefixed JSON blocking error body and FAILED_PRECONDITION status', () {
      const bridgeErr = PyricBridgeException(
        code: 'internal-error',
        message: 'HTTP 400: {"error":{"message":"Invite code required.","status":"FAILED_PRECONDITION"}}',
      );
      final authErr = mapBridgeAuthError(bridgeErr) as FirebaseAuthException;
      expect(authErr.code, equals('failed-precondition'));
      expect(authErr.message, equals('Invite code required.'));
    });

    test('preserves specific auth error codes even when message contains structured JSON', () {
      const bridgeErr = PyricBridgeException(
        code: 'auth/user-disabled',
        message: '{"error":{"message":"Account suspended by admin.","status":"PERMISSION_DENIED"}}',
      );
      final authErr = mapBridgeAuthError(bridgeErr) as FirebaseAuthException;
      expect(authErr.code, equals('user-disabled'));
      expect(authErr.message, equals('Account suspended by admin.'));
    });

    test('leaves malformed JSON or plain messages intact', () {
      const malformed = PyricBridgeException(
        code: 'auth/internal-error',
        message: '{not valid json',
      );
      final authErr = mapBridgeAuthError(malformed) as FirebaseAuthException;
      expect(authErr.code, equals('internal-error'));
      expect(authErr.message, equals('{not valid json'));
    });
  });
}
