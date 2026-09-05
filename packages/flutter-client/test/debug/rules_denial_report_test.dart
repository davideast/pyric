import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/src/transport/exceptions.dart';

void main() {
  group('RulesDenialReport & SandboxUserRecord Parsing Tests', () {
    test('parses canonical CEL denial context into RulesDenialReport', () {
      final rawContext = <String, dynamic>{
        'rule': {
          'file': 'firestore.rules',
          'line': 14,
          'col': 7,
          'citation': 'firestore.rules:14:7',
          'expression': 'allow read: if request.auth.uid == resource.data.ownerId;',
        },
        'reasons': [
          'Evaluation error: false',
          "request.auth.uid is 'alice'",
          "resource.data.ownerId is 'bob'",
        ],
        'auth': {
          'uid': 'alice',
          'token': {
            'email': 'alice@example.com',
            'firebase': {'tenant': 'tenant-saas'},
            'role': 'editor',
          },
        },
        'request': {
          'method': 'get',
          'path': 'databases/(default)/documents/posts/1',
          'resourceData': {
            'title': 'New Title',
            'ownerId': 'alice',
          },
        },
        'resource': {
          'exists': true,
          'data': {
            'title': 'Old Title',
            'ownerId': 'bob',
          },
        },
        'failedFields': ['ownerId'],
        'query': {
          'limit': 20,
        },
      };

      final report = RulesDenialReport.fromMap(rawContext, errorMessage: 'Permission denied');

      expect(report.file, 'firestore.rules');
      expect(report.line, 14);
      expect(report.col, 7);
      expect(report.citation, 'firestore.rules:14:7');
      expect(report.expression, 'allow read: if request.auth.uid == resource.data.ownerId;');
      expect(report.reasons.length, 3);
      expect(report.reasons[1], "request.auth.uid is 'alice'");
      expect(report.authUid, 'alice');
      expect(report.authTenant, 'tenant-saas');
      expect(report.authClaims?['role'], 'editor');
      expect(report.requestMethod, 'get');
      expect(report.requestPath, 'databases/(default)/documents/posts/1');
      expect(report.proposedData?['title'], 'New Title');
      expect(report.existingData?['ownerId'], 'bob');
      expect(report.failedFields, ['ownerId']);
      expect(report.query?['limit'], 20);
      expect(report.errorMessage, 'Permission denied');
    });

    test('falls back to file:line:col when citation is missing', () {
      final rawContext = <String, dynamic>{
        'rule': {
          'file': 'custom.rules',
          'line': 42,
          'col': 5,
          'expression': 'allow write: if false;',
        },
        'reasons': [],
      };

      final report = RulesDenialReport.fromMap(rawContext, errorMessage: 'Denied');

      expect(report.file, 'custom.rules');
      expect(report.line, 42);
      expect(report.col, 5);
      expect(report.citation, 'custom.rules:42:5');
      expect(report.expression, 'allow write: if false;');
      expect(report.reasons, ['Denied']);
    });

    test('extracts RulesDenialReport from PyricBridgeException', () {
      const ex = PyricBridgeException(
        code: 'permission-denied',
        message: 'Denied by rules',
        denialContext: {
          'rule': {
            'file': 'firestore.rules',
            'line': 10,
            'col': 2,
            'citation': 'firestore.rules:10:2',
          },
          'reasons': ['Rule denied'],
        },
      );

      final report = RulesDenialReport.fromBridgeException(ex);
      expect(report, isNotNull);
      expect(report?.citation, 'firestore.rules:10:2');
      expect(report?.errorMessage, 'Denied by rules');
    });

    test('parses SandboxUserRecord from wire dictionary', () {
      final wire = <String, dynamic>{
        'uid': 'user-42',
        'email': 'user42@example.com',
        'displayName': 'User Forty Two',
        'photoURL': 'https://example.com/photo.png',
        'tenantId': 'tenant-enterprise',
        'customClaims': {
          'admin': true,
          'role': 'lead',
        },
      };

      final record = SandboxUserRecord.fromMap(wire);
      expect(record.uid, 'user-42');
      expect(record.email, 'user42@example.com');
      expect(record.displayName, 'User Forty Two');
      expect(record.photoURL, 'https://example.com/photo.png');
      expect(record.tenantId, 'tenant-enterprise');
      expect(record.customClaims['admin'], true);
      expect(record.customClaims['role'], 'lead');
    });
  });
}
