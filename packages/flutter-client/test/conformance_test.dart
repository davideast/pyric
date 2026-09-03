import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

// ignore: depend_on_referenced_packages
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_firestore.dart';
import 'package:pyric_firestore/src/transport/codecs.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// In-memory mock WebSocket channel for hermetic testing.
class MockWebSocketChannel extends StreamChannelMixin<dynamic>
    implements WebSocketChannel {
  final StreamController<dynamic> toServerController;
  final StreamController<dynamic> toClientController;

  MockWebSocketChannel({
    required this.toServerController,
    required this.toClientController,
  });

  @override
  Stream<dynamic> get stream => toClientController.stream;

  @override
  WebSocketSink get sink => _MockWebSocketSink(toServerController);

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  Future<void> get ready => Future.value();
}

class _MockWebSocketSink implements WebSocketSink {
  final StreamController<dynamic> _controller;

  _MockWebSocketSink(this._controller);

  @override
  void add(dynamic data) => _controller.add(data);

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      _controller.addError(error, stackTrace);

  @override
  Future<void> addStream(Stream<dynamic> stream) =>
      _controller.addStream(stream);

  @override
  Future<void> close([int? closeCode, String? closeReason]) =>
      _controller.close();

  @override
  Future<void> get done => _controller.done;
}

/// Hermetic mock harness simulating the Pyric WebSocket bridge.
class ConformanceMockHarness {
  final List<Map<String, dynamic>> sentMessages = [];
  final StreamController<dynamic> toServer =
      StreamController<dynamic>.broadcast();
  final StreamController<dynamic> toClient =
      StreamController<dynamic>.broadcast();
  late final PyricBridgeClient client;
  late final PyricFirestorePlatform firestore;

  ConformanceMockHarness() {
    toServer.stream.listen((event) {
      final msg = jsonDecode(event as String) as Map<String, dynamic>;
      sentMessages.add(msg);
      final type = msg['type'] as String?;

      if (type == 'attach') {
        toClient.add(jsonEncode({
          'type': 'attach-ack',
          'protocol': 1,
          'peerConnected': true,
        }));
      } else if (type == 'worker-op') {
        final id = msg['id'] as String;
        final op = msg['op'] as Map<String, dynamic>;
        final method = op['method'] as String;

        if (method == 'getDoc') {
          final path = op['path'] as String;
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {
              'id': path.split('/').last,
              'path': path,
              'exists': true,
              'data': {
                'json': jsonEncode({'name': 'Alice', 'age': 30}),
              },
            },
          }));
        } else if (method == 'getDocs') {
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {
              'docs': [
                {
                  'id': '1',
                  'path': 'users/1',
                  'exists': true,
                  'data': {'json': jsonEncode({'name': 'A'})},
                },
                {
                  'id': '2',
                  'path': 'users/2',
                  'exists': true,
                  'data': {'json': jsonEncode({'name': 'B'})},
                },
              ],
            },
          }));
        } else if (method == 'count') {
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {'count': 42},
          }));
        } else if (method == 'aggregate') {
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {
              'data': {
                'sum_score': 150.0,
                'avg_score': 75.0,
              },
            },
          }));
        } else {
          // setDoc, updateDoc, deleteDoc, addDoc, batchCommit, txnCommit
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': null,
          }));
        }
      } else if (type == 'worker-sub') {
        final subId = msg['subId'] as String;
        final sub = msg['sub'] as Map<String, dynamic>;
        final target = sub['target'] as Map<String, dynamic>;
        final refType = target['__ref'];

        if (refType == 'doc') {
          toClient.add(jsonEncode({
            'type': 'worker-snap',
            'subId': subId,
            'value': {
              'id': (target['path'] as String).split('/').last,
              'path': target['path'],
              'exists': true,
              'data': {'json': jsonEncode({'status': 'online'})},
            },
          }));
        } else {
          toClient.add(jsonEncode({
            'type': 'worker-snap',
            'subId': subId,
            'value': {
              'docs': [
                {
                  'id': 'doc1',
                  'path': '${target['path'] ?? 'coll'}/doc1',
                  'exists': true,
                  'data': {'json': jsonEncode({'item': 1})},
                }
              ],
            },
          }));
        }
      }
    });

    final channel = MockWebSocketChannel(
      toServerController: toServer,
      toClientController: toClient,
    );
    client = PyricBridgeClient(
      channelFactory: (uri, headers) => channel,
    );
    firestore = PyricFirestorePlatform(bridgeClient: client);
  }

  Future<void> dispose() async {
    await client.disconnect();
    await toServer.close();
    await toClient.close();
  }
}

/// In-memory mock [FirebasePlatform] preventing uninitialized Firebase exceptions.
class MockFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = {};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(
      appName,
      options ??
          const FirebaseOptions(
            apiKey: 'test-api-key',
            appId: 'test-app-id',
            messagingSenderId: 'test-sender-id',
            projectId: 'test-project-id',
          ),
    );
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps[name] ??
        FirebaseAppPlatform(
          name,
          const FirebaseOptions(
            apiKey: 'test-api-key',
            appId: 'test-app-id',
            messagingSenderId: 'test-sender-id',
            projectId: 'test-project-id',
          ),
        );
  }
}

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
      final platform = FirebaseFirestorePlatform.instanceFor(
        app: customApp,
        databaseId: 'custom-db',
      );
      expect(platform.databaseId, 'custom-db');
      expect(platform.app.name, 'custom-app');
      expect(platform, isA<PyricFirestorePlatform>());
    });

    test('firestore-flutter#3: FirebaseFirestorePlatform.settings configures host, ssl, persistence, and cache size', () {
      harness.firestore.settings = const Settings(
        host: 'pyric.local:5174',
        sslEnabled: false,
        persistenceEnabled: false,
        cacheSizeBytes: 1048576,
      );
      expect(harness.firestore.settings.host, 'pyric.local:5174');
      expect(harness.firestore.settings.sslEnabled, false);
      expect(harness.firestore.settings.persistenceEnabled, false);
      expect(harness.firestore.settings.cacheSizeBytes, 1048576);
    });

    test('firestore-flutter#4: FirebaseFirestorePlatform.doc(path) instantiates DocumentReferencePlatform', () {
      final docRef = harness.firestore.doc('users/alice');
      expect(docRef, isA<DocumentReferencePlatform>());
      expect(docRef.path, 'users/alice');
      expect(docRef.id, 'alice');
    });

    test('firestore-flutter#5: FirebaseFirestorePlatform.collection(path) instantiates CollectionReferencePlatform', () {
      final collRef = harness.firestore.collection('users');
      expect(collRef, isA<CollectionReferencePlatform>());
      expect(collRef.path, 'users');
      expect(collRef.id, 'users');
    });

    test('firestore-flutter#6: FirebaseFirestorePlatform.collectionGroup(collectionId) instantiates QueryPlatform spanning all collections', () {
      final groupQuery = harness.firestore.collectionGroup('orders');
      expect(groupQuery, isA<QueryPlatform>());
      expect(groupQuery.isCollectionGroupQuery, true);
      expect((groupQuery as PyricQuery).path, 'orders');
    });

    test('firestore-flutter#7: FirebaseFirestorePlatform.writeBatch() instantiates WriteBatchPlatform for atomic batched mutations', () {
      final batch = harness.firestore.batch();
      expect(batch, isA<WriteBatchPlatform>());
      expect(batch, isA<PyricWriteBatch>());
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
      fail('Red at birth: firestore-flutter#9 not yet implemented in prototype platform');
    });

    test('firestore-flutter#10: FirebaseFirestorePlatform enableNetwork/disableNetwork toggles connectivity', () {
      fail('Red at birth: firestore-flutter#10 not yet implemented in prototype platform');
    });

    test('firestore-flutter#11: FirebaseFirestorePlatform.terminate() terminates client and unsubscribes active streams', () async {
      await harness.firestore.terminate();
      expect(harness.client.isDisposed, true);
    });

    test('firestore-flutter#12: FirebaseFirestorePlatform.waitForPendingWrites() resolves when local writes are committed', () {
      fail('Red at birth: firestore-flutter#12 not yet implemented in prototype platform');
    });

    test('firestore-flutter#13: FirebaseFirestorePlatform.snapshotsInSync() emits when listeners catch up', () {
      fail('Red at birth: firestore-flutter#13 not yet implemented in prototype platform');
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

    test('firestore-flutter#17: DocumentReferencePlatform.update(data) updates specified fields in existing document', () async {
      await harness.firestore.doc('users/alice').update({
        FieldPath(const ['profile', 'city']): 'Tokyo',
      });
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'updateDoc');
      expect(op['data'], {'profile.city': 'Tokyo'});
    });

    test('firestore-flutter#18: DocumentReferencePlatform.delete() deletes document at reference path', () async {
      await harness.firestore.doc('users/alice').delete();
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'deleteDoc');
      expect(op['path'], 'users/alice');
    });

    test('firestore-flutter#19: DocumentReferencePlatform.collection(subPath) returns child collection reference', () {
      final sub = harness.firestore.doc('users/alice').collection('orders');
      expect(sub.path, 'users/alice/orders');
      expect(sub.parent?.path, 'users/alice');
    });

    test('firestore-flutter#20: DocumentReferencePlatform.snapshots(options) returns stream of document snapshots', () async {
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
    test('firestore-flutter#21: QueryPlatform.where(field, isEqualTo: value) filters documents matching field equality', () {
      final q = harness.firestore.collection('users').where([['age', '==', 30]]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'age', 'op': '==', 'value': 30})));
    });

    test('firestore-flutter#22: QueryPlatform.where(field, isNotEqualTo: value) filters documents where field is not equal', () {
      final q = harness.firestore.collection('users').where([['role', '!=', 'guest']]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'role', 'op': '!=', 'value': 'guest'})));
    });

    test('firestore-flutter#23: QueryPlatform.where relational range comparisons filter field value', () {
      final q = harness.firestore.collection('users').where([
        ['age', '>=', 18],
        ['age', '<', 65],
      ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], containsAll([
        {'kind': 'where', 'field': 'age', 'op': '>=', 'value': 18},
        {'kind': 'where', 'field': 'age', 'op': '<', 'value': 65},
      ]));
    });

    test('firestore-flutter#24: QueryPlatform.where(field, arrayContains: value) filters documents where array contains element', () {
      final q = harness.firestore.collection('users').where([['tags', 'array-contains', 'flutter']]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'tags', 'op': 'array-contains', 'value': 'flutter'})));
    });

    test('firestore-flutter#25: QueryPlatform.where(field, arrayContainsAny: values) filters array containing any element', () {
      final q = harness.firestore.collection('users').where([['tags', 'array-contains-any', ['flutter', 'dart']]]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'tags', 'op': 'array-contains-any', 'value': ['flutter', 'dart']})));
    });

    test('firestore-flutter#26: QueryPlatform.where(field, whereIn: values) filters field value matching list (IN)', () {
      final q = harness.firestore.collection('users').where([['role', 'in', ['admin', 'manager']]]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'role', 'op': 'in', 'value': ['admin', 'manager']})));
    });

    test('firestore-flutter#27: QueryPlatform.where(field, whereNotIn: values) filters field value matching none (NOT IN)`', () {
      final q = harness.firestore.collection('users').where([['role', 'not-in', ['banned', 'pending']]]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'role', 'op': 'not-in', 'value': ['banned', 'pending']})));
    });

    test('firestore-flutter#28: QueryPlatform.where(field, isNull: true/false) filters documents based on null equality', () {
      final q = harness.firestore.collection('users').where([['deletedAt', '==', null]]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'deletedAt', 'op': '==', 'value': null})));
    });

    test('firestore-flutter#29: QueryPlatform.orderBy(field, descending: bool) orders query results', () {
      final q = harness.firestore.collection('users').orderBy([['createdAt', true]]) as PyricQuery;
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

  // ── 6. WriteBatchPlatform: Atomic Batches ─────────────────────────────────
  group('6. WriteBatchPlatform: Atomic Batches', () {
    test('firestore-flutter#45: WriteBatchPlatform.set(path, data, options) enqueues set or merge operation', () async {
      final batch = harness.firestore.batch() as PyricWriteBatch;
      batch.set('users/alice', {'score': 100}, SetOptions(merge: true));
      await batch.commit();
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'batchCommit');
      expect(
        op['writes'],
        contains(equals({
          'method': 'set',
          'path': 'users/alice',
          'data': {'score': 100},
          'options': {'merge': true},
        })),
      );
    });

    test('firestore-flutter#46: WriteBatchPlatform.update(path, data) enqueues update operation into batch', () async {
      final batch = harness.firestore.batch() as PyricWriteBatch;
      batch.update('users/alice', {FieldPath(const ['level']): 5});
      await batch.commit();
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(
        op['writes'],
        contains(equals({
          'method': 'update',
          'path': 'users/alice',
          'data': {'level': 5},
        })),
      );
    });

    test('firestore-flutter#47: WriteBatchPlatform.delete(path) enqueues delete operation into batch', () async {
      final batch = harness.firestore.batch() as PyricWriteBatch;
      batch.delete('users/alice');
      await batch.commit();
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(
        op['writes'],
        contains(equals({
          'method': 'delete',
          'path': 'users/alice',
        })),
      );
    });

    test('firestore-flutter#48: WriteBatchPlatform.commit() atomically commits all enqueued mutations', () async {
      final batch = harness.firestore.batch() as PyricWriteBatch;
      batch.set('a/1', {'x': 1});
      batch.delete('a/2');
      await batch.commit();
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'batchCommit');
      expect((op['writes'] as List).length, 2);
    });
  });

  // ── 7. TransactionPlatform: Interactive Transactions ─────────────────────
  group('7. TransactionPlatform: Interactive Transactions', () {
    test('firestore-flutter#49: TransactionPlatform.get(path) reads snapshot within transaction context', () async {
      await harness.firestore.runTransaction((txn) async {
        final snap = await txn.get('users/alice');
        expect(snap.exists, true);
        expect(snap.id, 'alice');
      });
    });

    test('firestore-flutter#50: TransactionPlatform.set(path, data, options) enqueues transactional set mutation', () async {
      await harness.firestore.runTransaction((txn) async {
        txn.set('users/alice', {'score': 50});
      });
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'txnCommit');
      expect(
        op['writes'],
        contains(equals({
          'method': 'set',
          'path': 'users/alice',
          'data': {'score': 50},
        })),
      );
    });

    test('firestore-flutter#51: TransactionPlatform.update(path, data) enqueues transactional update mutation', () async {
      await harness.firestore.runTransaction((txn) async {
        txn.update('users/alice', {FieldPath(const ['score']): 60});
      });
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(
        op['writes'],
        contains(equals({
          'method': 'update',
          'path': 'users/alice',
          'data': {'score': 60},
        })),
      );
    });

    test('firestore-flutter#52: TransactionPlatform.delete(path) enqueues transactional delete mutation', () async {
      await harness.firestore.runTransaction((txn) async {
        txn.delete('users/alice');
      });
      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(
        op['writes'],
        contains(equals({
          'method': 'delete',
          'path': 'users/alice',
        })),
      );
    });

    test('firestore-flutter#53: TransactionPlatform retries handler on optimistic locking conflicts', () {
      fail('Red at birth: firestore-flutter#53 not yet implemented in prototype platform');
    });
  });

  // ── 8. FieldValuePlatform: Sentinels & Transformations ───────────────────
  group('8. FieldValuePlatform: Sentinels & Transformations', () {
    test('firestore-flutter#54: FieldValuePlatform.serverTimestamp() encodes server commit timestamp sentinel', () {
      final val = FieldValueFactoryPlatform.instance.serverTimestamp();
      expect(encodeValue(unwrapFieldValues(val)), {'__sentinel': 'serverTimestamp'});
    });

    test('firestore-flutter#55: FieldValuePlatform.delete() encodes sentinel deleting target field on update', () {
      final val = FieldValueFactoryPlatform.instance.delete();
      expect(encodeValue(unwrapFieldValues(val)), {'__sentinel': 'deleteField'});
    });

    test('firestore-flutter#56: FieldValuePlatform.increment(value) encodes atomic numeric increment sentinel', () {
      final val = FieldValueFactoryPlatform.instance.increment(7);
      expect(encodeValue(unwrapFieldValues(val)), {'__sentinel': 'increment', 'n': 7});
    });

    test('firestore-flutter#57: FieldValuePlatform.arrayUnion(elements) encodes array union sentinel', () {
      final val = FieldValueFactoryPlatform.instance.arrayUnion(['apple', 'banana']);
      expect(encodeValue(unwrapFieldValues(val)), {
        '__sentinel': 'arrayUnion',
        'values': ['apple', 'banana'],
      });
    });

    test('firestore-flutter#58: FieldValuePlatform.arrayRemove(elements) encodes array remove sentinel', () {
      final val = FieldValueFactoryPlatform.instance.arrayRemove(['apple']);
      expect(encodeValue(unwrapFieldValues(val)), {
        '__sentinel': 'arrayRemove',
        'values': ['apple'],
      });
    });
  });

  // ── 9. Data Types & Value Codecs: Serialization ──────────────────────────
  group('9. Data Types & Value Codecs: Serialization', () {
    test('firestore-flutter#59: Timestamp codec serializes and revives Timestamp with seconds and nanoseconds', () {
      final ts = Timestamp(1690000000, 123456);
      final enc = encodeValue(ts);
      expect(enc, {'__type': 'timestamp', 'seconds': 1690000000, 'nanos': 123456});
      final dec = decodeValue(enc);
      expect(dec, ts);
    });

    test('firestore-flutter#60: GeoPoint codec serializes and revives GeoPoint coordinates', () {
      const gp = GeoPoint(40.7128, -74.0060);
      final enc = encodeValue(gp);
      expect(enc, {'__type': 'latlng', 'lat': 40.7128, 'lng': -74.0060});
      final dec = decodeValue(enc);
      expect(dec, gp);
    });

    test('firestore-flutter#61: Blob codec serializes byte buffers to base64 and revives as Blob', () {
      final bytes = Uint8List.fromList([10, 20, 30, 40]);
      final blob = Blob(bytes);
      final enc = encodeValue(blob);
      expect(enc, {'__type': 'bytes', 'base64': base64UrlEncodeUnpadded(bytes)});
      final dec = decodeValue(enc);
      expect((dec as Blob).bytes, bytes);
    });

    test('firestore-flutter#62: DocumentReference codec encodes and decodes references within document fields', () {
      final docRef = harness.firestore.doc('users/alice');
      final enc = encodeValue(docRef);
      expect(enc, {'__type': 'reference', 'path': 'users/alice'});
      final dec = decodeValue(enc, referenceResolver: (p) => harness.firestore.doc(p));
      expect(dec, isA<DocumentReferencePlatform>());
      expect((dec as DocumentReferencePlatform).path, 'users/alice');
    });

    test('firestore-flutter#63: Nested Map and List codec deeply encodes and revives recursive collections', () {
      final complex = {
        'user': {'name': 'Alice', 'created': Timestamp(100, 200)},
        'tags': [
          'a',
          'b',
          {'nested': const GeoPoint(10, 20)},
        ],
      };
      final enc = encodeValue(complex);
      final dec = decodeValue(enc) as Map<String, dynamic>;
      expect(dec['user']['created'], isA<Timestamp>());
      expect(dec['tags'][2]['nested'], isA<GeoPoint>());
    });
  });

  // ── 10. Aggregations & Advanced Queries ──────────────────────────────────
  group('10. Aggregations & Advanced Queries', () {
    test('firestore-flutter#64: AggregateQueryPlatform.count() returns matched document count without full payloads', () async {
      final snap = await harness.firestore
          .collection('users')
          .count()
          .get(source: AggregateSource.server);
      expect(snap.count, 42);
    });

    test('firestore-flutter#65: AggregateQueryPlatform.aggregate(sum, average) computes server-side sum and average', () async {
      final snap = await harness.firestore
          .collection('users')
          .aggregate(sum('score'), average('score'))
          .get(source: AggregateSource.server);
      expect(snap.getSum('score'), 150.0);
      expect(snap.getAverage('score'), 75.0);
    });
  });
}
