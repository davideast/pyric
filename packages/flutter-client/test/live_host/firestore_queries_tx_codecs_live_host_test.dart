import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import 'firestore_live_host_helper.dart';

void main() {
  installLiveHostHttpOverrides();

  group('Firestore queries, snapshots, batches, transactions, sentinels, codecs, and aggregations live-host conformance', () {
    test(
      'firestore-flutter#21..#36 #43 #44 #64 #65: query filters, cursors, document cursors, docChanges, count, sum, and average on live host',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) return;

        await withLiveFirestoreSession(bridgeUri, (session) async {
          final firestore = session.firestore;
          final uid = session.uid;
          final colPath = 'users/$uid/items';
          final col = firestore.collection(colPath);

          final seedBatch = firestore.batch();
          seedBatch.set('$colPath/a', <String, dynamic>{
            'status': 'active',
            'role': 'owner',
            'score': 10,
            'tags': <String>['core', 'fast'],
            'archivedAt': null,
          });
          seedBatch.set('$colPath/b', <String, dynamic>{
            'status': 'active',
            'role': 'editor',
            'score': 20,
            'tags': <String>['core', 'beta'],
            'archivedAt': null,
          });
          seedBatch.set('$colPath/c', <String, dynamic>{
            'status': 'active',
            'role': 'viewer',
            'score': 20,
            'tags': <String>['beta'],
            'archivedAt': '2026-01-01',
          });
          seedBatch.set('$colPath/d', <String, dynamic>{
            'status': 'paused',
            'role': 'guest',
            'score': 40,
            'tags': <String>['sandbox'],
            'archivedAt': '2026-02-01',
          });
          await seedBatch.commit();

          List<String> idsOf(QuerySnapshotPlatform snap) =>
              snap.docs.map((d) => d.id).toList();

          final eqSnap = await col.where(const <List<dynamic>>[
            <dynamic>['status', '==', 'active'],
          ]).orderBy(const <List<dynamic>>[
            <dynamic>['score', false],
          ]).get();
          expect(idsOf(eqSnap), equals(<String>['a', 'b', 'c']));

          final neqSnap = await col.where(const <List<dynamic>>[
            <dynamic>['status', '!=', 'active'],
          ]).get();
          expect(idsOf(neqSnap), equals(<String>['d']));

          final rangeSnap = await col.where(const <List<dynamic>>[
            <dynamic>['score', '>', 10],
            <dynamic>['score', '<=', 40],
          ]).orderBy(const <List<dynamic>>[
            <dynamic>['score', false],
          ]).get();
          expect(idsOf(rangeSnap), equals(<String>['b', 'c', 'd']));

          final geLtSnap = await col.where(const <List<dynamic>>[
            <dynamic>['score', '>=', 10],
            <dynamic>['score', '<', 40],
          ]).orderBy(const <List<dynamic>>[
            <dynamic>['score', false],
          ]).get();
          expect(idsOf(geLtSnap), equals(<String>['a', 'b', 'c']));

          final containsSnap = await col.where(const <List<dynamic>>[
            <dynamic>['tags', 'array-contains', 'core'],
          ]).orderBy(const <List<dynamic>>[
            <dynamic>['score', false],
          ]).get();
          expect(idsOf(containsSnap), equals(<String>['a', 'b']));

          final containsAnySnap = await col.where(const <List<dynamic>>[
            <dynamic>[
              'tags',
              'array-contains-any',
              <String>['fast', 'sandbox'],
            ],
          ]).orderBy(const <List<dynamic>>[
            <dynamic>['score', false],
          ]).get();
          expect(idsOf(containsAnySnap), equals(<String>['a', 'd']));

          final inSnap = await col.where(const <List<dynamic>>[
            <dynamic>[
              'role',
              'in',
              <String>['owner', 'viewer'],
            ],
          ]).orderBy(const <List<dynamic>>[
            <dynamic>['score', false],
          ]).get();
          expect(idsOf(inSnap), equals(<String>['a', 'c']));

          final notInSnap = await col.where(const <List<dynamic>>[
            <dynamic>[
              'role',
              'not-in',
              <String>['guest', 'viewer'],
            ],
          ]).orderBy(const <List<dynamic>>[
            <dynamic>['role', false],
          ]).get();
          expect(idsOf(notInSnap), equals(<String>['b', 'a']));

          final isNullSnap = await col.where(const <List<dynamic>>[
            <dynamic>['archivedAt', '==', null],
          ]).orderBy(const <List<dynamic>>[
            <dynamic>['score', false],
          ]).get();
          expect(idsOf(isNullSnap), equals(<String>['a', 'b']));

          final isNotNullSnap = await col.where(const <List<dynamic>>[
            <dynamic>['archivedAt', '!=', null],
          ]).orderBy(const <List<dynamic>>[
            <dynamic>['archivedAt', false],
          ]).get();
          expect(idsOf(isNotNullSnap), equals(<String>['c', 'd']));

          final descLimitSnap = await col
              .orderBy(const <List<dynamic>>[
                <dynamic>['score', true],
              ])
              .limit(2)
              .get();
          expect(idsOf(descLimitSnap), equals(<String>['d', 'c']));

          final limitToLastSnap = await col
              .orderBy(const <List<dynamic>>[
                <dynamic>['score', false],
              ])
              .limitToLast(2)
              .get();
          expect(idsOf(limitToLastSnap), equals(<String>['c', 'd']));

          final startEndValSnap = await col
              .orderBy(const <List<dynamic>>[
                <dynamic>['score', false],
              ])
              .startAt(const <dynamic>[20])
              .endBefore(const <dynamic>[40])
              .get();
          expect(idsOf(startEndValSnap), equals(<String>['b', 'c']));

          final afterEndAtValSnap = await col
              .orderBy(const <List<dynamic>>[
                <dynamic>['score', false],
              ])
              .startAfter(const <dynamic>[10])
              .endAt(const <dynamic>[20])
              .get();
          expect(idsOf(afterEndAtValSnap), equals(<String>['b', 'c']));

          final docB = await firestore.doc('$colPath/b').get();
          final docD = await firestore.doc('$colPath/d').get();
          final cursorOrders = <List<dynamic>>[
            <dynamic>['score', false],
            <dynamic>[FieldPath.documentId, false],
          ];
          final docCursorSnap = await col
              .startAfterDocument(
                cursorOrders,
                <dynamic>[docB.get('score'), docB.id],
              )
              .endAtDocument(
                cursorOrders,
                <dynamic>[docD.get('score'), docD.id],
              )
              .get(const GetOptions(source: Source.server));
          expect(idsOf(docCursorSnap), equals(<String>['c', 'd']));

          final cachedQuerySnap = await col
              .orderBy(const <List<dynamic>>[
                <dynamic>['score', false],
              ])
              .get(const GetOptions(source: Source.cache));
          expect(cachedQuerySnap.metadata.isFromCache, isTrue);
          expect(idsOf(cachedQuerySnap), equals(<String>['a', 'b', 'c', 'd']));

          final countSnap =
              await col.count().get(source: AggregateSource.server);
          expect(countSnap.count, equals(4));

          final aggSnap = await col
              .aggregate(sum('score'), average('score'))
              .get(source: AggregateSource.server);
          expect(aggSnap.getSum('score'), closeTo(90.0, 0.001));
          expect(aggSnap.getAverage('score'), closeTo(22.5, 0.001));

          final streamColPath = 'users/$uid/links';
          final streamCol = firestore.collection(streamColPath).orderBy(
            const <List<dynamic>>[
              <dynamic>['rank', false],
            ],
          );
          await firestore.doc('$streamColPath/k1').set(<String, dynamic>{
            'rank': 10,
          });
          await firestore.doc('$streamColPath/k2').set(<String, dynamic>{
            'rank': 20,
          });

          final snapshots = <QuerySnapshotPlatform>[];
          final initialSeen = Completer<void>();
          final modifiedSeen = Completer<void>();
          final removedSeen = Completer<void>();

          final querySub = streamCol
              .snapshots(listenSource: ListenSource.defaultSource)
              .listen((qSnap) {
            snapshots.add(qSnap);
            if (snapshots.length == 1 && !initialSeen.isCompleted) {
              initialSeen.complete();
            } else if (qSnap.docChanges.any(
                  (c) => c.type == DocumentChangeType.modified,
                ) &&
                !modifiedSeen.isCompleted) {
              modifiedSeen.complete();
            } else if (qSnap.docChanges.any(
                  (c) => c.type == DocumentChangeType.removed,
                ) &&
                !removedSeen.isCompleted) {
              removedSeen.complete();
            }
          });

          try {
            await initialSeen.future.timeout(const Duration(seconds: 5));
            expect(
              snapshots.first.docChanges.map((c) => c.type).toList(),
              equals(<DocumentChangeType>[
                DocumentChangeType.added,
                DocumentChangeType.added,
              ]),
            );

            await firestore.doc('$streamColPath/k1').update(<FieldPath, dynamic>{
              FieldPath.fromString('rank'): 30,
            });
            await modifiedSeen.future.timeout(const Duration(seconds: 5));
            final modSnap = snapshots.last;
            expect(idsOf(modSnap), equals(<String>['k2', 'k1']));
            final modChange = modSnap.docChanges.singleWhere(
              (c) => c.document.id == 'k1',
            );
            expect(modChange.type, equals(DocumentChangeType.modified));
            expect(modChange.oldIndex, equals(0));
            expect(modChange.newIndex, equals(1));

            await firestore.doc('$streamColPath/k2').delete();
            await removedSeen.future.timeout(const Duration(seconds: 5));
            final remChange = snapshots.last.docChanges.singleWhere(
              (c) => c.document.id == 'k2',
            );
            expect(remChange.type, equals(DocumentChangeType.removed));
            expect(remChange.oldIndex, equals(0));
            expect(remChange.newIndex, equals(-1));
          } finally {
            await querySub.cancel();
          }
        });
      },
    );

    test(
      'firestore-flutter#45..#63: WriteBatch, Transaction CRUD + conflict retry, FieldValue sentinels, and value codecs on live host',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) return;

        await withLiveFirestoreSession(bridgeUri, (session) async {
          final firestore = session.firestore;
          final uid = session.uid;
          final fv = FieldValueFactoryPlatform.instance;
          final basePath = 'users/$uid/items';

          await firestore.doc('$basePath/b-del').set(<String, dynamic>{
            'temp': true,
          });
          final batch = firestore.batch();
          batch.set('$basePath/b-doc', <String, dynamic>{
            'name': 'BatchOne',
            'keep': 'yes',
            'score': 5,
          });
          batch.set(
            '$basePath/b-doc',
            <String, dynamic>{'merged': true},
            SetOptions(merge: true),
          );
          batch.update('$basePath/b-doc', <FieldPath, dynamic>{
            FieldPath.fromString('score'): 15,
          });
          batch.delete('$basePath/b-del');
          await batch.commit();

          final bSnap = await firestore.doc('$basePath/b-doc').get();
          expect(bSnap.data()!['keep'], equals('yes'));
          expect(bSnap.data()!['merged'], isTrue);
          expect(bSnap.data()!['score'], equals(15));
          expect((await firestore.doc('$basePath/b-del').get()).exists, isFalse);

          await firestore.doc('$basePath/tx-del').set(<String, dynamic>{
            'stale': true,
          });
          await firestore.doc('$basePath/tx-counter').set(<String, dynamic>{
            'value': 10,
          });

          await withDedicatedFirestoreClient(session, (_, rivalFs) async {
            var attempts = 0;
            final finalTotal = await firestore.runTransaction<int>((txn) async {
              attempts += 1;
              final counterSnap = await txn.get('$basePath/tx-counter');
              final current = (counterSnap.data()!['value'] as num).toInt();

              if (attempts == 1) {
                await rivalFs
                    .doc('$basePath/tx-counter')
                    .set(<String, dynamic>{'value': 25});
              }

              final next = current + 5;
              txn.update('$basePath/tx-counter', <FieldPath, dynamic>{
                FieldPath.fromString('value'): next,
              });
              txn.set(
                '$basePath/tx-log',
                <String, dynamic>{'finalValue': next, 'attempts': attempts},
                SetOptions(merge: true),
              );
              txn.delete('$basePath/tx-del');
              return next;
            }, maxAttempts: 4);

            expect(attempts, equals(2));
            expect(finalTotal, equals(30));
          });

          expect(
            (await firestore.doc('$basePath/tx-counter').get()).get('value'),
            equals(30),
          );
          expect(
            (await firestore.doc('$basePath/tx-log').get()).get('attempts'),
            equals(2),
          );
          expect(
            (await firestore.doc('$basePath/tx-del').get()).exists,
            isFalse,
          );

          final codecRef = firestore.doc('$basePath/codecs-doc');
          final targetRef = firestore.doc('users/$uid/links/ref-target');
          final fixedTs = Timestamp(1735689600, 456000000);
          const fixedGeo = GeoPoint(-33.8688, 151.2093);
          final fixedBlob = Blob(Uint8List.fromList(const <int>[0, 16, 128, 255]));

          await codecRef.set(<String, dynamic>{
            'ts': fixedTs,
            'geo': fixedGeo,
            'blob': fixedBlob,
            'ref': targetRef,
            'points': 10,
            'labels': <String>['red', 'blue', 'obsolete-tag'],
            'dropMe': 'temporary',
            'nested': <String, dynamic>{
              '__type': 'custom-domain-marker',
              'levels': <dynamic>[
                1,
                'two',
                <String, dynamic>{'flag': true},
              ],
            },
          });

          await codecRef.update(<FieldPath, dynamic>{
            FieldPath.fromString('serverTs'): fv.serverTimestamp(),
            FieldPath.fromString('dropMe'): fv.delete(),
            FieldPath.fromString('points'): fv.increment(7),
            FieldPath.fromString('labels'): fv.arrayUnion(<String>['green']),
          });
          await codecRef.update(<FieldPath, dynamic>{
            FieldPath.fromString('labels'):
                fv.arrayRemove(<String>['obsolete-tag']),
          });

          final revived = (await codecRef.get()).data()!;
          expect(revived['ts'], equals(fixedTs));
          expect(revived['geo'], equals(fixedGeo));
          expect((revived['blob'] as Blob).bytes, equals(fixedBlob.bytes));
          expect(
            (revived['ref'] as DocumentReferencePlatform).path,
            equals('users/$uid/links/ref-target'),
          );
          expect(revived['serverTs'], isA<Timestamp>());
          expect(revived.containsKey('dropMe'), isFalse);
          expect(revived['points'], equals(17));
          expect(
            revived['labels'],
            equals(<String>['red', 'blue', 'green']),
          );
          final nested = revived['nested'] as Map<String, dynamic>;
          expect(nested['__type'], equals('custom-domain-marker'));
          expect((nested['levels'] as List).length, equals(3));
        });
      },
    );
  });
}
