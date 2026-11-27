import 'dart:async';

import 'package:cloud_firestore_platform_interface/cloud_firestore_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_debug.dart';
import 'package:pyric_firestore/pyric_firestore.dart'
    hide AuthLens, PyricAuthCredentialsProvider;

import 'auth/mock_bridge_helper.dart';

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late PyricFirebaseAuthPlatform auth;
  late PyricFirestorePlatform firestore;

  setUp(() async {
    setupMockFirebase();
    harness = MockBridgeHarness();
    client = harness.createClient();
    harness.channel.toServerController.stream.listen((raw) {
      if (raw is String && raw.contains('"type":"attach"')) {
        harness.ackAttach(clientSessionId: 'sess-isolation-1');
      }
    });
    auth = PyricFirebaseAuthPlatform(bridgeClient: client);
    firestore = PyricFirestorePlatform(
      bridgeClient: client,
      credentialsProvider: auth,
    );
    await client.connect();
    await pumpEventQueue();
  });

  tearDown(() async {
    await firestore.terminate();
    await firestore.clearPersistence();
    await auth.dispose();
    await harness.dispose();
  });

  group('C1-02: cross-user Firestore persistence cache isolation', () {
    test('Source.cache does not leak Alice private doc to anon or Bob', () async {
      auth.switchAuthLens(AuthLens.asUser(uid: 'alice-uid'));
      await pumpEventQueue();

      final docRef = firestore.doc('playlists/pl-alice-commute');
      final getFuture = docRef.get(const GetOptions(source: Source.server));
      await pumpEventQueue();

      final op = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'getDoc',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': op['id'],
        'ok': true,
        'value': {
          'id': 'pl-alice-commute',
          'path': 'playlists/pl-alice-commute',
          'exists': true,
          'data': {'title': 'Morning Commute', 'ownerUid': 'alice-uid'},
        },
      });

      final aliceSnap = await getFuture;
      expect(aliceSnap.data()?['title'], 'Morning Commute');

      final aliceCached = await docRef.get(const GetOptions(source: Source.cache));
      expect(aliceCached.exists, isTrue);
      expect(aliceCached.data()?['title'], 'Morning Commute');

      auth.switchAuthLens(AuthLens.anon);
      await pumpEventQueue();
      await expectLater(
        docRef.get(const GetOptions(source: Source.cache)),
        throwsA(isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable')),
      );

      auth.switchAuthLens(AuthLens.asUser(uid: 'bob-uid'));
      await pumpEventQueue();
      await expectLater(
        docRef.get(const GetOptions(source: Source.cache)),
        throwsA(isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable')),
      );

      // Different tenant under same UID is also partitioned.
      auth.switchAuthLens(AuthLens.asUser(uid: 'alice-uid', tenant: 'tenant-b'));
      await pumpEventQueue();
      await expectLater(
        docRef.get(const GetOptions(source: Source.cache)),
        throwsA(isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable')),
      );
    });

    test('in-flight getDoc started as Alice records into Alice scope after switch to Bob', () async {
      auth.switchAuthLens(AuthLens.asUser(uid: 'alice-uid'));
      await pumpEventQueue();

      final docRef = firestore.doc('playlists/pl-inflight');
      final aliceFuture = docRef.get(const GetOptions(source: Source.server));
      await pumpEventQueue();

      final op = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'getDoc',
      );

      // Switch to Bob before Alice's getDoc response returns.
      auth.switchAuthLens(AuthLens.asUser(uid: 'bob-uid'));
      await pumpEventQueue();

      harness.sendToClient({
        'type': 'worker-res',
        'id': op['id'],
        'ok': true,
        'value': {
          'id': 'pl-inflight',
          'path': 'playlists/pl-inflight',
          'exists': true,
          'data': {'title': 'Alice Secret'},
        },
      });
      await aliceFuture;

      await expectLater(
        docRef.get(const GetOptions(source: Source.cache)),
        throwsA(isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable')),
      );

      auth.switchAuthLens(AuthLens.asUser(uid: 'alice-uid'));
      await pumpEventQueue();
      final aliceCached = await docRef.get(const GetOptions(source: Source.cache));
      expect(aliceCached.data()?['title'], 'Alice Secret');
    });

    test('staged offline writes under Alice do not project into Bob cache', () async {
      auth.switchAuthLens(AuthLens.asUser(uid: 'alice-uid'));
      await pumpEventQueue();
      await firestore.disableNetwork();

      final docRef = firestore.doc('playlists/pl-offline-alice');
      docRef.set({'title': 'Offline Draft'}).ignore();
      await pumpEventQueue();

      final aliceCached = await docRef.get(const GetOptions(source: Source.cache));
      expect(aliceCached.data()?['title'], 'Offline Draft');

      auth.switchAuthLens(AuthLens.asUser(uid: 'bob-uid'));
      await pumpEventQueue();
      await expectLater(
        docRef.get(const GetOptions(source: Source.cache)),
        throwsA(isA<PyricBridgeException>().having((e) => e.code, 'code', 'unavailable')),
      );
    });
  });

  group('C1-03: snapshots stream survival and state reset on lens transitions', () {
    test('keeps snapshots stream open across transient permission-denied and recovers on next lens', () async {
      auth.switchAuthLens(AuthLens.asUser(uid: 'alice-uid'));
      await pumpEventQueue();

      final titles = <String?>[];
      final errors = <Object>[];
      var doneCount = 0;

      final sub = firestore
          .doc('playlists/pl-alice-commute')
          .snapshots(listenSource: ListenSource.defaultSource)
          .listen(
            (snap) => titles.add(snap.data()?['title'] as String?),
            onError: errors.add,
            onDone: () => doneCount++,
          );
      await pumpEventQueue();

      final sub1 = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': sub1['subId'],
        'value': {
          'id': 'pl-alice-commute',
          'path': 'playlists/pl-alice-commute',
          'exists': true,
          'data': {'title': 'Morning Commute'},
        },
      });
      await pumpEventQueue();
      expect(titles, ['Morning Commute']);

      // Switch to Bob -> server replies with permission-denied __error.
      auth.switchAuthLens(AuthLens.asUser(uid: 'bob-uid'));
      await pumpEventQueue();

      final sub2 = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      expect(sub2['subId'], isNot(sub1['subId']));
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': sub2['subId'],
        'value': {
          '__error': {
            'code': 'permission-denied',
            'message': 'Missing or insufficient permissions.',
          },
        },
      });
      await pumpEventQueue();

      expect(errors, hasLength(1));
      expect((errors.single as PyricBridgeException).code, 'permission-denied');
      expect(doneCount, 0, reason: 'Stream must stay alive to recover on subsequent lens switch');

      // Switch to admin -> automatically resubscribes and delivers data.
      auth.switchAuthLens(AuthLens.admin);
      await pumpEventQueue();

      final sub3 = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      expect(sub3['subId'], isNot(sub2['subId']));
      expect((sub3['sub'] as Map)['actAs'], {'mode': 'admin'});
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': sub3['subId'],
        'value': {
          'id': 'pl-alice-commute',
          'path': 'playlists/pl-alice-commute',
          'exists': true,
          'data': {'title': 'Morning Commute'},
        },
      });
      await pumpEventQueue();

      expect(titles, ['Morning Commute', 'Morning Commute']);
      expect(doneCount, 0);

      await sub.cancel();
    });

    test('parked stream after permission-denied still closes once on client disconnect', () async {
      auth.switchAuthLens(AuthLens.asUser(uid: 'bob-uid'));
      await pumpEventQueue();

      var doneCount = 0;
      firestore
          .doc('playlists/pl-alice-commute')
          .snapshots(listenSource: ListenSource.defaultSource)
          .listen((_) {}, onError: (_) {}, onDone: () => doneCount++);
      await pumpEventQueue();

      final sub1 = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': sub1['subId'],
        'value': {
          '__error': {
            'code': 'permission-denied',
            'message': 'Denied',
          },
        },
      });
      await pumpEventQueue();
      expect(doneCount, 0);

      await client.disconnect();
      await pumpEventQueue();
      expect(doneCount, 1);
    });

    test('query snapshots reset previousDocs on lens switch so docChanges emit added', () async {
      auth.switchAuthLens(AuthLens.asUser(uid: 'alice-uid'));
      await pumpEventQueue();

      final changeCounts = <int>[];
      final sub = firestore
          .collection('playlists')
          .snapshots(listenSource: ListenSource.defaultSource)
          .listen((snap) => changeCounts.add(snap.docChanges.length));
      await pumpEventQueue();

      final docPayload = {
        'docs': [
          {
            'id': 'pl-1',
            'path': 'playlists/pl-1',
            'exists': true,
            'data': {'title': 'One'},
          },
        ],
      };

      final sub1 = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': sub1['subId'],
        'value': docPayload,
      });
      await pumpEventQueue();
      expect(changeCounts, [1]);

      auth.switchAuthLens(AuthLens.admin);
      await pumpEventQueue();

      final sub2 = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
      harness.sendToClient({
        'type': 'worker-snap',
        'subId': sub2['subId'],
        'value': docPayload,
      });
      await pumpEventQueue();

      expect(changeCounts, [1, 1]);
      await sub.cancel();
    });
  });

  group('C1-01: emailVerified hydration, signOut lens reset, and Reset to App Auth UI', () {
    test('selectUser hydrates email_verified and picture alongside email and customClaims', () async {
      final controller = PyricDebugController(
        authPlatform: auth,
        bridgeClient: client,
      );
      addTearDown(controller.dispose);

      final parsed = SandboxUserRecord.fromMap({
        'uid': 'alice-uid',
        'email': 'alice@example.com',
        'emailVerified': true,
        'displayName': 'Alice',
        'photoURL': 'https://example.com/alice.png',
        'customClaims': {'role': 'editor'},
      });
      expect(parsed.emailVerified, isTrue);

      controller.selectUser(parsed);
      await pumpEventQueue();

      expect(controller.isImpersonating, isTrue);
      expect(auth.currentAuthLens.token?['email'], 'alice@example.com');
      expect(auth.currentAuthLens.token?['email_verified'], isTrue);
      expect(auth.currentAuthLens.token?['name'], 'Alice');
      expect(auth.currentAuthLens.token?['picture'], 'https://example.com/alice.png');
      expect(auth.currentAuthLens.token?['role'], 'editor');

      // Explicit signOut clears impersonated lens so next sign-in is not stuck.
      final signOutFuture = auth.signOut();
      await pumpEventQueue();
      final signOutOp = harness.sentMessages.lastWhere(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.signOut',
      );
      harness.sendToClient({
        'type': 'worker-res',
        'id': signOutOp['id'],
        'ok': true,
        'value': null,
      });
      await signOutFuture;
      await pumpEventQueue();

      expect(auth.isImpersonating, isFalse);
      expect(auth.currentAuthLens, AuthLens.anon);
    });

    testWidgets('PyricDebugSheet Reset to App Auth clears impersonation override', (tester) async {
      final controller = PyricDebugController(
        authPlatform: auth,
        bridgeClient: client,
      );
      addTearDown(controller.dispose);

      controller.selectUser(
        const SandboxUserRecord(
          uid: 'alice-uid',
          email: 'alice@example.com',
          emailVerified: true,
        ),
      );
      expect(controller.isImpersonating, isTrue);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PyricDebugSheet(controller: controller),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Reply to any auth.listUsers op so no timeout timer stays pending.
      for (final m in harness.sentMessages.where(
        (m) => m['type'] == 'worker-op' && m['op']?['method'] == 'auth.listUsers',
      )) {
        harness.sendToClient({
          'type': 'worker-res',
          'id': m['id'],
          'ok': true,
          'value': const <Map<String, dynamic>>[],
        });
      }
      await tester.pump();

      expect(find.text('Reset to App Auth'), findsOneWidget);
      await tester.tap(find.text('Reset to App Auth'));
      await tester.pumpAndSettle();

      expect(controller.isImpersonating, isFalse);
      expect(auth.currentAuthLens, AuthLens.anon);
    });
  });
}
