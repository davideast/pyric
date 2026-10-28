import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/src/transport/exceptions.dart';

/// The envelope a denied sandbox RTDB write sends over the bridge, captured
/// by `packages/cli/scripts/capture-rtdb-denial-envelope.ts`.
Map<String, dynamic> _capturedEnvelope() {
  final file = File('test/fixtures/rtdb-denial-envelope.json');
  return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
}

void main() {
  group('RulesDenialReport for an RTDB denial', () {
    test('parses the engine and the RTDB rule fields from a captured envelope', () {
      final envelope = _capturedEnvelope();
      final report = RulesDenialReport.fromBridgeException(PyricBridgeException(
        code: envelope['code'] as String,
        message: envelope['message'] as String,
        denialContext: envelope['denialContext'],
      ))!;

      expect(report.engine, 'rtdb');
      expect(report.isRtdb, isTrue);
      expect(report.file, 'database.rules.json');
      expect(report.matchedPath, r'/rooms/$roomId');
      expect(report.matchedRule, "auth.uid == \$roomId || auth.token.role == 'editor'");
      expect(report.expression, report.matchedRule);
      expect(report.citation, r'database.rules.json /rooms/$roomId');
      expect(report.pathVariableBindings, {r'$roomId': 'bob'});
      expect(report.reason, contains('evaluated to false'));
      expect(report.errorCode, isNull);
      expect(report.requestMethod, 'set');
      expect(report.requestPath, '/rooms/bob/title');
      expect(report.proposedValue, {'text': 'Renamed', 'by': 'alice'});
      expect(report.proposedData, {'text': 'Renamed', 'by': 'alice'});
      expect(report.authUid, 'alice');
      expect(report.authTenant, 'tenant-a');
      expect(report.reasons, hasLength(1));
      expect(report.errorMessage, 'PERMISSION_DENIED: Permission denied');
    });

    test('a denial context without an engine is a Firestore denial', () {
      final report = RulesDenialReport.fromMap({'reasons': ['denied']});
      expect(report.engine, 'firestore');
      expect(report.isRtdb, isFalse);
      expect(report.file, 'firestore.rules');
      expect(report.matchedPath, isNull);
    });
  });
}
