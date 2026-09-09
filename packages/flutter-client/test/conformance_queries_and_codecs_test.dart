import 'dart:typed_data';

// ignore: depend_on_referenced_packages
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_firestore.dart';
import 'package:pyric_firestore/src/transport/codecs.dart';

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
      expectUnverified('Red at birth: firestore-flutter#53 not yet implemented in prototype platform');
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
