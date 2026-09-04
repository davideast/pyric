import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/src/transport/exceptions.dart';

void main() {
  group('Adversarial Stress Test: Corrupt & Malformed CEL Denial Payloads', () {
    test('handles non-string file, citation, expression in rule object', () {
      final corruptPayload = <dynamic, dynamic>{
        'rule': {
          'file': 12345,
          'citation': 99999,
          'expression': true,
          'line': '42',
          'col': '10',
        },
        'reasons': [100, 200, false],
      };

      final report = RulesDenialReport.fromMap(
        corruptPayload,
        errorMessage: 'Fallback error message',
      );

      expect(report.file, '12345');
      expect(report.citation, '99999');
      expect(report.expression, 'true');
      expect(report.line, 42);
      expect(report.col, 10);
      expect(report.reasons, ['100', '200', 'false']);
    });

    test('handles non-string auth uid, tenant, request method, path', () {
      final corruptPayload = <dynamic, dynamic>{
        'auth': {
          'uid': 88888,
          'tenant': true,
          'token': {
            'firebase': {'tenant': 777},
          },
        },
        'request': {
          'method': 1,
          'path': 2,
          'resourceData': {'title': 'New Title'},
        },
        'resource': {
          'data': {'title': 'Old Title'},
        },
      };

      final report = RulesDenialReport.fromMap(
        corruptPayload,
        errorMessage: 'Fallback error',
      );

      expect(report.authUid, '88888');
      expect(report.authTenant, '777');
      expect(report.requestMethod, '1');
      expect(report.requestPath, '2');
      expect(report.proposedData?['title'], 'New Title');
      expect(report.existingData?['title'], 'Old Title');
    });

    test('handles non-string map keys in auth token or resourceData', () {
      final nonStringKeyPayload = <dynamic, dynamic>{
        'rule': {'file': 'firestore.rules'},
        'auth': {
          'uid': 'user-1',
          'token': <dynamic, dynamic>{
            1: 'numeric_key_value',
            true: 'bool_key_value',
            'firebase': <dynamic, dynamic>{
              2: 'nested_numeric_key',
              'tenant': 'tenant-test',
            },
          },
        },
        'request': {
          'resourceData': <dynamic, dynamic>{
            42: 'forty-two',
            'nested': <dynamic, dynamic>{100: 'one-hundred'},
          },
        },
        'resource': {
          'data': <dynamic, dynamic>{
            0: 'zero_key',
          },
        },
        'query': <dynamic, dynamic>{
          99: 'query_val',
        },
      };

      final report = RulesDenialReport.fromMap(
        nonStringKeyPayload,
        errorMessage: 'Denied',
      );

      expect(report.authUid, 'user-1');
      expect(report.authTenant, 'tenant-test');
      expect(report.authClaims?['1'], 'numeric_key_value');
      expect(report.authClaims?['true'], 'bool_key_value');
      expect(report.proposedData?['42'], 'forty-two');
      expect(report.existingData?['0'], 'zero_key');
      expect(report.query?['99'], 'query_val');
    });

    test('handles completely empty payload and null fields gracefully', () {
      final report = RulesDenialReport.fromMap(
        <dynamic, dynamic>{},
        errorMessage: 'Empty context error',
      );

      expect(report.file, 'firestore.rules');
      expect(report.line, isNull);
      expect(report.col, isNull);
      expect(report.citation, 'firestore.rules');
      expect(report.expression, isNull);
      expect(report.reasons, ['Empty context error']);
      expect(report.authUid, isNull);
      expect(report.authTenant, isNull);
      expect(report.authClaims, isNull);
      expect(report.requestMethod, isNull);
      expect(report.requestPath, isNull);
      expect(report.proposedData, isNull);
      expect(report.existingData, isNull);
      expect(report.failedFields, isEmpty);
      expect(report.query, isNull);
      expect(report.errorMessage, 'Empty context error');
    });

    test('handles corrupt denialContext in PyricBridgeException', () {
      const ex = PyricBridgeException(
        code: 'permission-denied',
        message: 'Security rules rejected',
        denialContext: <dynamic, dynamic>{
          101: 'bad_root_key',
          'rule': {
            'file': 555,
            'line': '99',
          },
          'reasons': [null, 123, 'valid'],
        },
      );

      final report = RulesDenialReport.fromBridgeException(ex);
      expect(report, isNotNull);
      expect(report!.file, '555');
      expect(report.line, 99);
      expect(report.reasons, ['123', 'valid']);
      expect(report.errorMessage, 'Security rules rejected');
    });

    test('handles non-string types in SandboxUserRecord', () {
      final corruptUser = <dynamic, dynamic>{
        'uid': 12345,
        'email': 67890,
        'displayName': 111,
        'photoURL': 222,
        'tenantId': 333,
        'customClaims': <dynamic, dynamic>{
          1: 'one',
          'admin': true,
        },
      };

      final user = SandboxUserRecord.fromMap(corruptUser);
      expect(user.uid, '12345');
      expect(user.email, '67890');
      expect(user.displayName, '111');
      expect(user.photoURL, '222');
      expect(user.tenantId, '333');
      expect(user.customClaims['1'], 'one');
      expect(user.customClaims['admin'], true);
    });
  });
}
