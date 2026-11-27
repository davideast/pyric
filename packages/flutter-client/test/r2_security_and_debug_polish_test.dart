import 'dart:async';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/pyric_firestore.dart'
    hide AuthLens, PyricAuthCredentialsProvider;
import 'package:pyric_firestore/src/platform/mutation_serialization.dart';
import 'package:pyric_firestore/src/platform/pyric_offline_projection.dart';

import 'auth/mock_bridge_helper.dart';

void _replyListUsers(
  MockBridgeHarness harness,
  List<Map<String, dynamic>> users,
) {
  for (final msg in harness.sentMessages.where(
    (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.listUsers',
  )) {
    harness.sendToClient({
      'type': 'worker-res',
      'id': msg['id'],
      'ok': true,
      'value': {'users': users},
    });
  }
}

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricFirestorePlatform firestore;

  setUp(() async {
    setupMockFirebase();
    PyricDebugDiagnostics.instance.clear();
    harness = MockBridgeHarness();
    client = harness.createClient();
    harness.channel.toServerController.stream.listen((raw) {
      if (raw is String && raw.contains('"type":"attach"')) {
        harness.ackAttach(clientSessionId: 'sess-r2-polish-1');
      }
    });
    auth = PyricFirebaseAuthPlatform(bridgeClient: client);
    firestore = PyricFirestorePlatform(
      bridgeClient: client,
      credentialsProvider: auth,
    );
    await client.connect();
    await pumpEventQueue();
  });

  tearDown(() async {
    PyricDebugDiagnostics.instance.clear();
    await firestore.terminate();
    await firestore.clearPersistence();
    await auth.dispose();
    await harness.dispose();
  });

  group('C1-09 offline staged write cross-user replay isolation', () {
    test('aborts Alice offline staged writes after switching to Bob before enableNetwork', () async {
      auth.switchAuthLens(AuthLens.asUser(uid: 'alice-uid'));
      await firestore.disableNetwork();

      final docRef = firestore.doc('playlists/pl-alice-commute');
      final stagedSet = docRef.set({'title': 'Alice Offline Edit'});
      final batch = firestore.batch();
      batch.set('playlists/pl-alice-batch', {'title': 'Alice Batch'});
      final stagedBatch = batch.commit();

      Object? setError;
      Object? batchError;
      unawaited(stagedSet.catchError((Object e) {
        setError = e;
      }));
      unawaited(stagedBatch.catchError((Object e) {
        batchError = e;
      }));

      // Switch active user to Bob before network comes back online.
      auth.switchAuthLens(AuthLens.asUser(uid: 'bob-uid'));
      await firestore.enableNetwork();
      await pumpEventQueue();

      expect(setError, isA<PyricBridgeException>());
      expect((setError as PyricBridgeException).code, equals('permission-denied'));
      expect(batchError, isA<PyricBridgeException>());
      expect((batchError as PyricBridgeException).code, equals('permission-denied'));

      final sentWrites = harness.sentMessages.where((f) {
        final method = f['op']?['method'];
        return f['type'] == 'worker-op' &&
            (method == 'setDoc' || method == 'batchCommit');
      }).toList();
      expect(sentWrites, isEmpty);
    });
  });

  group('C1-05 SetOptions(mergeFields) literal dot escaping', () {
    test('backtick-escapes literal dots, backticks, and backslashes and round-trips offline projection', () {
      final options = SetOptions(
        mergeFields: [
          FieldPath(const ['meta', 'v1.0']),
          FieldPath(const ['plain']),
          FieldPath(const [r'a`b\c']),
        ],
      );
      final wire = serializeSetOptions(options)!;
      expect(
        wire['mergeFields'],
        equals(['meta.`v1.0`', 'plain', r'`a\`b\\c`']),
      );
      expect(decodeFieldPathKeySegments('meta.`v1.0`'), equals(['meta', 'v1.0']));
      expect(decodeFieldPathKeySegments(r'`a\`b\\c`'), equals([r'a`b\c']));

      final projected = FirestoreOfflineProjection.projectDocument(
        path: 'docs/d1',
        baseRecord: const CachedFirestoreDoc(
          exists: true,
          encodedFields: <String, dynamic>{
            'meta': <String, dynamic>{'v1.0': 'old', 'keep': true},
            'untouched': 1,
          },
        ),
        stagedBatches: [
          [
            OfflineFirestoreMutation.set(
              'docs/d1',
              <String, dynamic>{
                'meta': <String, dynamic>{'v1.0': 'new', 'keep': false},
                'untouched': 999,
              },
              options: wire,
            ),
          ],
        ],
      );
      final data = projected.wirePayload['data'] as Map<String, dynamic>;
      expect((data['meta'] as Map)['v1.0'], equals('new'));
      expect((data['meta'] as Map)['keep'], isTrue);
      expect(data['untouched'], equals(1));
    });
  });

  group('C1-01 photoUrl casing & C1-07/C1-08 debug UI polish', () {
    test('SandboxUserRecord.fromMap reads lowercase wire photoUrl as well as photoURL', () {
      final fromWire = SandboxUserRecord.fromMap({
        'uid': 'alice-uid',
        'email': 'alice@example.com',
        'photoUrl': 'https://example.com/alice.png',
        'emailVerified': true,
      });
      expect(fromWire.photoURL, equals('https://example.com/alice.png'));
      expect(fromWire.emailVerified, isTrue);

      final fromCamel = SandboxUserRecord.fromMap({
        'uid': 'bob-uid',
        'photoURL': 'https://example.com/bob.png',
      });
      expect(fromCamel.photoURL, equals('https://example.com/bob.png'));
    });

    test('RulesDenialReport.fromMap preserves queryProof and repro payloads', () {
      final report = RulesDenialReport.fromMap({
        'rule': {'file': 'firestore.rules', 'line': 12},
        'queryProof': {'verdict': 'unbounded', 'missingConstraint': 'ownerId'},
        'repro': {'command': 'pyric rules test --path playlists'},
      });
      expect(report.queryProof?['verdict'], equals('unbounded'));
      expect(report.repro?['command'], equals('pyric rules test --path playlists'));
    });

    test('PyricDebugController clears denials on anon -> signed-in auth transition', () async {
      final diagnostics = PyricDebugDiagnostics.instance;
      final controller = PyricDebugController(
        authPlatform: auth,
        bridgeClient: client,
        diagnostics: diagnostics,
      );
      await pumpEventQueue();
      _replyListUsers(harness, const []);

      diagnostics.recordDenial(RulesDenialReport(
        citation: 'firestore.rules:10',
        reasons: const ['Anon denied'],
      ));
      await pumpEventQueue();
      expect(controller.denials.length, equals(1));

      final signInFuture = auth.signInWithEmailAndPassword(
        'alice@example.com',
        'secret123',
      );
      await pumpEventQueue();
      final signInFrame = harness.sentMessages.lastWhere(
        (f) => f['type'] == 'worker-op' && f['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInFrame['id'],
        'ok': true,
        'value': {
          'user': {'uid': 'alice-uid', 'email': 'alice@example.com'},
        },
      });
      await signInFuture;
      await pumpEventQueue();
      _replyListUsers(harness, const []);

      expect(controller.denials, isEmpty);
      controller.dispose();
    });

    testWidgets('PyricDebugOverlay handles child == null, uses ModalBarrier + tooltips, updates header on swipe, and targets resource owner', (tester) async {
      final diagnostics = PyricDebugDiagnostics.instance;
      final controller = PyricDebugController(
        authPlatform: auth,
        bridgeClient: client,
        diagnostics: diagnostics,
      );

      diagnostics.recordDenial(RulesDenialReport(
        citation: 'firestore.rules:123:45-very-long-citation-segment-for-overflow-check',
        authUid: 'bob-uid',
        existingData: const {'ownerId': 'alice-uid', 'title': 'Secret'},
        reasons: const ['Only owner may read'],
      ));

      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData.dark(),
          builder: (context, child) => PyricDebugOverlay(
            controller: controller,
            child: child,
          ),
          home: const SizedBox.shrink(),
        ),
      );
      _replyListUsers(harness, const [
        {
          'uid': 'alice-uid',
          'email': 'alice@example.com',
          'photoUrl': 'https://example.com/alice.png',
          'emailVerified': true,
        },
      ]);
      await tester.pumpAndSettle();

      await tester.tap(find.text('ANONYMOUS'));
      await tester.pumpAndSettle();
      _replyListUsers(harness, const [
        {
          'uid': 'alice-uid',
          'email': 'alice@example.com',
          'photoUrl': 'https://example.com/alice.png',
          'emailVerified': true,
        },
      ]);
      await tester.pumpAndSettle();

      expect(find.byType(ModalBarrier), findsAtLeastNWidgets(1));
      expect(find.byType(BlockSemantics), findsAtLeastNWidgets(1));
      expect(find.byTooltip('Refresh users'), findsOneWidget);
      expect(find.byTooltip('Close'), findsOneWidget);

      await tester.fling(find.byType(TabBarView), const Offset(-500, 0), 1000);
      await tester.pumpAndSettle();
      expect(find.text('Clear'), findsOneWidget);

      expect(find.text('Impersonate alice-uid'), findsOneWidget);
      expect(find.text('Impersonate bob-uid'), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: MediaQuery(
            data: const MediaQueryData(size: Size(400, 800)),
            child: PyricDebugOverlay(controller: controller),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      controller.dispose();
    });
  });
}
