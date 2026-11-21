import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import 'firestore_live_host_helper.dart';

void main() {
  installLiveHostHttpOverrides();

  group('Firestore instance, lifecycle, document, collection, and metadata live-host conformance', () {
    test(
      'firestore-flutter#1 #3 #4 #5 #6 #7 #8: instance, settings, doc, collection, collectionGroup, batch, and runTransaction against live host',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) return;

        await withLiveFirestoreSession(bridgeUri, (session) async {
          final firestore = session.firestore;
          final uid = session.uid;

          expect(FirebaseFirestorePlatform.instance, isA<PyricFirestorePlatform>());

          const customSettings = Settings(
            host: '127.0.0.1:8080',
            sslEnabled: false,
            persistenceEnabled: true,
            cacheSizeBytes: Settings.CACHE_SIZE_UNLIMITED,
          );
          firestore.settings = customSettings;
          expect(firestore.settings.host, equals('127.0.0.1:8080'));
          expect(firestore.settings.sslEnabled, isFalse);
          expect(firestore.settings.persistenceEnabled, isTrue);
          expect(
            firestore.settings.cacheSizeBytes,
            equals(Settings.CACHE_SIZE_UNLIMITED),
          );

          final profileDoc = firestore.doc('users/$uid');
          expect(profileDoc.path, equals('users/$uid'));
          expect(profileDoc.id, equals(uid));

          final itemsCol = firestore.collection('users/$uid/items');
          expect(itemsCol.path, equals('users/$uid/items'));
          expect(itemsCol.id, equals('items'));

          final batch = firestore.batch();
          batch.set('users/$uid/rooms/alpha/entries/e1', <String, dynamic>{
            'ownerUid': uid,
            'room': 'alpha',
            'seq': 10,
          });
          batch.set('users/$uid/rooms/beta/entries/e2', <String, dynamic>{
            'ownerUid': uid,
            'room': 'beta',
            'seq': 20,
          });
          await batch.commit();

          final groupSnap = await firestore
              .collectionGroup('entries')
              .where(<List<dynamic>>[
                <dynamic>['ownerUid', '==', uid],
              ])
              .orderBy(const <List<dynamic>>[
                <dynamic>['seq', false],
              ])
              .get();
          expect(
            groupSnap.docs.map((d) => d.data()!['room']).toList(),
            equals(<String>['alpha', 'beta']),
          );

          await profileDoc.set(<String, dynamic>{'counter': 5});
          final txResult = await firestore.runTransaction<int>((txn) async {
            final snap = await txn.get('users/$uid');
            final nextVal = ((snap.data()?['counter'] as num?)?.toInt() ?? 0) + 7;
            txn.set('users/$uid', <String, dynamic>{'counter': nextVal});
            return nextVal;
          });
          expect(txResult, equals(12));
        });
      },
    );

    test(
      'firestore-flutter#9 #10 #11 #12 #13 #42: clearPersistence, offline network toggle, waitForPendingWrites, snapshotsInSync, Metadata, and terminate',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) return;

        await withLiveFirestoreSession(bridgeUri, (session) async {
          final uid = session.uid;

          await withDedicatedFirestoreClient(session, (auxClient, fs) async {
            await fs.clearPersistence();

            final docPath = 'users/$uid/items/lifecycle-doc';
            final docRef = fs.doc(docPath);

            await expectBridgeError(
              () => fs.clearPersistence(),
              allowedCodes: const <String>['failed-precondition'],
            );

            final syncEvents = <int>[];
            final syncCompleter = Completer<void>();
            final syncSub = fs.snapshotsInSync().listen((_) {
              syncEvents.add(syncEvents.length + 1);
              if (!syncCompleter.isCompleted) {
                syncCompleter.complete();
              }
            });
            await syncCompleter.future.timeout(const Duration(seconds: 5));
            expect(syncEvents, isNotEmpty);

            await docRef.set(<String, dynamic>{
              'phase': 'online-seed',
              'count': 1,
            });
            final onlineSnap = await docRef.get();
            expect(onlineSnap.exists, isTrue);
            expect(onlineSnap.metadata.isFromCache, isFalse);
            expect(onlineSnap.metadata.hasPendingWrites, isFalse);

            final cachedSeed = await docRef.get(
              const GetOptions(source: Source.cache),
            );
            expect(cachedSeed.data()?['phase'], equals('online-seed'));
            expect(cachedSeed.metadata.isFromCache, isTrue);

            await fs.waitForPendingWrites();

            final observedSnaps = <DocumentSnapshotPlatform>[];
            final offlineWriteSeen = Completer<void>();
            final onlineFlushSeen = Completer<void>();
            final docSub = docRef
                .snapshots(
                  includeMetadataChanges: true,
                  listenSource: ListenSource.defaultSource,
                )
                .listen((snap) {
              observedSnaps.add(snap);
              if (snap.data()?['phase'] == 'offline-staged' &&
                  snap.metadata.hasPendingWrites &&
                  !offlineWriteSeen.isCompleted) {
                offlineWriteSeen.complete();
              }
              if (snap.data()?['phase'] == 'offline-staged' &&
                  !snap.metadata.isFromCache &&
                  !snap.metadata.hasPendingWrites &&
                  !onlineFlushSeen.isCompleted) {
                onlineFlushSeen.complete();
              }
            });

            await Future<void>.delayed(const Duration(milliseconds: 80));
            final syncBeforeOffline = syncEvents.length;

            await fs.disableNetwork();

            await expectBridgeError(
              () => docRef.get(const GetOptions(source: Source.server)),
              allowedCodes: const <String>['unavailable'],
            );

            final stagedWriteFuture = docRef.set(
              <String, dynamic>{'phase': 'offline-staged', 'count': 2},
              SetOptions(merge: true),
            );

            await offlineWriteSeen.future.timeout(const Duration(seconds: 5));
            expect(syncEvents.length, greaterThan(syncBeforeOffline));

            final offlineSnap = await docRef.get();
            expect(offlineSnap.data()?['phase'], equals('offline-staged'));
            expect(offlineSnap.metadata.isFromCache, isTrue);
            expect(offlineSnap.metadata.hasPendingWrites, isTrue);

            var pendingResolved = false;
            final pendingWait = fs.waitForPendingWrites().then((_) {
              pendingResolved = true;
            });
            await Future<void>.delayed(const Duration(milliseconds: 50));
            expect(pendingResolved, isFalse);

            await fs.enableNetwork();
            await Future.wait(<Future<void>>[stagedWriteFuture, pendingWait]);
            expect(pendingResolved, isTrue);

            await onlineFlushSeen.future.timeout(const Duration(seconds: 5));

            final serverConfirmed = await session.firestore
                .doc(docPath)
                .get(const GetOptions(source: Source.server));
            expect(serverConfirmed.data()?['phase'], equals('offline-staged'));
            expect(serverConfirmed.data()?['count'], equals(2));
            expect(serverConfirmed.metadata.isFromCache, isFalse);
            expect(serverConfirmed.metadata.hasPendingWrites, isFalse);

            final streamDone = Completer<void>();
            final termSub = docRef
                .snapshots(listenSource: ListenSource.defaultSource)
                .listen(
              (_) {},
              onDone: () {
                if (!streamDone.isCompleted) {
                  streamDone.complete();
                }
              },
            );

            await syncSub.cancel();
            await docSub.cancel();
            await fs.terminate();
            await streamDone.future.timeout(const Duration(seconds: 5));
            await termSub.cancel();

            await expectBridgeError(
              () => fs.doc(docPath).get(),
              allowedCodes: const <String>['failed-precondition'],
            );

            await fs.clearPersistence();
          });

          await withDedicatedFirestoreClient(session, (_, freshFs) async {
            await expectBridgeError(
              () => freshFs
                  .doc('users/$uid/items/lifecycle-doc')
                  .get(const GetOptions(source: Source.cache)),
              allowedCodes: const <String>['unavailable'],
            );
          });
        });
      },
    );

    test(
      'firestore-flutter#14 #15 #16 #17 #18 #19 #20 #37 #38 #39 #40 #41: DocumentReference, CollectionReference, and DocumentSnapshot operations on live host',
      () async {
        final bridgeUri = resolveLiveBridgeUri();
        if (bridgeUri == null) return;

        await withLiveFirestoreSession(bridgeUri, (session) async {
          final firestore = session.firestore;
          final uid = session.uid;

          final userDoc = firestore.doc('users/$uid');
          final itemsCol =
              userDoc.collection('items') as PyricCollectionReference;
          expect(itemsCol.path, equals('users/$uid/items'));

          final autoDoc = itemsCol.doc();
          final autoId = autoDoc.path.split('/').last;
          expect(autoId.length, equals(20));

          final explicitDoc = itemsCol.doc('explicit-1');
          expect(explicitDoc.path, equals('users/$uid/items/explicit-1'));

          final missingSnap = await explicitDoc.get();
          expect(missingSnap.exists, isFalse);
          expect(missingSnap.data(), isNull);

          await expectBridgeError(
            () => explicitDoc.update(<FieldPath, dynamic>{
              FieldPath.fromString('title'): 'Ghost',
            }),
            allowedCodes: const <String>['not-found'],
          );

          await explicitDoc.set(<String, dynamic>{
            'title': 'Initial',
            'legacy': 'drop-on-overwrite',
          });
          await explicitDoc.set(<String, dynamic>{
            'title': 'Overwritten',
            'nested': <String, dynamic>{'tier': 1, 'region': 'west'},
          });

          final overwritten = await explicitDoc.get(
            const GetOptions(source: Source.server),
          );
          expect(overwritten.exists, isTrue);
          expect(overwritten.data()!.containsKey('legacy'), isFalse);
          expect(overwritten.get('title'), equals('Overwritten'));
          expect(
            overwritten.get(FieldPath.fromString('nested.tier')),
            equals(1),
          );
          expect(() => overwritten.get('nonexistent.path'), throwsStateError);

          await explicitDoc.set(
            const <String, dynamic>{
              'mergedFlag': true,
              'nested': <String, dynamic>{'tier': 2},
            },
            SetOptions(merge: true),
          );
          await explicitDoc.set(
            const <String, dynamic>{
              'selective': 'kept',
              'ignoredByMask': 'discarded',
            },
            SetOptions(mergeFields: <FieldPath>[
              FieldPath.fromString('selective'),
            ]),
          );
          await explicitDoc.update(<FieldPath, dynamic>{
            FieldPath.fromString('nested.region'): 'east',
          });

          final mergedSnap = await explicitDoc.get();
          final mergedData = mergedSnap.data()!;
          expect(mergedData['title'], equals('Overwritten'));
          expect(mergedData['mergedFlag'], isTrue);
          expect(mergedData['selective'], equals('kept'));
          expect(mergedData.containsKey('ignoredByMask'), isFalse);
          expect((mergedData['nested'] as Map)['tier'], equals(2));
          expect((mergedData['nested'] as Map)['region'], equals('east'));

          final addedRef = await itemsCol.add(<String, dynamic>{
            'title': 'AutoAdded',
            'rank': 9,
          });
          final addedSnap = await addedRef.get();
          expect(addedSnap.exists, isTrue);
          expect(addedSnap.get('title'), equals('AutoAdded'));

          final streamTitles = <String?>[];
          final deletedSeen = Completer<void>();
          final sub = explicitDoc
              .snapshots(listenSource: ListenSource.defaultSource)
              .listen((snap) {
            streamTitles.add(snap.exists ? snap.get('title') as String? : null);
            if (!snap.exists && !deletedSeen.isCompleted) {
              deletedSeen.complete();
            }
          });

          try {
            await Future<void>.delayed(const Duration(milliseconds: 80));
            await explicitDoc.delete();
            await deletedSeen.future.timeout(const Duration(seconds: 5));
            expect(streamTitles.first, equals('Overwritten'));
            expect(streamTitles.last, isNull);
          } finally {
            await sub.cancel();
          }

          expect((await explicitDoc.get()).exists, isFalse);
        });
      },
    );
  });
}
