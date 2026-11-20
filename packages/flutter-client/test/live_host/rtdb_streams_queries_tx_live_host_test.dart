import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_database.dart';

import 'rtdb_live_host_helper.dart';

void main() {
  HttpOverrides? previousHttpOverrides;

  setUp(() {
    previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
  });

  tearDown(() {
    HttpOverrides.global = previousHttpOverrides;
  });

  group('6. Realtime Listeners & Streams (live host)', () {
    test(
      'rtdb-flutter#listen-value & rtdb-flutter#listen-cancel: streams initial and cross-client updates, unsubscribes on cancel, and revokes on signOut',
      () async {
        await runLiveRtdbTest((session) async {
          final statusRef = session.userRef('streams/status');
          await statusRef.set('booting');

          final secondary = await session.openSecondaryDatabaseConnection();
          final values = <Object?>[];
          final readyCompleter = Completer<void>();
          final remoteUpdateCompleter = Completer<void>();

          final sub = statusRef.onValue.listen((event) {
            final v = event.snapshot.value;
            values.add(v);
            if (v == 'booting' && !readyCompleter.isCompleted) {
              readyCompleter.complete();
            } else if (v == 'from-peer' && !remoteUpdateCompleter.isCompleted) {
              remoteUpdateCompleter.complete();
            }
          });

          try {
            await readyCompleter.future.timeout(const Duration(seconds: 5));
            await secondary.db
                .ref('users/${session.uid}/streams/status')
                .set('from-peer');
            await remoteUpdateCompleter.future
                .timeout(const Duration(seconds: 5));
            expect(
              values,
              containsAllInOrder(<Object?>['booting', 'from-peer']),
            );

            await sub.cancel();
            final countAfterCancel = values.length;
            await secondary.db
                .ref('users/${session.uid}/streams/status')
                .set('after-cancel');
            await Future<void>.delayed(const Duration(milliseconds: 80));
            expect(values.length, equals(countAfterCancel));

            // Active stream bound to auth lens revokes with PERMISSION_DENIED on signOut
            final revocationCompleter = Completer<Object>();
            final initialAuthed = Completer<void>();
            final gatedSub = statusRef.onValue.listen(
              (event) {
                if (event.snapshot.value == 'after-cancel' &&
                    !initialAuthed.isCompleted) {
                  initialAuthed.complete();
                }
              },
              onError: (Object err) {
                if (!revocationCompleter.isCompleted) {
                  revocationCompleter.complete(err);
                }
              },
            );
            try {
              await initialAuthed.future.timeout(const Duration(seconds: 5));
              await session.auth.signOut();
              final err = await revocationCompleter.future
                  .timeout(const Duration(seconds: 5));
              expect(err, isA<PyricBridgeException>());
              expect(
                (err as PyricBridgeException).code.toLowerCase(),
                contains('permission'),
              );
            } finally {
              await gatedSub.cancel();
            }
          } finally {
            await sub.cancel();
            await secondary.client.disconnect();
          }
        });
      },
    );

    test(
      'rtdb-flutter#listen-child-added, #listen-child-changed & #listen-child-removed: emits ordered child lifecycle events over live host',
      () async {
        await runLiveRtdbTest((session) async {
          final roomRef = session.userRef('streams/chatRoom');
          await roomRef.set(<String, dynamic>{
            'm1': <String, dynamic>{'text': 'Hello'},
            'm2': <String, dynamic>{'text': 'World'},
          });

          final added = <String>[];
          final addedPrevKeys = <String?>[];
          final changed = <String, Object?>{};
          final removed = <String>[];

          final initialAdded = Completer<void>();
          final m3Added = Completer<void>();
          final m1Changed = Completer<void>();
          final m2Removed = Completer<void>();

          final addedSub = roomRef.onChildAdded.listen((event) {
            final k = event.snapshot.key!;
            added.add(k);
            addedPrevKeys.add(event.previousChildKey);
            if (added.length == 2 && !initialAdded.isCompleted) {
              initialAdded.complete();
            } else if (k == 'm3' && !m3Added.isCompleted) {
              m3Added.complete();
            }
          });
          final changedSub = roomRef.onChildChanged.listen((event) {
            final k = event.snapshot.key!;
            changed[k] = event.snapshot.value;
            if (k == 'm1' && !m1Changed.isCompleted) {
              m1Changed.complete();
            }
          });
          final removedSub = roomRef.onChildRemoved.listen((event) {
            final k = event.snapshot.key!;
            removed.add(k);
            if (k == 'm2' && !m2Removed.isCompleted) {
              m2Removed.complete();
            }
          });

          try {
            await initialAdded.future.timeout(const Duration(seconds: 5));
            expect(added, equals(<String>['m1', 'm2']));
            expect(addedPrevKeys, equals(<String?>[null, 'm1']));

            await roomRef.child('m3').set(<String, dynamic>{'text': 'Encore'});
            await m3Added.future.timeout(const Duration(seconds: 5));
            expect(added, equals(<String>['m1', 'm2', 'm3']));
            expect(addedPrevKeys.last, equals('m2'));

            await roomRef
                .child('m1')
                .set(<String, dynamic>{'text': 'Hello Edited'});
            await m1Changed.future.timeout(const Duration(seconds: 5));
            expect(
              changed['m1'],
              equals(<String, dynamic>{'text': 'Hello Edited'}),
            );

            await roomRef.child('m2').remove();
            await m2Removed.future.timeout(const Duration(seconds: 5));
            expect(removed, equals(<String>['m2']));
          } finally {
            await addedSub.cancel();
            await changedSub.cancel();
            await removedSub.cancel();
          }
        });
      },
    );
  });

  group('7. Query Ordering, Filtering & Limits (live host)', () {
    test(
      'rtdb-flutter#query-order-by-child, #query-order-by-key, #query-order-by-value, #query-equal-to, #query-range & #query-limit',
      () async {
        await runLiveRtdbTest((session) async {
          // users/$uid/catalog has .indexOn: ['score', 'role', 'meta/rank', '.value'] in MAIN_RULES
          final catalogRef = session.userRef('catalog');
          await catalogRef.set(<String, dynamic>{
            'p10': <String, dynamic>{
              'score': 30,
              'role': 'pilot',
              'meta': <String, dynamic>{'rank': 3},
            },
            'p2': <String, dynamic>{
              'score': 10,
              'role': 'engineer',
              'meta': <String, dynamic>{'rank': 1},
            },
            'p3': <String, dynamic>{
              'score': 20,
              'role': 'pilot',
              'meta': <String, dynamic>{'rank': 2},
            },
            'p4': <String, dynamic>{
              'score': 20,
              'role': 'medic',
              'meta': <String, dynamic>{'rank': 4},
            },
          });

          final byScore = await catalogRef.orderByChild('score').get();
          expect(
            byScore.children.map((c) => c.key).toList(),
            equals(<String?>['p2', 'p3', 'p4', 'p10']),
          );

          final byNestedRank = await catalogRef.orderByChild('meta/rank').get();
          expect(
            byNestedRank.children.map((c) => c.key).toList(),
            equals(<String?>['p2', 'p3', 'p10', 'p4']),
          );

          // Firebase RTDB nameCompare orders integer keys numerically ('2' before '10')
          final numericKeysRef = session.userRef('keyOrder');
          await numericKeysRef.set(<String, dynamic>{
            '10': 'ten',
            '2': 'two',
            'alpha': 'a',
          });
          final byKey = await numericKeysRef.orderByKey().get();
          expect(
            byKey.children.map((c) => c.key).toList(),
            equals(<String?>['2', '10', 'alpha']),
          );

          // users/$uid/scores has .indexOn: ['.value'] in MAIN_RULES
          final scoresRef = session.userRef('scores');
          await scoresRef.set(<String, dynamic>{
            'charlie': 300,
            'alice': 100,
            'bob': 200,
          });
          final byValue = await scoresRef.orderByValue().get();
          expect(
            byValue.children.map((c) => c.key).toList(),
            equals(<String?>['alice', 'bob', 'charlie']),
          );

          // equalTo(value) and equalTo(value, key: ...)
          final scoreTwentyAll =
              await catalogRef.orderByChild('score').equalTo(20).get();
          expect(
            scoreTwentyAll.children.map((c) => c.key).toList(),
            equals(<String?>['p3', 'p4']),
          );
          final scoreTwentySingle = await catalogRef
              .orderByChild('score')
              .equalTo(20, key: 'p4')
              .get();
          expect(
            scoreTwentySingle.children.map((c) => c.key).toList(),
            equals(<String?>['p4']),
          );

          // startAt / endAt inclusive range + startAfter / endBefore exclusive range
          final inclusiveRange = await catalogRef
              .orderByChild('score')
              .startAt(20)
              .endAt(30)
              .get();
          expect(
            inclusiveRange.children.map((c) => c.key).toList(),
            equals(<String?>['p3', 'p4', 'p10']),
          );
          final exclusiveRange = await catalogRef
              .orderByChild('score')
              .startAfter(10)
              .endBefore(30)
              .get();
          expect(
            exclusiveRange.children.map((c) => c.key).toList(),
            equals(<String?>['p3', 'p4']),
          );

          // limitToFirst / limitToLast on both get() and live onValue stream
          final firstTwo = await catalogRef
              .orderByChild('score')
              .limitToFirst(2)
              .get();
          expect(
            firstTwo.children.map((c) => c.key).toList(),
            equals(<String?>['p2', 'p3']),
          );
          final lastTwo = await catalogRef
              .orderByChild('score')
              .limitToLast(2)
              .get();
          expect(
            lastTwo.children.map((c) => c.key).toList(),
            equals(<String?>['p4', 'p10']),
          );

          final liveTopEvent = await catalogRef
              .orderByChild('score')
              .limitToLast(1)
              .onValue
              .first
              .timeout(const Duration(seconds: 5));
          expect(
            liveTopEvent.snapshot.children.map((c) => c.key).toList(),
            equals(<String?>['p10']),
          );

          // Unindexed orderByChild on path lacking .indexOn rejects on live host
          final unindexedRef = session.userRef('unindexedCollection');
          await unindexedRef.set(<String, dynamic>{
            'a': <String, dynamic>{'customField': 1},
          });
          await expectLater(
            unindexedRef.orderByChild('customField').get(),
            throwsA(isA<PyricBridgeException>()),
          );
        });
      },
    );
  });

  group('8. Transactions & OnDisconnect (live host)', () {
    test(
      'rtdb-flutter#tx-run & rtdb-flutter#tx-abort: commits scalar and in-place Map CAS writes, retries contention, and aborts cleanly',
      () async {
        await runLiveRtdbTest((session) async {
          final balanceRef = session.userRef('tx/balance');
          await balanceRef.set(100);

          final scalarTx = await balanceRef.runTransaction((mutableData) {
            final current = (mutableData.value as int?) ?? 0;
            mutableData.value = current + 45;
            return Transaction.success(mutableData);
          });
          expect(scalarTx.committed, isTrue);
          expect(scalarTx.snapshot.value, equals(145));
          expect((await balanceRef.get()).value, equals(145));

          // In-place Map mutation inside transactionHandler must preserve pre-tx CAS expected snapshot
          final docRef = session.userRef('tx/ledgerDoc');
          await docRef.set(<String, dynamic>{'credits': 10, 'owner': session.uid});
          final mapTx = await docRef.runTransaction((mutableData) {
            final map = mutableData.value as Map<String, dynamic>;
            map['credits'] = (map['credits'] as int) + 15;
            return Transaction.success(mutableData);
          });
          expect(mapTx.committed, isTrue);
          expect(
            mapTx.snapshot.value,
            equals(<String, dynamic>{'credits': 25, 'owner': session.uid}),
          );

          // Concurrent contention from a second live client triggers optimistic retry and converges
          final secondary = await session.openSecondaryDatabaseConnection();
          try {
            int handlerInvocations = 0;
            final contendedResult = await balanceRef.runTransaction((
              mutableData,
            ) async {
              handlerInvocations += 1;
              final observed = (mutableData.value as int?) ?? 0;
              if (handlerInvocations == 1) {
                await secondary.db
                    .ref('users/${session.uid}/tx/balance')
                    .set(200);
              }
              mutableData.value = observed + 10;
              return Transaction.success(mutableData);
            });
            expect(handlerInvocations, equals(2));
            expect(contendedResult.committed, isTrue);
            expect(contendedResult.snapshot.value, equals(210));
            expect((await balanceRef.get()).value, equals(210));
          } finally {
            await secondary.client.disconnect();
          }

          // Transaction.abort() leaves server untouched and preserves unmutated pre-tx snapshot
          final abortedResult = await docRef.runTransaction((mutableData) {
            final map = mutableData.value as Map<String, dynamic>;
            map['credits'] = 9999;
            return Transaction.abort();
          });
          expect(abortedResult.committed, isFalse);
          expect(
            abortedResult.snapshot.value,
            equals(<String, dynamic>{'credits': 25, 'owner': session.uid}),
          );
          expect(
            (await docRef.get()).value,
            equals(<String, dynamic>{'credits': 25, 'owner': session.uid}),
          );
        });
      },
    );

    test(
      'rtdb-flutter#ondisconnect-set-remove & rtdb-flutter#ondisconnect-cancel: executes queued set/remove on goOffline and socket close, and honors cancel',
      () async {
        await runLiveRtdbTest((session) async {
          // 1. Cancellation + goOffline() drain on isolated shard-02 handle
          final shard02 = PyricDatabase.instanceFor(
            app: session.app,
            databaseURL: 'https://shard-02.firebaseio.com',
          );
          final statusRef = shard02.ref('shards/shard-02/${session.uid}/status');
          final ephemeralRef = shard02.ref(
            'shards/shard-02/${session.uid}/ephemeral',
          );
          final keepRef = shard02.ref('shards/shard-02/${session.uid}/keep');

          await statusRef.set('online');
          await ephemeralRef.set('temp-session');
          await keepRef.set('preserved');

          await statusRef.onDisconnect().set(<String, dynamic>{
            'state': 'offline',
            'disconnectedAt': ServerValue.timestamp,
          });
          await ephemeralRef.onDisconnect().remove();
          await keepRef.onDisconnect().set('overwritten-if-not-cancelled');
          await keepRef.onDisconnect().cancel();

          await shard02.goOffline();
          await shard02.goOnline();

          final afterDisconnectStatus =
              (await statusRef.get()).value as Map<dynamic, dynamic>;
          expect(afterDisconnectStatus['state'], equals('offline'));
          expect(afterDisconnectStatus['disconnectedAt'], isA<int>());
          expect((await ephemeralRef.get()).exists, isFalse);
          expect((await keepRef.get()).value, equals('preserved'));

          // 2. Real TCP/WebSocket close from a secondary PyricBridgeClient triggers host onDisconnect
          final secondary = await session.openSecondaryDatabaseConnection();
          final socketPresenceRef = session.userRef('tx/socketPresence');
          await secondary.db
              .ref(socketPresenceRef.path)
              .set('connected-secondary');
          await secondary.db
              .ref(socketPresenceRef.path)
              .onDisconnect()
              .set('severed-secondary');

          expect(
            (await socketPresenceRef.get()).value,
            equals('connected-secondary'),
          );
          await secondary.client.disconnect();
          await Future<void>.delayed(const Duration(milliseconds: 80));
          expect(
            (await socketPresenceRef.get()).value,
            equals('severed-secondary'),
          );
        });
      },
    );
  });
}
