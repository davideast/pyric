import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import '../auth/mock_bridge_helper.dart';

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricFirestorePlatform firestore;
  late PyricDebugController controller;
  late PyricDebugDiagnostics diagnostics;

  setUp(() async {
    setupMockFirebase();
    diagnostics = PyricDebugDiagnostics.instance;
    diagnostics.clear();

    harness = MockBridgeHarness();
    client = harness.createClient();

    // Auto-reply to attach
    harness.channel.toServerController.stream.listen((raw) {
      if (raw is String && raw.contains('"type":"attach"')) {
        harness.ackAttach(clientSessionId: 'sess-challenger2');
      }
    });

    auth = PyricFirebaseAuthPlatform(bridgeClient: client);
    firestore = PyricFirestorePlatform(
      bridgeClient: client,
      credentialsProvider: auth,
    );
    controller = PyricDebugController(
      authPlatform: auth,
      bridgeClient: client,
      diagnostics: diagnostics,
    );

    await client.connect();
    await pumpEventQueue();
  });

  tearDown(() async {
    diagnostics.clear();
    controller.dispose();
    await auth.dispose();
    await firestore.terminate();
    await harness.dispose();
  });

  group('Challenger 2: Normal Firestore Denial Flow & RulesDenialReport Fidelity', () {
    test('doc get denial flow populates RulesDenialReport accurately without data loss', () async {
      final docRef = firestore.doc('organizations/org-1/records/rec-99');
      final future = docRef.get();
      await pumpEventQueue();

      final op = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'getDoc',
      );
      final opId = op['id'] as String;

      final canonicalDenialContext = <String, dynamic>{
        'rule': {
          'file': 'firestore.rules',
          'line': 45,
          'col': 12,
          'citation': 'firestore.rules:45:12',
          'expression': 'allow read: if request.auth.token.firebase.tenant == resource.data.tenantId;',
        },
        'reasons': [
          'CEL condition evaluated to false',
          'request.auth.token.firebase.tenant is "tenant-alpha"',
          'resource.data.tenantId is "tenant-beta"'
        ],
        'auth': {
          'uid': 'user-123',
          'token': {
            'email': 'user@example.com',
            'roles': ['editor', 'viewer'],
            'firebase': {'tenant': 'tenant-alpha'},
          },
        },
        'request': {
          'method': 'get',
          'path': 'databases/(default)/documents/organizations/org-1/records/rec-99',
          'resourceData': null,
        },
        'resource': {
          'exists': true,
          'data': {
            'tenantId': 'tenant-beta',
            'amount': 450.75,
            'tags': ['confidential', 'financial'],
            'metadata': {'createdBy': 'user-456', 'version': 3}
          },
        },
        'failedFields': ['tenantId'],
        'query': null,
      };

      harness.sendToClient({
        'type': 'worker-res',
        'id': opId,
        'ok': false,
        'error': {
          'code': 'permission-denied',
          'message': 'Missing or insufficient permissions.',
          'denialContext': canonicalDenialContext,
        },
      });

      // Expect operation to fail with PyricBridgeException
      expect(future, throwsA(isA<PyricBridgeException>()));
      await pumpEventQueue();

      // Verify diagnostics history
      expect(diagnostics.history.length, equals(1));
      final report = diagnostics.history.first;

      // Verify full field fidelity without data loss
      expect(report.file, equals('firestore.rules'));
      expect(report.line, equals(45));
      expect(report.col, equals(12));
      expect(report.citation, equals('firestore.rules:45:12'));
      expect(
        report.expression,
        equals('allow read: if request.auth.token.firebase.tenant == resource.data.tenantId;'),
      );
      expect(report.reasons, equals([
        'CEL condition evaluated to false',
        'request.auth.token.firebase.tenant is "tenant-alpha"',
        'resource.data.tenantId is "tenant-beta"'
      ]));
      expect(report.authUid, equals('user-123'));
      expect(report.authTenant, equals('tenant-alpha'));
      expect(report.authClaims?['email'], equals('user@example.com'));
      expect(report.authClaims?['roles'], equals(['editor', 'viewer']));
      expect(report.requestMethod, equals('get'));
      expect(
        report.requestPath,
        equals('databases/(default)/documents/organizations/org-1/records/rec-99'),
      );
      expect(report.proposedData, isNull);
      expect(report.existingData?['tenantId'], equals('tenant-beta'));
      expect(report.existingData?['amount'], equals(450.75));
      expect(report.existingData?['tags'], equals(['confidential', 'financial']));
      expect(report.existingData?['metadata'], equals({'createdBy': 'user-456', 'version': 3}));
      expect(report.failedFields, equals(['tenantId']));
      expect(report.query, isNull);
      expect(report.errorMessage, equals('Missing or insufficient permissions.'));

      // Verify controller synchronized the report
      expect(controller.denials.length, equals(1));
      expect(controller.latestDenial, equals(report));
    });

    test('doc set denial flow preserves proposed write data without corruption', () async {
      final docRef = firestore.doc('configs/settings');
      final future = docRef.set({
        'title': 'New Article',
        'draft': true,
        'nested': {'count': 10},
      });
      await pumpEventQueue();

      final op = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'setDoc',
      );
      final opId = op['id'] as String;

      harness.sendToClient({
        'type': 'worker-res',
        'id': opId,
        'ok': false,
        'error': {
          'code': 'permission-denied',
          'message': 'Write forbidden by rule',
          'denialContext': {
            'rule': {
              'file': 'firestore.rules',
              'line': 80,
              'col': 4,
              'expression': 'allow write: if false;',
            },
            'reasons': ['Explicit deny'],
            'request': {
              'method': 'create',
              'path': 'databases/(default)/documents/configs/settings',
              'resourceData': {
                'title': 'New Article',
                'draft': true,
                'nested': {'count': 10},
              },
            },
          },
        },
      });

      expect(future, throwsA(isA<PyricBridgeException>()));
      await pumpEventQueue();

      expect(diagnostics.history.length, equals(1));
      final report = diagnostics.history.first;

      expect(report.requestMethod, equals('create'));
      expect(report.proposedData?['title'], equals('New Article'));
      expect(report.proposedData?['draft'], isTrue);
      expect(report.proposedData?['nested'], equals({'count': 10}));
      expect(report.citation, equals('firestore.rules:80:4'));
      expect(report.expression, equals('allow write: if false;'));
    });

    test('snapshots real-time stream denial flow emits error and populates report', () async {
      final docRef = firestore.doc('vault/classified');
      Object? streamError;
      final sub = docRef.snapshots(listenSource: ListenSource.defaultSource).listen(
        (_) {},
        onError: (err) {
          streamError = err;
        },
      );
      await pumpEventQueue();

      final subFrame = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      final subId = subFrame['subId'] as String;

      // Simulate terminal snapshot rejection from bridge
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': subId,
        'value': {
          '__error': {
            'code': 'permission-denied',
            'message': 'Real-time subscription denied.',
            'denialContext': {
              'rule': {
                'file': 'vault.rules',
                'line': 12,
                'col': 8,
                'citation': 'vault.rules:12:8',
                'expression': 'allow read: if request.auth != null;',
              },
              'reasons': ['Unauthenticated listener'],
              'auth': null,
            },
          },
        },
      });
      await pumpEventQueue();

      expect(streamError, isA<PyricBridgeException>());
      expect(diagnostics.history.length, equals(1));
      final report = diagnostics.history.first;
      expect(report.file, equals('vault.rules'));
      expect(report.line, equals(12));
      expect(report.col, equals(8));
      expect(report.citation, equals('vault.rules:12:8'));
      expect(report.expression, equals('allow read: if request.auth != null;'));
      expect(report.reasons, equals(['Unauthenticated listener']));
      expect(report.errorMessage, equals('Real-time subscription denied.'));

      await sub.cancel();
    });

    test('query denial flow preserves structured query filters and parameters', () async {
      final queryRef = firestore.collection('audit_logs');
      final future = queryRef.get();
      await pumpEventQueue();

      final op = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'getDocs',
      );
      final opId = op['id'] as String;

      harness.sendToClient({
        'type': 'worker-res',
        'id': opId,
        'ok': false,
        'error': {
          'code': 'permission-denied',
          'message': 'Query denied',
          'denialContext': {
            'rule': {
              'citation': 'audit.rules:5:2',
              'expression': 'allow list: if request.auth.token.admin == true;',
            },
            'query': {
              'collection': 'audit_logs',
              'limit': 50,
              'orderBy': [{'field': 'timestamp', 'direction': 'desc'}],
            },
          },
        },
      });

      expect(future, throwsA(isA<PyricBridgeException>()));
      await pumpEventQueue();

      expect(diagnostics.history.length, equals(1));
      final report = diagnostics.history.first;
      expect(report.citation, equals('audit.rules:5:2'));
      expect(report.query?['collection'], equals('audit_logs'));
      expect(report.query?['limit'], equals(50));
      expect(report.query?['orderBy'], equals([{'field': 'timestamp', 'direction': 'desc'}]));
    });
  });
}
