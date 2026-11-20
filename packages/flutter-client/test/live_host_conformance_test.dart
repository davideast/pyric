import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart' show Firebase, FirebaseApp;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_database.dart' as rtdb;
import 'package:pyric_firestore/pyric_firestore.dart';

const FirebaseOptions _liveOptions = FirebaseOptions(
  apiKey: 'demo-flutter-live-api-key',
  appId: '1:1234567890:android:demoflutterlive',
  messagingSenderId: '1234567890',
  projectId: 'demo-flutter-live',
  databaseURL: 'https://demo-flutter-live-default-rtdb.firebaseio.com',
);

class _LiveHostFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = {};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? _liveOptions);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    return _apps.putIfAbsent(
      name,
      () => FirebaseAppPlatform(name, _liveOptions),
    );
  }
}

Future<void> _expectDenied(Future<Object?> Function() action) async {
  try {
    await action();
    fail('Expected PyricBridgeException permission denial, but call succeeded');
  } on PyricBridgeException catch (err) {
    final code = err.code.toLowerCase();
    expect(
      code == 'permission-denied' ||
          code == 'permission_denied' ||
          code.contains('permission'),
      isTrue,
      reason: 'Unexpected bridge error: ${err.code} (${err.message})',
    );
  }
}

Future<T> _withLiveClient<T>(
  Uri bridgeUri,
  Future<T> Function(
    FirebaseApp app,
    PyricBridgeClient client,
    PyricFirebaseAuthPlatform auth,
  ) body,
) async {
  FirebasePlatform.instance = _LiveHostFirebasePlatform();
  final app = await Firebase.initializeApp(
    name: 'flutter-live-${DateTime.now().microsecondsSinceEpoch}',
    options: _liveOptions,
  );
  final client = PyricBridgeClient(
    uri: bridgeUri,
    headers: <String, dynamic>{'Host': '${bridgeUri.host}:${bridgeUri.port}'},
  );
  final auth = PyricFirebaseAuthPlatform(appInstance: app, bridgeClient: client);
  PyricFirebaseAuthPlatform.registerWith(bridgeClient: client);
  FieldValueFactoryPlatform.instance = PyricFieldValueFactory();

  try {
    await client.connect();
    return await body(app, client, auth);
  } finally {
    await auth.dispose();
    await client.disconnect();
  }
}

void main() {
  HttpOverrides? previousHttpOverrides;

  setUp(() {
    previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
  });

  tearDown(() {
    HttpOverrides.global = previousHttpOverrides;
  });

  group('Pyric Flutter live-host conformance', () {
    test(
      'dart:io WebSocketChannel attaches, dispatches ops, streams snapshots, and answers heartbeats over loopback TCP',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final receivedFrames = <Map<String, dynamic>>[];
        final pongCompleter = Completer<String>();
        WebSocket? serverSocket;

        final serverTask = () async {
          await for (final req in server) {
            if (req.uri.path != '/__pyric/sandbox') {
              req.response.statusCode = HttpStatus.badRequest;
              await req.response.close();
              continue;
            }
            final ws = await WebSocketTransformer.upgrade(req);
            serverSocket = ws;
            ws.listen((dynamic raw) {
              final decoded = jsonDecode(raw as String) as Map<String, dynamic>;
              receivedFrames.add(decoded);
              final frameType = decoded['type'] as String?;
              if (frameType == 'attach') {
                ws.add(jsonEncode(<String, dynamic>{
                  'type': 'attach-ack',
                  'protocol': 1,
                  'bridgeVersion': '0.1.0-loopback',
                  'peerConnected': true,
                  'clientSessionId': 'flutter-loopback-session',
                  'capabilities': const ['pyric/firestore-values/1'],
                }));
                ws.add(jsonEncode(
                  const <String, dynamic>{'type': 'ping', 'id': 'srv-ping-1'},
                ));
              } else if (frameType == 'pong') {
                final pongId = decoded['id'] as String? ?? '';
                if (!pongCompleter.isCompleted && pongId == 'srv-ping-1') {
                  pongCompleter.complete(pongId);
                }
              } else if (frameType == 'worker-op') {
                final op = decoded['op'] as Map<String, dynamic>;
                ws.add(jsonEncode(<String, dynamic>{
                  'type': 'worker-res',
                  'id': decoded['id'],
                  'ok': true,
                  'value': <String, dynamic>{
                    'echoMethod': op['method'],
                    'echoPath': op['path'],
                  },
                }));
              } else if (frameType == 'worker-sub') {
                ws.add(jsonEncode(<String, dynamic>{
                  'type': 'worker-snap',
                  'subId': decoded['subId'],
                  'value': const {'exists': true, 'value': 'loopback-live'},
                }));
              }
            });
          }
        }();

        final uri = Uri.parse('ws://127.0.0.1:${server.port}/__pyric/sandbox');
        final client = PyricBridgeClient(
          uri: uri,
          headers: <String, dynamic>{'Host': '127.0.0.1:${server.port}'},
        );

        try {
          await client.connect();
          expect(client.isConnected, isTrue);
          expect(client.clientSessionId, equals('flutter-loopback-session'));

          final attach = receivedFrames.firstWhere((f) => f['type'] == 'attach');
          expect(attach['protocol'], equals(1));
          expect(attach['capabilities'], contains('pyric/firestore-values/1'));
          expect((attach['clientInfo'] as Map)['platform'], equals('flutter'));
          expect(
            await pongCompleter.future.timeout(const Duration(seconds: 5)),
            equals('srv-ping-1'),
          );

          final opRes = await client.op(
            'rtdb.get',
            const <String, dynamic>{'path': '/health/ping'},
          ) as Map;
          expect(opRes['echoMethod'], equals('rtdb.get'));
          expect(opRes['echoPath'], equals('/health/ping'));

          final snapStream = client.subscribeRaw(const <String, dynamic>{
            'target': <String, dynamic>{'service': 'rtdb', 'path': '/live'},
          });
          final snap =
              await snapStream.first.timeout(const Duration(seconds: 5)) as Map;
          expect(snap['value'], equals('loopback-live'));
        } finally {
          await client.disconnect();
          await serverSocket?.close();
          await server.close(force: true);
          await serverTask;
        }
      },
    );

    test(
      'Auth and 11-shard Realtime Database conformance over live Pyric bridge',
      () async {
        final rawBridgeUrl = Platform.environment['PYRIC_LIVE_BRIDGE_URL'];
        if (rawBridgeUrl == null || rawBridgeUrl.trim().isEmpty) return;
        final bridgeUri = Uri.parse(rawBridgeUrl.trim());

        await _withLiveClient(bridgeUri, (app, client, auth) async {
          rtdb.PyricDatabase shard(String url) => rtdb.PyricDatabase.instanceFor(
                app: app,
                databaseURL: url,
                bridgeClient: client,
                credentialsProvider: auth,
              );
          final mainDb = rtdb.PyricDatabase(
            app: app,
            bridgeClient: client,
            credentialsProvider: auth,
          );
          final shard00 = shard('https://shard-00.firebaseio.com');
          final shard01 = shard('https://shard-01.firebaseio.com');
          final shard09 = shard('https://shard-09.firebaseio.com');

          expect(mainDb.wireInstance, isNull);
          expect(shard00.wireInstance, equals('shard-00'));
          expect(shard01.wireInstance, equals('shard-01'));
          expect(shard09.wireInstance, equals('shard-09'));
          expect(auth.currentUser, isNull);

          await _expectDenied(
            () => mainDb.ref('users/unauthed').set({'displayName': 'Blocked'}),
          );
          await _expectDenied(() => shard00.ref('rooms/r1').get());
          expect((await shard01.ref('catalog/featured').get()).exists, isFalse);
          await _expectDenied(
            () => shard01.ref('catalog/featured').set({'title': 'ReadOnly'}),
          );

          final observedAuthUids = <String?>[];
          final authSub = auth.authStateChanges().listen((user) {
            observedAuthUids.add(user?.uid);
          });

          final created = await auth.createUserWithEmailAndPassword(
            'pilot@example.test',
            'correct-horse-battery',
          );
          final createdUser = created.user!;
          final emailUid = createdUser.uid;
          expect(emailUid, isNotEmpty);
          expect(createdUser.email, equals('pilot@example.test'));
          expect(createdUser.isAnonymous, isFalse);
          expect(auth.currentUser?.uid, equals(emailUid));

          expect((await createdUser.getIdToken(false))!.split('.').length, 3);
          final refreshed = await createdUser.getIdTokenResult(true);
          expect(refreshed.token!.split('.').length, equals(3));

          await createdUser.updateProfile(const {'displayName': 'Pilot One'});
          await createdUser.reload();
          expect(auth.currentUser?.displayName, equals('Pilot One'));

          final userRef = mainDb.ref('users/$emailUid');
          await userRef.set({
            'displayName': 'Pilot One',
            'rank': 'captain',
            'visits': 1,
          });
          await userRef.update({'region': 'orbit-1'});
          final ownProfile =
              Map<String, dynamic>.from((await userRef.get()).value as Map);
          expect(ownProfile['displayName'], equals('Pilot One'));
          expect(ownProfile['region'], equals('orbit-1'));

          await _expectDenied(
            () => mainDb.ref('users/other-uid').set({'displayName': 'Spoof'}),
          );

          final catalogRef = userRef.child('catalog');
          await catalogRef.child('a').set({'score': 10});
          await catalogRef.child('b').set({'score': 30});
          await catalogRef.child('c').set({'score': 20});
          final topTwo =
              await catalogRef.orderByChild('score').limitToLast(2).get();
          expect(
            topTwo.children.map((c) => c.key).toList(),
            equals(<String?>['c', 'b']),
          );

          final committedTx = await userRef.child('visits').runTransaction((m) {
            m.value = ((m.value as num?)?.toInt() ?? 0) + 1;
            return rtdb.Transaction.success(m);
          });
          expect(committedTx.committed, isTrue);
          expect(committedTx.snapshot.value, equals(2));

          final abortedTx = await userRef.child('visits').runTransaction((m) {
            m.value = 999;
            return rtdb.Transaction.abort();
          });
          expect(abortedTx.committed, isFalse);
          expect((await userRef.child('visits').get()).value, equals(2));

          final roomRef = shard00.ref('rooms/r1');
          final observedTopics = <String>[];
          final topicCompleter = Completer<void>();
          final roomSub = roomRef.onValue.listen((event) {
            if (!event.snapshot.exists) {
              observedTopics.add('<empty>');
            } else if (event.snapshot.value is Map) {
              final topic = (event.snapshot.value as Map)['topic'] as String?;
              if (topic != null) {
                observedTopics.add(topic);
                if (!topicCompleter.isCompleted) topicCompleter.complete();
              }
            }
          });

          try {
            await Future<void>.delayed(const Duration(milliseconds: 80));
            await roomRef.set({'owner': emailUid, 'topic': 'navigation'});
            await topicCompleter.future.timeout(const Duration(seconds: 5));
            expect(observedTopics, contains('navigation'));
          } finally {
            await roomSub.cancel();
          }

          await _expectDenied(
            () => roomRef.set({'owner': 'spoof-uid', 'topic': 'hijack'}),
          );
          await _expectDenied(() => shard01.ref('rooms/r1').get());
          await _expectDenied(
            () => shard01.ref('ops/deploy').set({'state': 'active'}),
          );
          await shard09.ref('shards/shard-09/status').set('ready');
          expect(
            (await shard09.ref('shards/shard-09/status').get()).value,
            equals('ready'),
          );
          await _expectDenied(
            () => shard09.ref('shards/shard-00/status').set('wrong-shard'),
          );

          await auth.signOut();
          expect(auth.currentUser, isNull);
          await _expectDenied(() => userRef.get());
          await _expectDenied(() => roomRef.get());

          final signedBackIn = await auth.signInWithEmailAndPassword(
            'pilot@example.test',
            'correct-horse-battery',
          );
          expect(signedBackIn.user?.uid, equals(emailUid));
          expect(
            ((await userRef.get()).value as Map)['displayName'],
            equals('Pilot One'),
          );

          await auth.signOut();
          final anonCred = await auth.signInAnonymously();
          expect(anonCred.user?.isAnonymous, isTrue);
          expect(anonCred.user?.uid, isNot(equals(emailUid)));
          expect(
            ((await roomRef.get()).value as Map)['topic'],
            equals('navigation'),
          );
          await _expectDenied(() => userRef.get());

          await authSub.cancel();
          expect(observedAuthUids, contains(emailUid));
        });
      },
    );

    test(
      'Cloud Firestore CRUD, merge writes, codecs, queries, aggregations, batches, transactions, snapshots, and Security Rules over live Pyric bridge',
      () async {
        final rawBridgeUrl = Platform.environment['PYRIC_LIVE_BRIDGE_URL'];
        if (rawBridgeUrl == null || rawBridgeUrl.trim().isEmpty) return;
        final bridgeUri = Uri.parse(rawBridgeUrl.trim());

        await _withLiveClient(bridgeUri, (app, client, auth) async {
          final firestore = PyricFirestorePlatform(
            app: app,
            bridgeClient: client,
            credentialsProvider: auth,
          );
          final fieldValues = FieldValueFactoryPlatform.instance;
          final recordedDenials = <PyricBridgeException>[];
          final denialSub = client.denialStream.listen(recordedDenials.add);

          try {
            await _expectDenied(
              () => firestore.doc('users/unauthed').set({'name': 'Blocked'}),
            );
            expect(recordedDenials, isNotEmpty);

            final created = await auth.createUserWithEmailAndPassword(
              'firestore-pilot@example.test',
              'correct-horse-battery',
            );
            final uid = created.user!.uid;
            final profileRef = firestore.doc('users/$uid');
            final linkedRef = firestore.doc('users/$uid/links/primary');
            final fixedTime = Timestamp(1730000000, 123000000);
            const fixedGeo = GeoPoint(37.7749, -122.4194);
            final fixedBytes =
                Blob(Uint8List.fromList(const <int>[1, 2, 3, 255]));

            await profileRef.set(<String, dynamic>{
              'displayName': 'Firestore Pilot',
              'visits': 1,
              'tags': <String>['alpha', 'beta'],
              'obsolete': 'remove-me',
              'createdAt': fixedTime,
              'home': fixedGeo,
              'avatar': fixedBytes,
              'primaryLink': linkedRef,
              'literalEnvelope': const <String, dynamic>{
                '__type': 'literal-user-tag',
                'nested': 'kept',
              },
              'profile': const {'rank': 'lieutenant', 'fleet': 'aurora'},
            });
            await profileRef.set(
              const <String, dynamic>{
                'mergedFlag': true,
                'profile': <String, dynamic>{'rank': 'commander'},
              },
              SetOptions(merge: true),
            );
            await profileRef.update(<FieldPath, dynamic>{
              FieldPath.fromString('visits'): fieldValues.increment(2),
              FieldPath.fromString('tags'):
                  fieldValues.arrayUnion(<dynamic>['gamma']),
              FieldPath.fromString('obsolete'): fieldValues.delete(),
              FieldPath.fromString('updatedAt'): fieldValues.serverTimestamp(),
            });

            final snap = await profileRef.get();
            final data = snap.data()!;
            expect(data['displayName'], equals('Firestore Pilot'));
            expect(data['mergedFlag'], isTrue);
            expect(data['visits'], equals(3));
            expect(data['tags'], equals(<String>['alpha', 'beta', 'gamma']));
            expect(data.containsKey('obsolete'), isFalse);
            expect(data['createdAt'], equals(fixedTime));
            expect(data['home'], equals(fixedGeo));
            expect((data['avatar'] as Blob).bytes, equals(fixedBytes.bytes));
            expect(data['updatedAt'], isA<Timestamp>());
            expect(
              (data['primaryLink'] as DocumentReferencePlatform).path,
              equals('users/$uid/links/primary'),
            );
            expect(
              (data['literalEnvelope'] as Map)['__type'],
              equals('literal-user-tag'),
            );
            expect((data['profile'] as Map)['rank'], equals('commander'));
            expect((data['profile'] as Map)['fleet'], equals('aurora'));

            await _expectDenied(
              () => firestore.doc('users/other-uid').set({'name': 'Intruder'}),
            );

            final itemsPath = 'users/$uid/items';
            final batch = firestore.batch();
            batch.set('$itemsPath/item-1', {'category': 'nav', 'score': 10});
            batch.set(
              '$itemsPath/item-1',
              {'mergedBatch': true},
              SetOptions(merge: true),
            );
            batch.set('$itemsPath/item-2', {'category': 'nav', 'score': 30});
            batch.set('$itemsPath/temp', {'category': 'scratch', 'score': 1});
            batch.update('$itemsPath/item-2', <FieldPath, dynamic>{
              FieldPath.fromString('score'): 40,
            });
            batch.delete('$itemsPath/temp');
            await batch.commit();

            final itemsCol =
                firestore.collection(itemsPath) as PyricCollectionReference;
            final addedRef =
                await itemsCol.add({'category': 'nav', 'score': 20});
            expect(addedRef.path.startsWith('$itemsPath/'), isTrue);

            final navQuery = firestore
                .collection(itemsPath)
                .where(const <List<dynamic>>[
                  <dynamic>['category', '==', 'nav'],
                ])
                .orderBy(const <List<dynamic>>[
                  <dynamic>['score', true],
                ]);
            final topNav = await navQuery.limit(2).get();
            expect(
              topNav.docs.map((doc) => doc.data()!['score']).toList(),
              equals(<int>[40, 20]),
            );

            final countSnap =
                await navQuery.count().get(source: AggregateSource.server);
            expect(countSnap.count, equals(3));

            final aggSnap = await navQuery
                .aggregate(sum('score'), average('score'))
                .get(source: AggregateSource.server);
            expect(aggSnap.getSum('score'), closeTo(70.0, 0.001));
            expect(aggSnap.getAverage('score'), closeTo(70.0 / 3.0, 0.001));

            final newVisits = await firestore.runTransaction<int>((txn) async {
              final currentSnap = await txn.get('users/$uid');
              final updated =
                  (currentSnap.data()!['visits'] as num).toInt() + 1;
              txn.update('users/$uid', <FieldPath, dynamic>{
                FieldPath.fromString('visits'): updated,
              });
              txn.set('$itemsPath/tx-receipt', {
                'category': 'receipt',
                'visitsAtCommit': updated,
              });
              return updated;
            });
            expect(newVisits, equals(4));

            final liveStatuses = <String>[];
            final updatedStatusCompleter = Completer<void>();
            final signOutDenialCompleter = Completer<Object>();
            final liveDocRef = firestore.doc('$itemsPath/live-beacon');
            await liveDocRef.set({'status': 'armed'});

            final snapSub = liveDocRef
                .snapshots(listenSource: ListenSource.defaultSource)
                .listen(
              (docSnap) {
                final status = docSnap.data()?['status'] as String?;
                if (status != null) {
                  liveStatuses.add(status);
                  if (status == 'active' &&
                      !updatedStatusCompleter.isCompleted) {
                    updatedStatusCompleter.complete();
                  }
                }
              },
              onError: (Object err) {
                if (!signOutDenialCompleter.isCompleted) {
                  signOutDenialCompleter.complete(err);
                }
              },
            );

            try {
              await Future<void>.delayed(const Duration(milliseconds: 80));
              await liveDocRef.update(<FieldPath, dynamic>{
                FieldPath.fromString('status'): 'active',
              });
              await updatedStatusCompleter.future
                  .timeout(const Duration(seconds: 5));
              expect(
                liveStatuses,
                containsAllInOrder(<String>['armed', 'active']),
              );

              await auth.signOut();
              final streamErr = await signOutDenialCompleter.future
                  .timeout(const Duration(seconds: 5));
              expect(streamErr, isA<PyricBridgeException>());
              expect(
                (streamErr as PyricBridgeException).code,
                equals('permission-denied'),
              );
            } finally {
              await snapSub.cancel();
            }
          } finally {
            await denialSub.cancel();
          }
        });
      },
    );
  });
}
