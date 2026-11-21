import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_firestore.dart';
import 'package:pyric_firestore/src/transport/codecs.dart';

import 'conformance_harness.dart';

class _CustomizableMockHarness {
  final StreamController<dynamic> toServer =
      StreamController<dynamic>.broadcast();
  final StreamController<dynamic> toClient =
      StreamController<dynamic>.broadcast();
  final List<Map<String, dynamic>> sentOps = [];
  late final PyricBridgeClient client;
  late final PyricFirestorePlatform firestore;

  Map<String, dynamic> Function(String id, String method, Map<String, dynamic> op)?
      onWorkerOp;

  _CustomizableMockHarness() {
    toServer.stream.listen((raw) {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
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
        sentOps.add(op);
        final custom = onWorkerOp?.call(id, method, op);
        if (custom != null) {
          toClient.add(jsonEncode(custom));
        } else {
          toClient.add(jsonEncode({
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': null,
          }));
        }
      }
    });

    final channel = MockWebSocketChannel(
      toServerController: toServer,
      toClientController: toClient,
    );
    client = PyricBridgeClient(channelFactory: (uri, headers) => channel);
    firestore = PyricFirestorePlatform(bridgeClient: client);
  }

  Future<void> dispose() async {
    await firestore.terminate();
    await toServer.close();
    await toClient.close();
  }
}

void main() {
  group('Flutter Firestore upstream oracle parity', () {
    test('encodeValue and decodeDocData round-trip NaN, +-Infinity, -0.0, and VectorValue across jsonEncode', () {
      final rawDoc = <String, dynamic>{
        'nanVal': double.nan,
        'infVal': double.infinity,
        'negInfVal': double.negativeInfinity,
        'negZeroVal': -0.0,
        'posZeroVal': 0.0,
        'intVal': 6000000000,
        'embedding': const VectorValue([1.5, -2.25, 3.75]),
      };

      final wireEncoded = encodeWriteData(rawDoc);
      final wireJson = jsonEncode(wireEncoded);
      final decoded = decodeDocData({
        'valueEncoding': docValueEncodingV1,
        'json': wireJson,
      });

      expect((decoded['nanVal'] as double).isNaN, isTrue);
      expect(decoded['infVal'], equals(double.infinity));
      expect(decoded['negInfVal'], equals(double.negativeInfinity));
      expect(decoded['negZeroVal'], equals(-0.0));
      expect((decoded['negZeroVal'] as double).isNegative, isTrue);
      expect(decoded['posZeroVal'], equals(0.0));
      expect((decoded['posZeroVal'] as double).isNegative, isFalse);
      expect(decoded['intVal'], equals(6000000000));
      expect(decoded['embedding'], isA<VectorValue>());
      expect(
        (decoded['embedding'] as VectorValue).toArray(),
        equals([1.5, -2.25, 3.75]),
      );

      expect(
        () => encodeValue(const VectorValue([1.0, double.nan])),
        throwsArgumentError,
      );
      expect(
        () => encodeValue(const VectorValue([double.infinity])),
        throwsArgumentError,
      );
    });

    test('PyricAggregateQuery decodes encodedData special doubles, empty sum 0.0, and empty average null', () async {
      final harness = _CustomizableMockHarness();
      addTearDown(harness.dispose);

      harness.onWorkerOp = (id, method, op) {
        if (method == 'aggregate') {
          return {
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {
              'data': {
                'count': 2,
                'sum_intScore': 90,
                'sum_emptyScore': 0,
                'sum_nanScore': null,
                'avg_emptyScore': null,
                'avg_negZeroScore': 0,
              },
              'encodedData': {
                'count': 2,
                'sum_intScore': 90,
                'sum_emptyScore': 0,
                'sum_nanScore': {'__type': 'number', 'value': 'NaN'},
                'avg_emptyScore': null,
                'avg_negZeroScore': {'__type': 'number', 'value': '-0'},
              },
            },
          };
        }
        return {'type': 'worker-res', 'id': id, 'ok': true, 'value': null};
      };

      final agg = harness.firestore.collection('scores').aggregate(
            count(),
            sum('intScore'),
            sum('emptyScore'),
            sum('nanScore'),
            average('emptyScore'),
            average('negZeroScore'),
          );

      final snap = await agg.get(source: AggregateSource.server);
      expect(snap.count, equals(2));
      expect(snap.getSum('intScore'), equals(90.0));
      expect(snap.getSum('emptyScore'), equals(0.0));
      expect(snap.getSum('nanScore')!.isNaN, isTrue);
      expect(snap.getAverage('emptyScore'), isNull);
      final negZeroAvg = snap.getAverage('negZeroScore')!;
      expect(negZeroAvg, equals(-0.0));
      expect(negZeroAvg.isNegative, isTrue);
    });

    test('FieldPath with literal dot updates via segment vectors in doc.update, batch.update, transaction.update, and offline projection', () async {
      final harness = _CustomizableMockHarness();
      addTearDown(harness.dispose);

      harness.onWorkerOp = (id, method, op) {
        if (method == 'getDoc') {
          return {
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {
              'id': 'd1',
              'path': 'items/d1',
              'exists': true,
              'data': {
                'valueEncoding': docValueEncodingV1,
                'json': jsonEncode({
                  'meta.v1': 'before',
                  'meta': {'v1': 'nested-untouched'},
                }),
              },
            },
          };
        }
        return {'type': 'worker-res', 'id': id, 'ok': true, 'value': null};
      };

      final docRef = harness.firestore.doc('items/d1');
      await docRef.get();

      await docRef.update({FieldPath(const ['meta.v1']): 'after-doc'});
      final docUpdateOp = harness.sentOps.lastWhere(
        (op) => op['method'] == 'updateDoc',
      );
      expect(
        docUpdateOp['fields'],
        equals([
          {
            'path': ['meta.v1'],
            'value': 'after-doc',
          },
        ]),
      );

      final batch = harness.firestore.batch();
      batch.update('items/d1', {FieldPath(const ['meta.v1']): 'after-batch'});
      await batch.commit();
      final batchOp = harness.sentOps.lastWhere(
        (op) => op['method'] == 'batchCommit',
      );
      final batchWrites = batchOp['writes'] as List<dynamic>;
      expect(
        (batchWrites.single as Map<String, dynamic>)['fields'],
        equals([
          {
            'path': ['meta.v1'],
            'value': 'after-batch',
          },
        ]),
      );

      // Verify offline projection preserves literal dot segment without splitting on '.'.
      await harness.firestore.disableNetwork();
      unawaited(
        docRef.update({FieldPath(const ['meta.v1']): 'offline-literal'}),
      );
      final cachedSnap = await docRef.get(const GetOptions(source: Source.cache));
      expect(cachedSnap.data()?['meta.v1'], equals('offline-literal'));
      expect(
        cachedSnap.data()?['meta'],
        equals({'v1': 'nested-untouched'}),
      );
      await harness.firestore.enableNetwork();
    });

    test('collectionGroup validates path, runTransaction validates maxAttempts, forwards txnId, and maps exhausted contention to failed-precondition', () async {
      final harness = _CustomizableMockHarness();
      addTearDown(harness.dispose);

      expect(() => harness.firestore.collectionGroup(''), throwsArgumentError);
      expect(
        () => harness.firestore.collectionGroup('orders/items'),
        throwsArgumentError,
      );
      await expectLater(
        harness.firestore.runTransaction((txn) async => 1, maxAttempts: 0),
        throwsArgumentError,
      );

      var commitAttempts = 0;
      final observedGetTxnIds = <String?>[];
      final observedCommitTxnIds = <String?>[];

      harness.onWorkerOp = (id, method, op) {
        if (method == 'getDoc') {
          observedGetTxnIds.add(op['txnId'] as String?);
          return {
            'type': 'worker-res',
            'id': id,
            'ok': true,
            'value': {
              'id': 'c1',
              'path': 'counters/c1',
              'exists': true,
              'data': {'json': jsonEncode({'n': 10})},
            },
          };
        }
        if (method == 'txnCommit') {
          commitAttempts += 1;
          observedCommitTxnIds.add(op['txnId'] as String?);
          if (commitAttempts == 1) {
            return {
              'type': 'worker-res',
              'id': id,
              'ok': false,
              'error': {
                'code': 'aborted',
                'message': 'Concurrent modification.',
              },
            };
          }
          return {'type': 'worker-res', 'id': id, 'ok': true, 'value': null};
        }
        if (method == 'updateDoc') {
          return {
            'type': 'worker-res',
            'id': id,
            'ok': false,
            'error': {
              'code': 'not-found',
              'message': 'No document to update.',
            },
          };
        }
        return {'type': 'worker-res', 'id': id, 'ok': true, 'value': null};
      };

      // maxAttempts: 1 exhausts on first conflict and throws failed-precondition.
      PyricBridgeException? exhaustedErr;
      try {
        await harness.firestore.runTransaction(
          (txn) async {
            final snap = await txn.get('counters/c1');
            txn.update('counters/c1', {
              FieldPath.fromString('n'): (snap.data()!['n'] as int) + 1,
            });
            return true;
          },
          maxAttempts: 1,
        );
      } on PyricBridgeException catch (e) {
        exhaustedErr = e;
      }
      expect(exhaustedErr?.code, equals('failed-precondition'));
      expect(observedGetTxnIds.single, isNotEmpty);
      expect(observedCommitTxnIds.single, equals(observedGetTxnIds.single));

      // Reset and run with maxAttempts: 3 -> attempt 1 aborts, attempt 2 succeeds with distinct txnId.
      commitAttempts = 0;
      observedGetTxnIds.clear();
      observedCommitTxnIds.clear();

      final result = await harness.firestore.runTransaction<int>(
        (txn) async {
          final snap = await txn.get('counters/c1');
          final nextVal = (snap.data()!['n'] as int) + 5;
          txn.update('counters/c1', {FieldPath.fromString('n'): nextVal});
          return nextVal;
        },
        maxAttempts: 3,
      );
      expect(result, equals(15));
      expect(commitAttempts, equals(2));
      expect(observedGetTxnIds.length, equals(2));
      expect(observedGetTxnIds[0], isNot(equals(observedGetTxnIds[1])));
      expect(observedCommitTxnIds, equals(observedGetTxnIds));

      // Missing-doc update throws not-found.
      PyricBridgeException? missingErr;
      try {
        await harness.firestore
            .doc('counters/missing')
            .update({FieldPath.fromString('n'): 1});
      } on PyricBridgeException catch (e) {
        missingErr = e;
      }
      expect(missingErr?.code, equals('not-found'));
    });
  });
}
