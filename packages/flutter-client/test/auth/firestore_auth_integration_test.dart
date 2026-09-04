import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import 'mock_bridge_helper.dart';

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricFirestorePlatform firestore;

  setUp(() async {
    setupMockFirebase();
    harness = MockBridgeHarness();
    client = harness.createClient();
    auth = PyricFirebaseAuthPlatform(bridgeClient: client);
    firestore = PyricFirestorePlatform(
      bridgeClient: client,
      credentialsProvider: auth,
    );

    // Complete attach handshake
    final connectFuture = client.connect();
    await Future<void>.delayed(Duration.zero);
    harness.ackAttach(clientSessionId: 'sess-integration-1');
    await connectFuture;
  });

  tearDown(() async {
    await auth.dispose();
    await firestore.terminate();
    await harness.dispose();
  });

  group('Firestore Auth Integration: Unauthenticated Operations', () {
    test('doc get stamps actAs: anon when unauthenticated', () async {
      final docRef = firestore.doc('users/alice');
      final future = docRef.get();

      await pumpEventQueue();
      final op = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'getDoc',
      );
      expect(op['op']['actAs'], equals({'mode': 'anon'}));

      harness.sendToClient({
        'type': 'worker-res',
        'id': op['id'],
        'ok': true,
        'value': {'exists': true, 'data': {'name': 'Alice'}},
      });

      final snap = await future;
      expect(snap.exists, isTrue);
      expect(snap.data(), equals({'name': 'Alice'}));
    });

    test('doc set stamps actAs: anon when unauthenticated', () async {
      final docRef = firestore.doc('users/alice');
      final future = docRef.set({'name': 'Alice'});

      await pumpEventQueue();
      final op = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'setDoc',
      );
      expect(op['op']['actAs'], equals({'mode': 'anon'}));

      harness.sendToClient({
        'type': 'worker-res',
        'id': op['id'],
        'ok': true,
        'value': null,
      });

      await future;
    });

    test('query get and aggregations stamp actAs: anon', () async {
      final query = firestore.collection('users');
      final future = query.get();

      await pumpEventQueue();
      final op = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'getDocs',
      );
      expect(op['op']['actAs'], equals({'mode': 'anon'}));

      harness.sendToClient({
        'type': 'worker-res',
        'id': op['id'],
        'ok': true,
        'value': {'docs': []},
      });

      final snap = await future;
      expect(snap.docs, isEmpty);

      // Count
      final countFuture = query.count().get(source: AggregateSource.server);
      await pumpEventQueue();
      final countOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'count',
      );
      expect(countOp['op']['actAs'], equals({'mode': 'anon'}));

      harness.sendToClient({
        'type': 'worker-res',
        'id': countOp['id'],
        'ok': true,
        'value': {'count': 42},
      });
      final countSnap = await countFuture;
      expect(countSnap.count, equals(42));
    });

    test('batch commit and transaction commit stamp actAs: anon', () async {
      // Write batch
      final batch = firestore.batch();
      batch.set('users/alice', {'score': 100});
      final batchFuture = batch.commit();

      await pumpEventQueue();
      final batchOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'batchCommit',
      );
      expect(batchOp['op']['actAs'], equals({'mode': 'anon'}));

      harness.sendToClient({
        'type': 'worker-res',
        'id': batchOp['id'],
        'ok': true,
        'value': null,
      });
      await batchFuture;

      // Transaction
      final txnFuture = firestore.runTransaction((txn) async {
        txn.set('users/alice', {'score': 200});
      });

      await pumpEventQueue();
      final txnOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'txnCommit',
      );
      expect(txnOp['op']['actAs'], equals({'mode': 'anon'}));

      harness.sendToClient({
        'type': 'worker-res',
        'id': txnOp['id'],
        'ok': true,
        'value': null,
      });
      await txnFuture;
    });
  });

  group('Firestore Auth Integration: Authenticated Operations', () {
    setUp(() async {
      // Sign in as Alice with tenant
      final signInFuture =
          auth.signInWithEmailAndPassword('alice@corp.com', 'pwd');
      await pumpEventQueue();
      final signInOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {
          'user': {
            'uid': 'alice-corp-123',
            'email': 'alice@corp.com',
            'tenantId': 'tenant-megacorp',
          }
        },
      });
      await signInFuture;
    });

    test('doc operations stamp actAs with user uid and tenant', () async {
      final docRef = firestore.doc('secrets/doc1');
      final future = docRef.get();

      await pumpEventQueue();
      final op = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'getDoc',
      );
      expect(
        op['op']['actAs'],
        equals({
          'mode': 'as',
          'uid': 'alice-corp-123',
          'tenant': 'tenant-megacorp',
        }),
      );

      harness.sendToClient({
        'type': 'worker-res',
        'id': op['id'],
        'ok': true,
        'value': {'exists': true, 'data': {'secret': 'xyz'}},
      });

      final snap = await future;
      expect(snap.data(), equals({'secret': 'xyz'}));
    });

    test('batch and transaction operations stamp authenticated actAs',
        () async {
      final batch = firestore.batch();
      batch.delete('secrets/doc1');
      final batchFuture = batch.commit();

      await pumpEventQueue();
      final batchOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'batchCommit',
      );
      expect(
        batchOp['op']['actAs'],
        equals({
          'mode': 'as',
          'uid': 'alice-corp-123',
          'tenant': 'tenant-megacorp',
        }),
      );

      harness.sendToClient({
        'type': 'worker-res',
        'id': batchOp['id'],
        'ok': true,
        'value': null,
      });
      await batchFuture;
    });
  });

  group('Firestore Auth Integration: Snapshot Re-subscription', () {
    test('re-subscribes active snapshots on sign-in and sign-out', () async {
      final docRef = firestore.doc('users/alice');
      final snapshots = <DocumentSnapshotPlatform>[];
      final sub = docRef
          .snapshots(listenSource: ListenSource.defaultSource)
          .listen(snapshots.add);

      // Initial subscription while signed out
      await pumpEventQueue();
      final initialSubFrame = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-sub',
      );
      final initialSubId = initialSubFrame['subId'] as String;
      expect(initialSubFrame['sub']['actAs'], equals({'mode': 'anon'}));

      // Deliver initial snapshot
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': initialSubId,
        'value': {'exists': true, 'data': {'status': 'guest'}},
      });
      await pumpEventQueue();
      expect(snapshots.length, equals(1));
      expect(snapshots.first.data(), equals({'status': 'guest'}));

      // Sign in as Alice
      final signInFuture =
          auth.signInWithEmailAndPassword('alice@example.com', 'pwd');
      await pumpEventQueue();
      final signInOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {
          'user': {
            'uid': 'alice-uid',
            'email': 'alice@example.com',
          }
        },
      });
      await signInFuture;
      await pumpEventQueue();

      // Verify un-sub was sent for initial subId
      final unsubFrame = harness.sentMessages.firstWhere(
        (m) => m['type'] == 'worker-unsub' && m['subId'] == initialSubId,
      );
      expect(unsubFrame, isNotNull);

      // Verify new sub was sent with actAs: asUser
      final authenticatedSubFrame = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-sub' && m['subId'] != initialSubId,
      );
      final authenticatedSubId = authenticatedSubFrame['subId'] as String;
      expect(
        authenticatedSubFrame['sub']['actAs'],
        equals({'mode': 'as', 'uid': 'alice-uid'}),
      );

      // Deliver updated snapshot under authenticated identity
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': authenticatedSubId,
        'value': {'exists': true, 'data': {'status': 'authenticated'}},
      });
      await pumpEventQueue();
      expect(snapshots.length, equals(2));
      expect(snapshots.last.data(), equals({'status': 'authenticated'}));

      // Sign out
      final signOutFuture = auth.signOut();
      await pumpEventQueue();
      final signOutOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signOut',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signOutOp['id'],
        'ok': true,
        'value': null,
      });
      await signOutFuture;
      await pumpEventQueue();

      // Verify un-sub was sent for authenticatedSubId
      expect(
        harness.sentMessages.any((m) =>
            m['type'] == 'worker-unsub' && m['subId'] == authenticatedSubId),
        isTrue,
      );

      // Verify new sub was sent with actAs: anon
      final signedOutSubFrame = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-sub' &&
            m['subId'] != initialSubId &&
            m['subId'] != authenticatedSubId,
      );
      expect(signedOutSubFrame['sub']['actAs'], equals({'mode': 'anon'}));

      await sub.cancel();
    });

    test('surfaces Security Rules denial on auth transition error snapshot',
        () async {
      // Start signed in
      final signInFuture =
          auth.signInWithEmailAndPassword('alice@example.com', 'pwd');
      await pumpEventQueue();
      final signInOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {
          'user': {'uid': 'alice-uid', 'email': 'alice@example.com'}
        },
      });
      await signInFuture;
      await pumpEventQueue();

      // Listen to protected doc
      final docRef = firestore.doc('protected/doc1');
      dynamic receivedError;
      final sub = docRef
          .snapshots(listenSource: ListenSource.defaultSource)
          .listen(
            (_) {},
            onError: (err) => receivedError = err,
          );

      await pumpEventQueue();
      final subFrame = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-sub',
      );
      final subId = subFrame['subId'] as String;

      // Initial snap allowed
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': subId,
        'value': {'exists': true, 'data': {'secret': 'classified'}},
      });
      await pumpEventQueue();

      // Sign out
      final signOutFuture = auth.signOut();
      await pumpEventQueue();
      final signOutOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signOut',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signOutOp['id'],
        'ok': true,
        'value': null,
      });
      await signOutFuture;
      await pumpEventQueue();

      // Server rejects anonymous re-subscription with permission-denied
      final anonSubFrame = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-sub' && m['subId'] != subId,
      );
      final anonSubId = anonSubFrame['subId'] as String;

      harness.sendToClient({
        'type': 'worker-snap',
        'subId': anonSubId,
        'value': {
          '__error': {
            'code': 'permission-denied',
            'message': 'Missing or insufficient permissions.',
          }
        },
      });
      await pumpEventQueue();

      expect(receivedError, isNotNull);
      expect(receivedError, isA<PyricBridgeException>());
      expect(
        (receivedError as PyricBridgeException).code,
        equals('permission-denied'),
      );

      await sub.cancel();
    });

    test('propagates custom claims to actAs in document operations', () async {
      // Sign in with custom claims
      final signInFuture =
          auth.signInWithEmailAndPassword('claims@corp.com', 'pwd');
      await pumpEventQueue();
      final signInOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {
          'user': {
            'uid': 'claims-user-1',
            'email': 'claims@corp.com',
            'tenantId': 'tenant-claims',
          },
          'claims': {'role': 'admin', 'tier': 'enterprise'},
        },
      });
      await signInFuture;
      await pumpEventQueue();

      final docRef = firestore.doc('projects/alpha');
      final future = docRef.get();
      await pumpEventQueue();

      final op = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'getDoc',
      );
      expect(
        op['op']['actAs'],
        equals({
          'mode': 'as',
          'uid': 'claims-user-1',
          'tenant': 'tenant-claims',
          'token': {'role': 'admin', 'tier': 'enterprise'},
        }),
      );

      harness.sendToClient({
        'type': 'worker-res',
        'id': op['id'],
        'ok': true,
        'value': {'exists': true, 'data': {'title': 'Alpha'}},
      });
      final snap = await future;
      expect(snap.data(), equals({'title': 'Alpha'}));
    });

    test('re-subscribes snapshot stream when ID token refreshes with new claims', () async {
      // Sign in with initial claims
      final signInFuture =
          auth.signInWithEmailAndPassword('user@corp.com', 'pwd');
      await pumpEventQueue();
      final signInOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.signInEmail',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signInOp['id'],
        'ok': true,
        'value': {
          'user': {
            'uid': 'token-refresh-user',
            'email': 'user@corp.com',
          },
          'claims': {'tier': 'basic'},
        },
      });
      await signInFuture;
      await pumpEventQueue();

      // Listen to snapshots
      final docRef = firestore.doc('configs/feature-flags');
      final snapshots = <DocumentSnapshotPlatform>[];
      final sub = docRef
          .snapshots(listenSource: ListenSource.defaultSource)
          .listen(snapshots.add);

      await pumpEventQueue();
      final initialSubFrame = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-sub',
      );
      final initialSubId = initialSubFrame['subId'] as String;
      expect(
        initialSubFrame['sub']['actAs'],
        equals({
          'mode': 'as',
          'uid': 'token-refresh-user',
          'token': {'tier': 'basic'},
        }),
      );

      // Refresh ID token with escalated claims
      final tokenResultFuture = auth.currentUser!.getIdTokenResult(true);
      await pumpEventQueue();
      final tokenOp = harness.sentMessages.lastWhere(
        (m) =>
            m['type'] == 'worker-op' &&
            m['op']?['method'] == 'auth.getIdTokenResult',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': tokenOp['id'],
        'ok': true,
        'value': {
          'token': 'escalated-jwt',
          'claims': {'tier': 'pro', 'betaFeatures': true},
          'expirationTime': '2026-09-04T18:00:00Z',
          'authTime': '2026-09-04T16:00:00Z',
          'issuedAtTime': '2026-09-04T17:00:00Z',
        },
      });
      await tokenResultFuture;
      await pumpEventQueue();

      // Verify un-sub was sent for initial subId
      expect(
        harness.sentMessages.any((m) =>
            m['type'] == 'worker-unsub' && m['subId'] == initialSubId),
        isTrue,
      );

      // Verify new sub was sent with updated claims in actAs
      final refreshedSubFrame = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-sub' && m['subId'] != initialSubId,
      );
      expect(
        refreshedSubFrame['sub']['actAs'],
        equals({
          'mode': 'as',
          'uid': 'token-refresh-user',
          'token': {'tier': 'pro', 'betaFeatures': true},
        }),
      );

      await sub.cancel();
    });
  });
}
