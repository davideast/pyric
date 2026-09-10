import 'dart:convert';

// ignore: depend_on_referenced_packages
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import 'conformance_harness.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ConformanceMockHarness harness;

  setUpAll(() async {
    FirebasePlatform.instance = MockFirebasePlatform();
    await Firebase.initializeApp();
  });

  setUp(() async {
    harness = ConformanceMockHarness();
    await harness.client.connect();
    PyricFirestorePlatform.registerWith(bridgeClient: harness.client);
  });

  tearDown(() async {
    await harness.dispose();
  });

  // ── 1. FirebaseFirestorePlatform: Instance & Lifecycle ───────────────────
  group('1. FirebaseFirestorePlatform: Instance & Lifecycle', () {
    test('firestore-flutter#1: FirebaseFirestorePlatform.instance returns default platform', () {
      expect(FirebaseFirestorePlatform.instance, isA<PyricFirestorePlatform>());
    });

    test('firestore-flutter#2: FirebaseFirestorePlatform.instanceFor(app, databaseId) provides isolated platform instances', () async {
      final customApp = await Firebase.initializeApp(
        name: 'custom-app',
        options: const FirebaseOptions(
          apiKey: 'key',
          appId: 'id',
          messagingSenderId: 'sender',
          projectId: 'project',
        ),
      );
      final instance = PyricFirestorePlatform(
        app: customApp,
        databaseId: 'custom-db',
        bridgeClient: harness.client,
      );
      expect(instance.databaseId, 'custom-db');
      expect(instance.app.name, 'custom-app');
    });

    test('firestore-flutter#3: FirebaseFirestorePlatform.settings sets client Settings', () {
      harness.firestore.settings = const Settings(
        persistenceEnabled: false,
        sslEnabled: false,
        host: 'localhost:8080',
      );
      expect(harness.firestore.settings.host, 'localhost:8080');
      expect(harness.firestore.settings.persistenceEnabled, false);
    });

    test('firestore-flutter#4: FirebaseFirestorePlatform.collection(path) returns CollectionReferencePlatform', () {
      final ref = harness.firestore.collection('users');
      expect(ref, isA<CollectionReferencePlatform>());
      expect(ref.path, 'users');
      expect(ref.id, 'users');
    });

    test('firestore-flutter#5: FirebaseFirestorePlatform.doc(path) returns DocumentReferencePlatform', () {
      final ref = harness.firestore.doc('users/alice');
      expect(ref, isA<DocumentReferencePlatform>());
      expect(ref.path, 'users/alice');
      expect(ref.id, 'alice');
    });

    test('firestore-flutter#6: FirebaseFirestorePlatform.collectionGroup(id) returns QueryPlatform across collections', () {
      final q = harness.firestore.collectionGroup('landmarks') as PyricQuery;
      expect(q.compileTarget()['__ref'], 'group');
      expect(q.path, 'landmarks');
    });

    test('firestore-flutter#7: FirebaseFirestorePlatform.batch() creates WriteBatchPlatform for atomic writes', () {
      final b = harness.firestore.batch();
      expect(b, isA<WriteBatchPlatform>());
    });

    test('firestore-flutter#8: FirebaseFirestorePlatform.runTransaction runs interactive transaction with retries', () async {
      final result = await harness.firestore.runTransaction((txn) async {
        final snap = await txn.get('users/alice');
        expect(snap.exists, true);
        txn.update('users/alice', {FieldPath(const ['age']): 31});
        return 'success';
      });
      expect(result, 'success');
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'txnCommit');
    });

    test('firestore-flutter#9: FirebaseFirestorePlatform.clearPersistence() clears offline client cache', () {
      expectUnverified('Red at birth: firestore-flutter#9 not yet implemented in prototype platform');
    });

    test('firestore-flutter#10: FirebaseFirestorePlatform enableNetwork/disableNetwork toggles connectivity', () {
      expectUnverified('Red at birth: firestore-flutter#10 not yet implemented in prototype platform');
    });

    test('firestore-flutter#11: FirebaseFirestorePlatform.terminate() terminates client and unsubscribes active streams', () async {
      await harness.firestore.terminate();
      expect(harness.client.isDisposed, true);
    });

    test('firestore-flutter#12: FirebaseFirestorePlatform.waitForPendingWrites() resolves when local writes are committed', () {
      expectUnverified('Red at birth: firestore-flutter#12 not yet implemented in prototype platform');
    });

    test('firestore-flutter#13: FirebaseFirestorePlatform.snapshotsInSync() emits when listeners catch up', () {
      expectUnverified('Red at birth: firestore-flutter#13 not yet implemented in prototype platform');
    });
  });

  // ── 2. DocumentReferencePlatform: Document Operations ────────────────────
  group('2. DocumentReferencePlatform: Document Operations', () {
    test('firestore-flutter#14: DocumentReferencePlatform.get(options) reads a single document snapshot', () async {
      final snap = await harness.firestore.doc('users/alice').get();
      expect(snap.exists, true);
      expect(snap.id, 'alice');
      expect(snap.reference.path, 'users/alice');
      expect(snap.data(), {'name': 'Alice', 'age': 30});
    });

    test('firestore-flutter#15: DocumentReferencePlatform.set(data) overwrites target document completely', () async {
      await harness.firestore.doc('users/alice').set({'name': 'Alice', 'age': 30});
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'setDoc');
      expect(op['path'], 'users/alice');
      expect(op['data'], {'name': 'Alice', 'age': 30});
    });

    test('firestore-flutter#16: DocumentReferencePlatform.set(data, SetOptions(merge: true)) merges payload fields', () async {
      await harness.firestore.doc('users/alice').set(
        {'age': 31},
        SetOptions(merge: true),
      );
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'setDoc');
      expect(op['options'], {'merge': true});
    });

    test('firestore-flutter#17: DocumentReferencePlatform.set(data, SetOptions(mergeFields: ...)) merges specified fields', () async {
      await harness.firestore.doc('users/alice').set(
        {'age': 31, 'extra': 'ignored'},
        SetOptions(mergeFields: [FieldPath(const ['age'])]),
      );
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'setDoc');
      expect(op['options'], {
        'mergeFields': ['age']
      });
    });

    test('firestore-flutter#18: DocumentReferencePlatform.update(data) updates nested fields via dot notation', () async {
      await harness.firestore.doc('users/alice').update({
        FieldPath(const ['profile', 'city']): 'SF',
      });
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'updateDoc');
      expect(op['path'], 'users/alice');
      expect(op['data'], {'profile.city': 'SF'});
    });

    test('firestore-flutter#19: DocumentReferencePlatform.delete() deletes document at path', () async {
      await harness.firestore.doc('users/alice').delete();
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'deleteDoc');
      expect(op['path'], 'users/alice');
    });

    test('firestore-flutter#20: DocumentReferencePlatform.snapshots() returns stream emitting DocumentSnapshotPlatform', () async {
      final stream = harness.firestore.doc('users/alice').snapshots(
            listenSource: ListenSource.defaultSource,
          );
      final snap = await stream.first;
      expect(snap.exists, true);
      expect(snap.data(), {'status': 'online'});
    });
  });

  // ── 3. QueryPlatform: Filters & Constraints ──────────────────────────────
  group('3. QueryPlatform: Filters & Constraints', () {
    test('firestore-flutter#21: QueryPlatform.where(field, isEqualTo: value) filters documents by equality', () {
      final q = harness.firestore.collection('users').where([
        ['status', '==', 'active']
      ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'status', 'op': '==', 'value': 'active'})));
    });

    test('firestore-flutter#22: QueryPlatform.where(field, isNotEqualTo: value) filters documents by inequality', () {
      final q = harness.firestore.collection('users').where([
        ['status', '!=', 'deleted']
      ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'status', 'op': '!=', 'value': 'deleted'})));
    });

    test('firestore-flutter#23: QueryPlatform.where range operators (<, <=, >, >=) filter scalar bounds', () {
      final q = harness.firestore.collection('users').where([
        ['age', '>=', 18],
        ['age', '<', 65],
      ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'age', 'op': '>=', 'value': 18})));
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'age', 'op': '<', 'value': 65})));
    });

    test('firestore-flutter#24: QueryPlatform.where(field, arrayContains: value) filters array elements', () {
      final q = harness.firestore.collection('users').where([
        ['tags', 'array-contains', 'vip']
      ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'tags', 'op': 'array-contains', 'value': 'vip'})));
    });

    test('firestore-flutter#25: QueryPlatform.where(field, arrayContainsAny: values) filters array containing any element', () {
      final q = harness.firestore.collection('users').where([
        ['tags', 'array-contains-any', ['vip', 'admin']]
      ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'tags', 'op': 'array-contains-any', 'value': ['vip', 'admin']})));
    });

    test('firestore-flutter#26: QueryPlatform.where(field, whereIn: values) filters field value matching list (IN)', () {
      final q = harness.firestore.collection('users').where([
        ['role', 'in', ['owner', 'editor']]
      ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'role', 'op': 'in', 'value': ['owner', 'editor']})));
    });

    test('firestore-flutter#27: QueryPlatform.where(field, whereNotIn: values) filters field value matching none (NOT IN)', () {
      final q = harness.firestore.collection('users').where([
        ['role', 'not-in', ['guest']]
      ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'role', 'op': 'not-in', 'value': ['guest']})));
    });

    test('firestore-flutter#28: QueryPlatform.where(field, isNull: true/false) filters documents based on null equality', () {
      final q = harness.firestore.collection('users').where([
        ['deletedAt', '==', null]
      ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'deletedAt', 'op': '==', 'value': null})));
    });

    test('firestore-flutter#29: QueryPlatform.orderBy(field, descending: bool) orders query results', () {
      final q = harness.firestore.collection('users').orderBy([
        ['createdAt', true]
      ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'orderBy', 'field': 'createdAt', 'direction': 'desc'})));
    });

    test('firestore-flutter#30: QueryPlatform.limit(limit) limits maximum number of returned documents', () {
      final q = harness.firestore.collection('users').limit(25) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'limit', 'n': 25})));
    });

    test('firestore-flutter#31: QueryPlatform.limitToLast(limit) limits query results to last N documents', () {
      final q = harness.firestore.collection('users').orderBy([['createdAt', false]]).limitToLast(10) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'limitToLast', 'n': 10})));
    });

    test('firestore-flutter#32: QueryPlatform startAt/startAfter positions starting cursor boundary using values', () {
      final q = harness.firestore.collection('users').orderBy([['age', false]]).startAfter([21]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'startAfter', 'values': [21]})));
    });

    test('firestore-flutter#33: QueryPlatform endAt/endBefore positions ending cursor boundary using values', () {
      final q = harness.firestore.collection('users').orderBy([['age', false]]).endAt([65]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'endAt', 'values': [65]})));
    });

    test('firestore-flutter#34: QueryPlatform startAtDocument/endAtDocument positions pagination cursors with snapshots', () {
      final q = harness.firestore.collection('users').endAtDocument([['score', true]], [500]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'endAt', 'values': [500]})));
    });

    test('firestore-flutter#35: QueryPlatform.get(options) executes query and returns QuerySnapshotPlatform', () async {
      final snap = await harness.firestore.collection('users').get();
      expect(snap.size, 2);
      expect(snap.docs[0].data(), {'name': 'A'});
      expect(snap.docs[1].data(), {'name': 'B'});
    });

    test('firestore-flutter#36: QueryPlatform.snapshots(options) returns stream emitting QuerySnapshotPlatform', () async {
      final stream = harness.firestore.collection('users').snapshots(
            listenSource: ListenSource.defaultSource,
          );
      final snap = await stream.first;
      expect(snap.docs.length, 1);
      expect(snap.docs[0].data(), {'item': 1});
    });
  });

  // ── 4. CollectionReferencePlatform: Collection Operations ────────────────
  group('4. CollectionReferencePlatform: Collection Operations', () {
    test('firestore-flutter#37: CollectionReferencePlatform.doc([path]) returns DocumentReferencePlatform with auto-ID if omitted', () {
      final explicitRef = harness.firestore.collection('users').doc('user-123');
      expect(explicitRef.path, 'users/user-123');

      final autoRef = harness.firestore.collection('users').doc();
      expect(autoRef.path, startsWith('users/'));
      expect(autoRef.id.length, 20);
    });

    test('firestore-flutter#38: CollectionReferencePlatform.add(data) generates auto-ID and writes document data', () async {
      final coll = harness.firestore.collection('users') as PyricCollectionReference;
      final newDoc = await coll.add({'name': 'Charlie'});
      expect(newDoc.id.length, 20);
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'setDoc');
      expect(op['path'], newDoc.path);
      expect(op['data'], {'name': 'Charlie'});
    });
  });

  // ── 5. Snapshots & Metadata ──────────────────────────────────────────────
  group('5. Snapshots & Metadata', () {
    test('firestore-flutter#39: DocumentSnapshotPlatform.exists reports true if present, false if absent', () {
      final present = PyricDocumentSnapshot(harness.firestore, 'users/1', {'a': 1});
      expect(present.exists, true);

      final missing = PyricDocumentSnapshot(harness.firestore, 'users/2', null);
      expect(missing.exists, false);
    });

    test('firestore-flutter#40: DocumentSnapshotPlatform.data() returns revived map of field data', () {
      final snap = PyricDocumentSnapshot.fromWire(
        harness.firestore,
        'users/1',
        {
          'exists': true,
          'data': {
            'json': jsonEncode({
              'createdAt': {'__type': 'timestamp', 'seconds': 12345, 'nanos': 678000},
              'location': {'__type': 'latlng', 'lat': 37.7749, 'lng': -122.4194},
            })
          }
        },
      );
      expect(snap.data()!['createdAt'], isA<Timestamp>());
      expect(snap.data()!['location'], isA<GeoPoint>());
    });

    test('firestore-flutter#41: DocumentSnapshotPlatform.get(field) extracts value supporting dot notation or FieldPath', () {
      final snap = PyricDocumentSnapshot(
        harness.firestore,
        'users/1',
        {
          'profile': {
            'address': {'zip': 94103}
          }
        },
      );
      expect(snap.get('profile.address.zip'), 94103);
      expect(snap.get(FieldPath(const ['profile', 'address', 'zip'])), 94103);
    });

    test('firestore-flutter#42: SnapshotMetadataPlatform exposes hasPendingWrites and isFromCache status', () {
      final snap = PyricDocumentSnapshot(
        harness.firestore,
        'users/1',
        {'v': 1},
        hasPendingWrites: true,
        isFromCache: true,
      );
      expect(snap.metadata.hasPendingWrites, true);
      expect(snap.metadata.isFromCache, true);
    });

    test('firestore-flutter#43: QuerySnapshotPlatform.docs provides ordered list of result document snapshots', () {
      final d1 = PyricDocumentSnapshot(harness.firestore, 'c/1', {'v': 1});
      final d2 = PyricDocumentSnapshot(harness.firestore, 'c/2', {'v': 2});
      final qs = PyricQuerySnapshot(harness.firestore, [d1, d2]);
      expect(qs.docs.length, 2);
      expect(qs.docs.first.id, '1');
      expect(qs.docs.last.id, '2');
    });

    test('firestore-flutter#44: QuerySnapshotPlatform.docChanges exposes list of document changes and index shifts', () {
      final d1 = PyricDocumentSnapshot(harness.firestore, 'c/1', {'v': 1});
      final d2 = PyricDocumentSnapshot(harness.firestore, 'c/2', {'v': 2});
      final d2Mod = PyricDocumentSnapshot(harness.firestore, 'c/2', {'v': 20});
      final d3 = PyricDocumentSnapshot(harness.firestore, 'c/3', {'v': 3});
      final changes = PyricQuerySnapshot.computeDocChanges([d1, d2], [d2Mod, d3]);

      expect(
        changes.any((c) =>
            c.type == DocumentChangeType.removed &&
            c.document.id == '1' &&
            c.oldIndex == 0),
        true,
      );
      expect(
        changes.any((c) =>
            c.type == DocumentChangeType.modified &&
            c.document.id == '2' &&
            c.oldIndex == 1 &&
            c.newIndex == 0),
        true,
      );
      expect(
        changes.any((c) =>
            c.type == DocumentChangeType.added &&
            c.document.id == '3' &&
            c.newIndex == 1),
        true,
      );
    });
  });
}
