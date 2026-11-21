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

  group('1. Database Instance & Connection (live host)', () {
    test(
      'rtdb-flutter#instance-default & rtdb-flutter#instance-url: isolates default and multi-shard URLs across data and Security Rules',
      () async {
        await runLiveRtdbTest((session) async {
          final defaultDb = PyricDatabase.instance;
          expect(defaultDb.bridgeClient, same(session.client));

          final shard00 = PyricDatabase.instanceFor(
            app: session.app,
            databaseURL: 'https://shard-00.firebaseio.com',
          );
          final shard00Cached = PyricDatabase.instanceFor(
            app: session.app,
            databaseURL: 'https://shard-00.firebaseio.com',
          );
          expect(shard00Cached, same(shard00));

          final shard01 = PyricDatabase.instanceFor(
            app: session.app,
            databaseURL:
                'https://shard-01.europe-west1.firebasedatabase.app',
          );
          final shard02 = PyricDatabase.instanceFor(
            app: session.app,
            databaseURL: 'https://shard-02.firebaseio.com',
          );

          await session.userRef('instanceCheck').set('on-default');
          expect(
            (await session.userRef('instanceCheck').get()).value,
            equals('on-default'),
          );

          final roomId = 'room-${session.uid}';
          await expectRtdbPermissionDenied(
            () => shard00.ref('rooms/$roomId').set(<String, dynamic>{
              'owner': 'someone-else',
              'topic': 'forged',
            }),
          );
          await shard00.ref('rooms/$roomId').set(<String, dynamic>{
            'owner': session.uid,
            'topic': 'isolated-shard-00',
          });
          expect(
            ((await shard00.ref('rooms/$roomId').get()).value as Map)['topic'],
            equals('isolated-shard-00'),
          );

          // shard-01 has public read on /catalog/$itemId, write: false, and role=="ops" on /ops
          final publicCatalogSnap = await shard01.ref('catalog/item-1').get();
          expect(publicCatalogSnap.exists, isFalse);
          await expectRtdbPermissionDenied(
            () => shard01.ref('catalog/item-1').set('denied-write'),
          );
          await expectRtdbPermissionDenied(
            () => shard01.ref('ops/op-1').get(),
          );

          // shard-02 stores independent data invisible on default and shard-00
          await shard02
              .ref('shards/shard-02/${session.uid}')
              .set(<String, dynamic>{'state': 'isolated'});
          expect(
            ((await shard02.ref('shards/shard-02/${session.uid}').get()).value
                as Map)['state'],
            equals('isolated'),
          );
          await expectRtdbPermissionDenied(
            () => defaultDb.ref('shards/shard-02/${session.uid}').get(),
          );
        });
      },
    );

    test(
      'rtdb-flutter#ref-root & rtdb-flutter#ref-path: root and slash-delimited path references enforce live-host paths and rules',
      () async {
        await runLiveRtdbTest((session) async {
          final rootRef = session.db.ref();
          expect(rootRef.path, equals('/'));
          expect(rootRef.key, isNull);
          expect(rootRef.parent, isNull);
          await expectRtdbPermissionDenied(() => rootRef.get());

          final profileRef = session.db.ref('users/${session.uid}/profile');
          expect(profileRef.path, equals('/users/${session.uid}/profile'));
          expect(profileRef.key, equals('profile'));
          await profileRef.set(<String, dynamic>{'handle': 'navigator'});
          expect(
            ((await profileRef.get()).value as Map)['handle'],
            equals('navigator'),
          );

          await expectRtdbPermissionDenied(
            () => session.db.ref('users/other-uid/profile').get(),
          );
        });
      },
    );

    test(
      'rtdb-flutter#connection-toggle, rtdb-flutter#info-connected & rtdb-flutter#info-root-offset: client-served .info tracks attach, goOffline/goOnline, and disconnect',
      () async {
        final bridgeUri = liveBridgeUriFromEnv();
        if (bridgeUri == null) return;

        final freshClient = PyricBridgeClient(
          uri: bridgeUri,
          headers: <String, dynamic>{
            'Host': '${bridgeUri.host}:${bridgeUri.port}',
          },
        );
        final freshAuth = PyricFirebaseAuthPlatform(bridgeClient: freshClient);
        final freshDb = PyricDatabase(
          bridgeClient: freshClient,
          credentialsProvider: freshAuth,
        );

        final connectedEvents = <bool>[];
        final firstFalse = Completer<void>();
        final attachedTrue = Completer<void>();
        final sub = freshDb.ref('.info/connected').onValue.listen((event) {
          final flag = event.snapshot.value == true;
          connectedEvents.add(flag);
          if (!flag && !firstFalse.isCompleted) {
            firstFalse.complete();
          } else if (flag && !attachedTrue.isCompleted) {
            attachedTrue.complete();
          }
        });

        try {
          await firstFalse.future.timeout(const Duration(seconds: 5));
          await attachedTrue.future.timeout(const Duration(seconds: 5));
          expect(connectedEvents.take(2).toList(), equals(<bool>[false, true]));

          final created = await freshAuth.createUserWithEmailAndPassword(
            '${nextUniqueLiveId('info')}@example.test',
            'correct-horse-battery',
          );
          final uid = created.user!.uid;
          final presenceRef = freshDb.ref('users/$uid/presence');
          await presenceRef.set('online');
          await presenceRef.onDisconnect().set('offline-via-toggle');

          final infoRoot = await freshDb.ref('.info').onValue.first;
          expect(
            infoRoot.snapshot.value,
            equals(<String, dynamic>{'connected': true, 'serverTimeOffset': 0}),
          );
          final offsetSnap = await freshDb.ref('.info/serverTimeOffset').get();
          expect(offsetSnap.exists, isTrue);
          expect(offsetSnap.value, equals(0));
          final unknownInfo = await freshDb.ref('.info/authenticated').get();
          expect(unknownInfo.exists, isFalse);
          expect(unknownInfo.value, isNull);

          await freshDb.goOffline();
          expect(
            (await freshDb.ref('.info/connected').get()).value,
            isFalse,
          );
          expect((await presenceRef.get()).value, equals('offline-via-toggle'));

          await freshDb.goOnline();
          expect((await freshDb.ref('.info/connected').get()).value, isTrue);
          await presenceRef.set('back-online');
          expect((await presenceRef.get()).value, equals('back-online'));
          expect(
            connectedEvents,
            equals(<bool>[false, true, false, true]),
          );
        } finally {
          await sub.cancel();
          await freshAuth.dispose();
          await freshClient.disconnect();
        }
      },
    );
  });

  group('2. DatabaseReference Navigation & Properties (live host)', () {
    test(
      'rtdb-flutter#ref-child, #ref-parent, #ref-root-prop, #ref-key, #ref-path-prop, #ref-push & #ref-push-key-ordering',
      () async {
        await runLiveRtdbTest((session) async {
          final baseRef = session.userRef('tree');
          final leafRef = baseRef.child('branch/leaf');
          expect(
            leafRef.path,
            equals('/users/${session.uid}/tree/branch/leaf'),
          );
          expect(leafRef.key, equals('leaf'));
          expect(
            leafRef.parent?.path,
            equals('/users/${session.uid}/tree/branch'),
          );
          expect(leafRef.parent?.parent?.path, equals(baseRef.path));
          expect(leafRef.root.path, equals('/'));
          expect(leafRef.root.key, isNull);

          final messyRef = session.db.ref(
            '///users//${session.uid}///normalized//node///',
          );
          expect(
            messyRef.path,
            equals('/users/${session.uid}/normalized/node'),
          );
          await messyRef.set('canonical');
          expect(
            (await session.userRef('normalized/node').get()).value,
            equals('canonical'),
          );

          final feedRef = session.userRef('feed');
          final generatedKeys = <String>[];
          for (int i = 0; i < 12; i++) {
            final pushed = feedRef.push();
            expect(pushed.key, isNotNull);
            expect(pushed.key!.length, equals(20));
            expect(pushed.path, equals('${feedRef.path}/${pushed.key}'));
            generatedKeys.add(pushed.key!);
            await pushed.set(<String, dynamic>{'seq': i});
          }
          expect(generatedKeys.toSet().length, equals(12));
          final sortedKeys = List<String>.from(generatedKeys)..sort();
          expect(generatedKeys, equals(sortedKeys));

          final orderedSnap = await feedRef.orderByKey().get();
          expect(
            orderedSnap.children.map((c) => c.key).toList(),
            equals(generatedKeys),
          );
          expect(
            orderedSnap.children
                .map((c) => (c.value as Map)['seq'] as int)
                .toList(),
            equals(List<int>.generate(12, (index) => index)),
          );
        });
      },
    );
  });

  group('3. Write Operations & 4. ServerValue Sentinels (live host)', () {
    test(
      'rtdb-flutter#write-set, #write-set-null, #write-set-priority, #write-set-with-priority, #write-update & #write-remove',
      () async {
        await runLiveRtdbTest((session) async {
          final profileRef = session.userRef('writes/profile');
          await profileRef.set(<String, dynamic>{
            'name': 'Ada',
            'role': 'architect',
            'active': true,
          });
          expect(
            (await profileRef.get()).value,
            equals(<String, dynamic>{
              'name': 'Ada',
              'role': 'architect',
              'active': true,
            }),
          );

          await profileRef.set(null);
          final afterNull = await profileRef.get();
          expect(afterNull.exists, isFalse);
          expect(afterNull.value, isNull);

          final prioNode = session.userRef('writes/ranked/alpha');
          await prioNode.set('payload-alpha');
          await prioNode.setPriority(20);
          final prioSnap = await prioNode.get();
          expect(prioSnap.value, equals('payload-alpha'));
          expect(prioSnap.priority, equals(20));

          final betaNode = session.userRef('writes/ranked/beta');
          await betaNode.setWithPriority(<String, dynamic>{'tier': 1}, 5);
          final betaSnap = await betaNode.get();
          expect(betaSnap.value, equals(<String, dynamic>{'tier': 1}));
          expect(betaSnap.priority, equals(5));

          // Default priority ordering places beta (priority 5) before alpha (priority 20)
          final rankedParent = await session.userRef('writes/ranked').get();
          expect(
            rankedParent.children.map((c) => c.key).toList(),
            equals(<String?>['beta', 'alpha']),
          );

          // Shallow + multi-path update preserving omitted siblings and deleting null targets
          final accountRef = session.userRef('writes/account');
          await accountRef.set(<String, dynamic>{
            'name': 'Grace',
            'city': 'New York',
            'legacy': 'drop-me',
            'meta': <String, dynamic>{'level': 1, 'badge': 'founder'},
          });
          await accountRef.update(<String, Object?>{
            'city': 'Arlington',
            'legacy': null,
            'meta/level': 2,
          });
          expect(
            (await accountRef.get()).value,
            equals(<String, dynamic>{
              'name': 'Grace',
              'city': 'Arlington',
              'meta': <String, dynamic>{'level': 2, 'badge': 'founder'},
            }),
          );

          final doomedRef = session.userRef('writes/removeTarget');
          await doomedRef.set(<String, dynamic>{
            'childA': 1,
            'childB': <String, dynamic>{'deep': true},
          });
          expect((await doomedRef.get()).exists, isTrue);
          await doomedRef.remove();
          expect((await doomedRef.get()).exists, isFalse);
        });
      },
    );

    test(
      'rtdb-flutter#sentinel-timestamp & rtdb-flutter#sentinel-increment: resolves server timestamp and atomic increments on live host',
      () async {
        await runLiveRtdbTest((session) async {
          final eventRef = session.userRef('sentinels/event');
          final beforeWriteMs = DateTime.now().millisecondsSinceEpoch - 5000;
          await eventRef.set(<String, dynamic>{
            'createdAt': ServerValue.timestamp,
            'views': ServerValue.increment(5),
          });
          final initialSnap = await eventRef.get();
          final initialMap = initialSnap.value as Map;
          expect(initialMap['createdAt'], isA<int>());
          expect(initialMap['createdAt'] as int, greaterThan(beforeWriteMs));
          expect(initialMap['views'], equals(5));

          await eventRef.update(<String, Object?>{
            'views': ServerValue.increment(7),
            'updatedAt': ServerValue.timestamp,
          });
          expect(
            ((await eventRef.get()).value as Map)['views'],
            equals(12),
          );

          await eventRef.child('views').set(ServerValue.increment(-4));
          expect((await eventRef.child('views').get()).value, equals(8));
        });
      },
    );
  });

  group('5. One-Shot Reads & DataSnapshot Inspection (live host)', () {
    test(
      'rtdb-flutter#read-get, #snap-exists, #snap-key, #snap-value, #snap-children, #snap-child-path & #snap-priority',
      () async {
        await runLiveRtdbTest((session) async {
          final falsyRef = session.userRef('snapshots/falsyBool');
          await falsyRef.set(false);
          final falsySnap = await falsyRef.get();
          expect(falsySnap.exists, isTrue);
          expect(falsySnap.key, equals('falsyBool'));
          expect(falsySnap.value, isFalse);

          final missingSnap = await session.userRef('snapshots/absent').get();
          expect(missingSnap.exists, isFalse);
          expect(missingSnap.key, equals('absent'));
          expect(missingSnap.value, isNull);

          final orgRef = session.userRef('snapshots/org');
          await orgRef.setWithPriority(<String, dynamic>{
            'department': <String, dynamic>{
              'lead': <String, dynamic>{'name': 'Margaret', 'tenure': 9},
            },
            'tags': <String>['flight', 'apollo', 'guidance'],
          }, 'p-org');
          await orgRef.child('department').setPriority('p-dept');

          final orgSnap = await orgRef.get();
          expect(orgSnap.exists, isTrue);
          expect(orgSnap.key, equals('org'));
          expect(orgSnap.priority, equals('p-org'));
          expect(
            orgSnap.children.map((c) => c.key).toList(),
            containsAll(<String>['department', 'tags']),
          );

          final leadName = orgSnap.child('department/lead/name');
          expect(leadName.exists, isTrue);
          expect(leadName.key, equals('name'));
          expect(leadName.value, equals('Margaret'));
          expect(orgSnap.child('department').priority, equals('p-dept'));

          final tagsSnap = orgSnap.child('tags');
          expect(
            tagsSnap.value,
            equals(<Object?>['flight', 'apollo', 'guidance']),
          );
          expect(tagsSnap.child('1').exists, isTrue);
          expect(tagsSnap.child('1').value, equals('apollo'));
          expect(orgSnap.child('department/missing').exists, isFalse);
        });
      },
    );
  });
}
