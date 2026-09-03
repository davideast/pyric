import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_firestore.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

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

class MockWebSocketChannel extends StreamChannelMixin<dynamic>
    implements WebSocketChannel {
  final StreamController<dynamic> toServerController;
  final StreamController<dynamic> toClientController;

  MockWebSocketChannel({
    StreamController<dynamic>? toServer,
    StreamController<dynamic>? toClient,
  })  : toServerController = toServer ?? StreamController<dynamic>.broadcast(),
        toClientController = toClient ?? StreamController<dynamic>.broadcast();

  @override
  Stream<dynamic> get stream => toClientController.stream;

  @override
  WebSocketSink get sink => _MockWebSocketSink(toServerController);

  @override
  String? get protocol => 'pyric-v1';

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  Future<void> get ready => Future.value();
}

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

class StressTestHarness {
  final List<Map<String, dynamic>> sentMessages = [];
  final StreamController<dynamic> toServer = StreamController<dynamic>.broadcast();
  final StreamController<dynamic> toClient = StreamController<dynamic>.broadcast();
  late final PyricBridgeClient client;
  late final PyricFirestorePlatform firestore;
  late final StreamSubscription<dynamic> serverSubscription;

  StressTestHarness() {
    serverSubscription = toServer.stream.listen((raw) {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
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
          if (path.contains('missing')) {
            toClient.add(jsonEncode({
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': {
                'id': path.split('/').last,
                'path': path,
                'exists': false,
              },
            }));
          } else if (path.contains('denied')) {
            toClient.add(jsonEncode({
              'type': 'worker-res',
              'id': id,
              'ok': false,
              'error': {
                'code': 'permission-denied',
                'message': 'Missing permissions for doc read',
              },
            }));
          } else {
            toClient.add(jsonEncode({
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': {
                'id': path.split('/').last,
                'path': path,
                'exists': true,
                'data': {
                  'json': jsonEncode({
                    'name': 'Alice',
                    'profile': {'city': 'NYC'},
                    'tags': ['a', 'b'],
                  }),
                },
              },
            }));
          }
        } else if (method == 'setDoc' ||
            method == 'updateDoc' ||
            method == 'deleteDoc' ||
            method == 'batchCommit' ||
            method == 'txnCommit') {
          final path = op['path'] as String?;
          if (path != null && path.contains('denied')) {
            toClient.add(jsonEncode({
              'type': 'worker-res',
              'id': id,
              'ok': false,
              'error': {
                'code': 'permission-denied',
                'message': 'Denied write operation',
              },
            }));
          } else {
            toClient.add(jsonEncode({
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': null,
            }));
          }
        } else if (method == 'count') {
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {'count': 99},
          }));
        } else if (method == 'aggregate') {
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {
              'data': {
                'count': 5,
                'sum_score': 150.0,
                'avg_score': 30.0,
              },
            },
          }));
        }
      }
    });

    final channel = MockWebSocketChannel(
      toServer: toServer,
      toClient: toClient,
    );
    client = PyricBridgeClient(
      channelFactory: (uri, headers) => channel,
    );
    firestore = PyricFirestorePlatform(bridgeClient: client);
  }

  Future<void> dispose() async {
    await client.disconnect();
    await serverSubscription.cancel();
    await toServer.close();
    await toClient.close();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late StressTestHarness harness;

  setUpAll(() async {
    FirebasePlatform.instance = MockFirebasePlatform();
    await Firebase.initializeApp();
  });

  setUp(() async {
    harness = StressTestHarness();
    await harness.client.connect();
    PyricFirestorePlatform.registerWith(bridgeClient: harness.client);
  });

  tearDown(() async {
    await harness.dispose();
  });

  group('STRESS: WriteBatch Serialization with Sentinels and Complex Types', () {
    test('batch.set with FieldValue sentinels and Timestamp/GeoPoint/Blob/Ref', () async {
      final batch = harness.firestore.batch();
      batch.set('items/1', {
        'timestamp': FieldValueFactoryPlatform.instance.serverTimestamp(),
        'counter': FieldValueFactoryPlatform.instance.increment(1),
        'tags': FieldValueFactoryPlatform.instance.arrayUnion(['test']),
        'unwanted': FieldValueFactoryPlatform.instance.arrayRemove(['old']),
        'ts': Timestamp(100, 200),
        'geo': const GeoPoint(37.7749, -122.4194),
        'bytes': Blob(Uint8List.fromList([1, 2, 3])),
        'docRef': harness.firestore.doc('users/alice'),
      });

      // Does commit() succeed in serializing the wire message, or does jsonEncode fail?
      await batch.commit();

      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'batchCommit');
      final writes = op['writes'] as List;
      expect(writes.length, 1);
      final write = writes[0] as Map<String, dynamic>;
      expect(write['method'], 'set');
      expect(write['path'], 'items/1');

      // Check serialized data wire markers
      final data = write['data'] as Map<String, dynamic>;
      expect(data['timestamp'], {'__sentinel': 'serverTimestamp'});
      expect(data['counter'], {'__sentinel': 'increment', 'n': 1});
      expect(data['tags'], {'__sentinel': 'arrayUnion', 'values': ['test']});
      expect(data['unwanted'], {'__sentinel': 'arrayRemove', 'values': ['old']});
      expect(data['ts'], {'__type': 'timestamp', 'seconds': 100, 'nanos': 200});
      expect(data['geo'], {'__type': 'latlng', 'lat': 37.7749, 'lng': -122.4194});
      expect(data['bytes'], {'__type': 'bytes', 'base64': 'AQID'});
      expect(data['docRef'], {'__type': 'reference', 'path': 'users/alice'});
    });

    test('batch.update with FieldValue.delete and sentinels', () async {
      final batch = harness.firestore.batch();
      batch.update('items/1', {
        FieldPath(const ['toDelete']): FieldValueFactoryPlatform.instance.delete(),
        FieldPath(const ['inc']): FieldValueFactoryPlatform.instance.increment(5),
      });

      await batch.commit();

      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      final write = (op['writes'] as List)[0] as Map<String, dynamic>;
      expect(write['method'], 'update');
      final data = write['data'] as Map<String, dynamic>;
      expect(data['toDelete'], {'__sentinel': 'deleteField'});
      expect(data['inc'], {'__sentinel': 'increment', 'n': 5});
    });
  });

  group('STRESS: Transaction Serialization with Sentinels and Complex Types', () {
    test('transaction set/update with sentinels and complex types', () async {
      await harness.firestore.runTransaction((txn) async {
        txn.set('items/txn1', {
          'time': FieldValueFactoryPlatform.instance.serverTimestamp(),
          'count': FieldValueFactoryPlatform.instance.increment(10),
          'ts': Timestamp(500, 0),
        });
        txn.update('items/txn2', {
          FieldPath(const ['removedField']): FieldValueFactoryPlatform.instance.delete(),
        });
      });

      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'txnCommit');
      final writes = op['writes'] as List;
      expect(writes.length, 2);

      final write1 = writes[0] as Map<String, dynamic>;
      expect(write1['method'], 'set');
      final data1 = write1['data'] as Map<String, dynamic>;
      expect(data1['time'], {'__sentinel': 'serverTimestamp'});
      expect(data1['count'], {'__sentinel': 'increment', 'n': 10});
      expect(data1['ts'], {'__type': 'timestamp', 'seconds': 500, 'nanos': 0});

      final write2 = writes[1] as Map<String, dynamic>;
      expect(write2['method'], 'update');
      final data2 = write2['data'] as Map<String, dynamic>;
      expect(data2['removedField'], {'__sentinel': 'deleteField'});
    });
  });

  group('STRESS: QuerySnapshot DocChanges with Nested Collections', () {
    test('computeDocChanges does not falsely mark unchanged docs as modified when containing nested maps/lists', () {
      final doc1 = PyricDocumentSnapshot.fromWire(
        harness.firestore,
        'col/1',
        {
          'id': '1',
          'path': 'col/1',
          'exists': true,
          'data': {
            'json': jsonEncode({
              'profile': {'city': 'NYC'},
              'tags': ['a', 'b'],
            }),
          },
        },
      );

      final doc2 = PyricDocumentSnapshot.fromWire(
        harness.firestore,
        'col/1',
        {
          'id': '1',
          'path': 'col/1',
          'exists': true,
          'data': {
            'json': jsonEncode({
              'profile': {'city': 'NYC'},
              'tags': ['a', 'b'],
            }),
          },
        },
      );

      // doc1 and doc2 have identical content.
      // Comparing oldDocs=[doc1] and newDocs=[doc2] should yield ZERO doc changes (not modified)!
      final changes = PyricQuerySnapshot.computeDocChanges([doc1], [doc2]);
      expect(changes, isEmpty, reason: 'Unchanged document with nested map/list should not produce a modified change');
    });
  });

  group('STRESS: Error Propagation and Non-Existent Documents', () {
    test('get on non-existent document yields exists: false, null data, and throwing field getter', () async {
      final snap = await harness.firestore.doc('users/missing').get();
      expect(snap.exists, isFalse);
      expect(snap.data(), isNull);
      expect(() => snap.get('name'), throwsStateError);
      expect(() => snap['name'], throwsStateError);
    });

    test('permission denied on getDoc throws PyricBridgeException', () async {
      expect(
        () => harness.firestore.doc('users/denied').get(),
        throwsA(isA<PyricBridgeException>().having(
          (e) => e.code,
          'code',
          'permission-denied',
        )),
      );
    });

    test('permission denied on setDoc throws PyricBridgeException', () async {
      expect(
        () => harness.firestore.doc('users/denied').set({'x': 1}),
        throwsA(isA<PyricBridgeException>().having(
          (e) => e.code,
          'code',
          'permission-denied',
        )),
      );
    });

    test('stream snapshots error propagation on permission-denied __error frame', () async {
      final stream = harness.firestore.doc('users/alice').snapshots(
            listenSource: ListenSource.defaultSource,
          );
      final completer = Completer<dynamic>();

      final sub = stream.listen(
        (_) {},
        onError: (err) {
          completer.complete(err);
        },
      );

      // Simulate bridge sending __error frame on sub
      await Future<void>.delayed(Duration.zero);
      final subMsg = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      final subId = subMsg['subId'] as String;

      harness.toClient.add(jsonEncode({
        'type': 'worker-snap',
        'subId': subId,
        'value': {
          '__error': {
            'code': 'permission-denied',
            'message': 'Listener permission denied',
          },
        },
      }));

      final error = await completer.future;
      expect(error, isA<PyricBridgeException>());
      expect((error as PyricBridgeException).code, 'permission-denied');
      expect(error.message, 'Listener permission denied');

      await sub.cancel();
    });

    test('stream snapshot cancellation sends worker-unsub frame', () async {
      final stream = harness.firestore.doc('users/stream_test').snapshots(
            listenSource: ListenSource.defaultSource,
          );
      final sub = stream.listen((_) {});

      await Future<void>.delayed(Duration.zero);
      final subMsg = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      final subId = subMsg['subId'] as String;

      await sub.cancel();
      await Future<void>.delayed(Duration.zero);

      final unsubMsg = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-unsub');
      expect(unsubMsg['subId'], subId);
    });
  });

  group('STRESS: Sub-collections and AutoId', () {
    test('deeply nested sub-collections resolve correct paths', () {
      final doc = harness.firestore
          .collection('users')
          .doc('u1')
          .collection('posts')
          .doc('p1')
          .collection('comments')
          .doc('c1');
      expect(doc.path, 'users/u1/posts/p1/comments/c1');
      expect(doc.id, 'c1');
      expect(doc.parent.path, 'users/u1/posts/p1/comments');
    });

    test('autoId produces valid 20-character base62 strings', () {
      final id1 = PyricCollectionReference.autoId();
      final id2 = PyricCollectionReference.autoId();
      expect(id1.length, 20);
      expect(id2.length, 20);
      expect(id1, isNot(equals(id2)));
      expect(RegExp(r'^[a-zA-Z0-9]{20}$').hasMatch(id1), isTrue);
      expect(RegExp(r'^[a-zA-Z0-9]{20}$').hasMatch(id2), isTrue);
    });

    test('collection.add writes document and returns valid reference', () async {
      final col = harness.firestore.collection('users') as PyricCollectionReference;
      final ref = await col.add({'name': 'NewUser'});
      expect(ref.path, startsWith('users/'));
      expect(ref.id.length, 20);

      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'setDoc');
      expect(op['path'], ref.path);
      expect(op['data'], {'name': 'NewUser'});
    });
  });

  group('STRESS: Query and Aggregations', () {
    test('multi-aggregation compiles spec and decodes count, sum, average', () async {
      final col = harness.firestore.collection('orders') as PyricCollectionReference;
      final agg = col.aggregate(
        count(),
        sum('score'),
        average('score'),
      );

      final snap = await agg.get(source: AggregateSource.server);
      expect(snap.count, 5);
      expect(snap.getSum('score'), 150.0);
      expect(snap.getAverage('score'), 30.0);

      final op = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-op')['op'];
      expect(op['method'], 'aggregate');
      expect(op['spec'], {
        'count': {'kind': 'count'},
        'sum_score': {'kind': 'sum', 'field': 'score'},
        'avg_score': {'kind': 'average', 'field': 'score'},
      });
    });

    test('FieldPath in where and orderBy compiles to dotted path strings', () {
      final q = harness.firestore
          .collection('items')
          .where([
            [FieldPath(const ['user', 'email']), '==', 'test@example.com'],
          ])
          .orderBy([
            [FieldPath(const ['user', 'createdAt']), true],
          ]) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({'kind': 'where', 'field': 'user.email', 'op': '==', 'value': 'test@example.com'})));
      expect(target['constraints'], contains(equals({'kind': 'orderBy', 'field': 'user.createdAt', 'direction': 'desc'})));
    });

    test('whereFilter compiles composite and/or filters into query constraints', () {
      final filter = _TestFilter({
        'op': 'AND',
        'queries': [
          {'fieldPath': FieldPath(const ['status']), 'op': '==', 'value': 'active'},
          {
            'op': 'OR',
            'queries': [
              {'fieldPath': 'role', 'op': '==', 'value': 'admin'},
              {'fieldPath': 'role', 'op': '==', 'value': 'mod'},
            ],
          },
        ],
      });
      final q = harness.firestore.collection('users').whereFilter(filter) as PyricQuery;
      final target = q.compileTarget();
      expect(target['constraints'], contains(equals({
        'kind': 'and',
        'filters': [
          {'kind': 'where', 'field': 'status', 'op': '==', 'value': 'active'},
          {
            'kind': 'or',
            'filters': [
              {'kind': 'where', 'field': 'role', 'op': '==', 'value': 'admin'},
              {'kind': 'where', 'field': 'role', 'op': '==', 'value': 'mod'},
            ],
          },
        ],
      })));
    });

    test('snapshots forwards includeMetadataChanges and listenSource to bridge', () async {
      final doc = harness.firestore.doc('users/alice');
      final sub = doc.snapshots(
        includeMetadataChanges: true,
        listenSource: ListenSource.cache,
      ).listen((_) {});
      await pumpEventQueue();
      final subMsg = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      expect(subMsg['sub']['includeMetadataChanges'], isTrue);
      expect(subMsg['sub']['listenSource'], 'cache');
      await sub.cancel();
    });
  });
}

class _TestFilter extends FilterPlatformInterface {
  final Map<String, Object?> _json;
  _TestFilter(this._json);

  @override
  Map<String, Object?> toJson() => _json;
}
