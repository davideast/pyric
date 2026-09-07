import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_flutter_client.dart';
import 'helpers/rtdb_test_harness.dart';

void main() {
  late RtdbTestHarness harness;
  late PyricDatabase db;

  setUp(() async {
    harness = RtdbTestHarness();
    await harness.connect();
    db = harness.database;
  });

  tearDown(() async {
    await harness.dispose();
  });

  // ── 1. Database Instance & Connection (5 rows) ────────────────────────────
  group('1. Database Instance & Connection', () {
    test('rtdb-flutter#instance-default: PyricDatabase.instance returns default Realtime Database instance', () {
      final defaultDb = PyricDatabase.instance;
      expect(defaultDb, isA<PyricDatabase>());
      expect(defaultDb.bridgeClient, same(harness.client));
    });

    test('rtdb-flutter#instance-url: PyricDatabase.instanceFor(databaseURL) returns isolated instance', () {
      final customDb = PyricDatabase.instanceFor(
        databaseURL: 'https://test-project-default-rtdb.firebaseio.com',
      );
      expect(
        customDb.databaseURL,
        'https://test-project-default-rtdb.firebaseio.com',
      );
      expect(customDb, isA<PyricDatabase>());
    });

    test('rtdb-flutter#ref-root: PyricDatabase.ref() returns root DatabaseReference', () {
      final rootRef = db.ref();
      expect(rootRef.path, '/');
      expect(rootRef.key, isNull);
    });

    test('rtdb-flutter#ref-path: PyricDatabase.ref(path) returns specified DatabaseReference', () {
      final userRef = db.ref('users/alice');
      expect(userRef.path, '/users/alice');
      expect(userRef.key, 'alice');
    });

    test('rtdb-flutter#connection-toggle: PyricDatabase.goOffline() / goOnline() suspends and resumes connection', () async {
      expect(harness.isOffline, isFalse);
      await db.goOffline();
      expect(harness.isOffline, isTrue);
      await db.goOnline();
      expect(harness.isOffline, isFalse);
    });
  });

  // ── 2. DatabaseReference Navigation & Properties (7 rows) ────────────────
  group('2. DatabaseReference Navigation & Properties', () {
    test('rtdb-flutter#ref-child: DatabaseReference.child(path) returns child reference', () {
      final ref = db.ref('users').child('bob/profile');
      expect(ref.path, '/users/bob/profile');
      expect(ref.key, 'profile');
    });

    test('rtdb-flutter#ref-parent: DatabaseReference.parent returns parent reference or null for root', () {
      final childRef = db.ref('users/alice');
      expect(childRef.parent?.path, '/users');
      expect(childRef.parent?.parent?.path, '/');
      expect(db.ref().parent, isNull);
    });

    test('rtdb-flutter#ref-root-prop: DatabaseReference.root returns root reference from any descendant', () {
      final deepRef = db.ref('a/b/c/d');
      expect(deepRef.root.path, '/');
      expect(deepRef.root.key, isNull);
    });

    test('rtdb-flutter#ref-key: DatabaseReference.key returns last segment token or null for root', () {
      expect(db.ref('posts/post-123').key, 'post-123');
      expect(db.ref().key, isNull);
    });

    test('rtdb-flutter#ref-path-prop: DatabaseReference.path returns normalized slash-delimited full path', () {
      expect(db.ref('///items//sub///').path, '/items/sub');
      expect(db.ref('').path, '/');
    });

    test('rtdb-flutter#ref-push: DatabaseReference.push() generates a new child reference with unique push ID', () {
      final listRef = db.ref('messages');
      final pushed1 = listRef.push();
      final pushed2 = listRef.push();
      expect(pushed1.key, isNotNull);
      expect(pushed1.key!.length, 20);
      expect(pushed1.key, isNot(equals(pushed2.key)));
      expect(pushed1.path, '/messages/${pushed1.key}');
    });

    test('rtdb-flutter#ref-push-key-ordering: DatabaseReference.push().key monotonically orders push keys', () {
      final listRef = db.ref('timeline');
      final keys = List.generate(10, (_) => listRef.push().key!);
      final sorted = List<String>.from(keys)..sort();
      expect(keys, equals(sorted));
    });
  });

  // ── 3. Write Operations (6 rows) ─────────────────────────────────────────
  group('3. Write Operations', () {
    test('rtdb-flutter#write-set: DatabaseReference.set(value) overwrites data at path', () async {
      final ref = db.ref('profile/alice');
      await ref.set({'name': 'Alice', 'role': 'admin'});
      final snap = await ref.get();
      expect(snap.value, {'name': 'Alice', 'role': 'admin'});
    });

    test('rtdb-flutter#write-set-null: DatabaseReference.set(null) deletes data at path', () async {
      final ref = db.ref('temp/data');
      await ref.set('present');
      expect((await ref.get()).exists, isTrue);
      await ref.set(null);
      expect((await ref.get()).exists, isFalse);
      expect((await ref.get()).value, isNull);
    });

    test('rtdb-flutter#write-set-priority: DatabaseReference.setPriority(priority) updates ordering priority', () async {
      final ref = db.ref('ranked/item1');
      await ref.set('value1');
      await ref.setPriority(100);
      final snap = await ref.get();
      expect(snap.value, 'value1');
      expect(snap.priority, 100);
    });

    test('rtdb-flutter#write-set-with-priority: DatabaseReference.setWithPriority(value, priority) writes both atomically', () async {
      final ref = db.ref('ranked/item2');
      await ref.setWithPriority({'score': 50}, 10);
      final snap = await ref.get();
      expect(snap.value, {'score': 50});
      expect(snap.priority, 10);
    });

    test('rtdb-flutter#write-update: DatabaseReference.update(values) updates specified child keys without overwriting siblings', () async {
      final ref = db.ref('users/charlie');
      await ref.set({'name': 'Charlie', 'age': 25, 'city': 'Boston'});
      await ref.update({'age': 26, 'country': 'USA'});
      final snap = await ref.get();
      expect(snap.value, {
        'name': 'Charlie',
        'age': 26,
        'city': 'Boston',
        'country': 'USA',
      });
    });

    test('rtdb-flutter#write-remove: DatabaseReference.remove() deletes node and descendant data', () async {
      final ref = db.ref('deleteMe');
      await ref.set({'nested': 'data'});
      expect((await ref.get()).exists, isTrue);
      await ref.remove();
      expect((await ref.get()).exists, isFalse);
    });
  });

  // ── 4. ServerValue Sentinels (2 rows) ────────────────────────────────────
  group('4. ServerValue Sentinels', () {
    test('rtdb-flutter#sentinel-timestamp: ServerValue.timestamp resolves to server epoch milliseconds', () async {
      final ref = db.ref('events/e1');
      await ref.set({'createdAt': ServerValue.timestamp});
      final snap = await ref.get();
      final map = snap.value as Map;
      expect(map['createdAt'], isA<int>());
      expect(map['createdAt'] as int, greaterThan(1700000000000));
    });

    test('rtdb-flutter#sentinel-increment: ServerValue.increment(delta) atomically increments numeric value', () async {
      final ref = db.ref('counters/views');
      await ref.set(10);
      await ref.set(ServerValue.increment(5));
      expect((await ref.get()).value, 15);
      await ref.set(ServerValue.increment(-3));
      expect((await ref.get()).value, 12);
    });
  });

  // ── 5. One-Shot Reads & DataSnapshot Inspection (7 rows) ─────────────────
  group('5. One-Shot Reads & DataSnapshot Inspection', () {
    test('rtdb-flutter#read-get: DatabaseReference.get() fetches one-shot DataSnapshot', () async {
      await db.ref('config/theme').set('dark');
      final snap = await db.ref('config/theme').get();
      expect(snap.value, 'dark');
    });

    test('rtdb-flutter#snap-exists: DataSnapshot.exists returns true for non-null data and false when missing', () async {
      await db.ref('check/present').set(true);
      expect((await db.ref('check/present').get()).exists, isTrue);
      expect((await db.ref('check/absent').get()).exists, isFalse);
    });

    test('rtdb-flutter#snap-key: DataSnapshot.key returns key name of snapshot location', () async {
      await db.ref('books/b1').set({'title': 'Dart'});
      final snap = await db.ref('books/b1').get();
      expect(snap.key, 'b1');
    });

    test('rtdb-flutter#snap-value: DataSnapshot.value returns deserialized Dart value', () async {
      await db.ref('scalars/num').set(42);
      expect((await db.ref('scalars/num').get()).value, 42);
    });

    test('rtdb-flutter#snap-children: DataSnapshot.children returns iterable of direct child snapshots', () async {
      await db.ref('team').set({'u1': 'Alice', 'u2': 'Bob'});
      final snap = await db.ref('team').get();
      final keys = snap.children.map((c) => c.key).toList();
      expect(keys, containsAll(['u1', 'u2']));
    });

    test('rtdb-flutter#snap-child-path: DataSnapshot.child(path) inspects relative descendant path', () async {
      await db.ref('org').set({
        'dept': {
          'lead': {'name': 'Grace'},
        },
      });
      final snap = await db.ref('org').get();
      final leadNameSnap = snap.child('dept/lead/name');
      expect(leadNameSnap.exists, isTrue);
      expect(leadNameSnap.value, 'Grace');
    });

    test('rtdb-flutter#snap-priority: DataSnapshot.priority returns node priority value', () async {
      await db.ref('priorityNode').setWithPriority('important', 5);
      final snap = await db.ref('priorityNode').get();
      expect(snap.priority, 5);
    });
  });

  // ── 6. Realtime Listeners & Streams (5 rows) ─────────────────────────────
  group('6. Realtime Listeners & Streams', () {
    test('rtdb-flutter#listen-value: Query.onValue emits initial and updated DataSnapshots', () async {
      final ref = db.ref('live/status');
      final events = <Object?>[];
      final sub = ref.onValue.listen((event) {
        events.add(event.snapshot.value);
      });

      await Future<void>.delayed(const Duration(milliseconds: 20));
      await ref.set('online');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await ref.set('away');
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(events, containsAll(['online', 'away']));
      await sub.cancel();
    });

    test('rtdb-flutter#listen-child-added: Query.onChildAdded emits existing and newly added children', () async {
      final ref = db.ref('chat/room1');
      await ref.set({'m1': 'Hello'});

      final addedKeys = <String?>[];
      final sub = ref.onChildAdded.listen((event) {
        addedKeys.add(event.snapshot.key);
      });

      await Future<void>.delayed(const Duration(milliseconds: 20));
      await ref.child('m2').set('World');
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(addedKeys, ['m1', 'm2']);
      await sub.cancel();
    });

    test('rtdb-flutter#listen-child-changed: Query.onChildChanged emits when existing child is modified', () async {
      final ref = db.ref('inventory');
      await ref.set({'apple': 10, 'banana': 5});

      final changed = <String, Object?>{};
      final sub = ref.onChildChanged.listen((event) {
        if (event.snapshot.key != null) {
          changed[event.snapshot.key!] = event.snapshot.value;
        }
      });

      await Future<void>.delayed(const Duration(milliseconds: 20));
      await ref.child('apple').set(15);
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(changed['apple'], 15);
      await sub.cancel();
    });

    test('rtdb-flutter#listen-child-removed: Query.onChildRemoved emits when child node is removed', () async {
      final ref = db.ref('activeUsers');
      await ref.set({'u1': true, 'u2': true});

      final removedKeys = <String?>[];
      final sub = ref.onChildRemoved.listen((event) {
        removedKeys.add(event.snapshot.key);
      });

      await Future<void>.delayed(const Duration(milliseconds: 20));
      await ref.child('u1').remove();
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(removedKeys, ['u1']);
      await sub.cancel();
    });

    test('rtdb-flutter#listen-cancel: StreamSubscription.cancel() unsubscribes listener', () async {
      final ref = db.ref('cancelTest');
      int count = 0;
      final sub = ref.onValue.listen((_) => count++);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      final countBeforeCancel = count;
      await sub.cancel();

      await ref.set('after-cancel');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(count, countBeforeCancel);
    });
  });

  // ── 7. Query Ordering, Filtering & Limits (6 rows) ───────────────────────
  group('7. Query Ordering, Filtering & Limits', () {
    setUp(() async {
      await db.ref('players').set({
        'p1': {'name': 'Charlie', 'score': 30},
        'p2': {'name': 'Alice', 'score': 10},
        'p3': {'name': 'Bob', 'score': 20},
      });
    });

    test('rtdb-flutter#query-order-by-child: Query.orderByChild(path) orders results by nested child value', () async {
      final snap = await db.ref('players').orderByChild('score').get();
      final keys = snap.children.map((c) => c.key).toList();
      expect(keys, ['p2', 'p3', 'p1']);
    });

    test('rtdb-flutter#query-order-by-key: Query.orderByKey() orders results lexicographically by key', () async {
      final snap = await db.ref('players').orderByKey().get();
      final keys = snap.children.map((c) => c.key).toList();
      expect(keys, ['p1', 'p2', 'p3']);
    });

    test('rtdb-flutter#query-order-by-value: Query.orderByValue() orders scalar values', () async {
      await db.ref('scores').set({'a': 300, 'b': 100, 'c': 200});
      final snap = await db.ref('scores').orderByValue().get();
      final keys = snap.children.map((c) => c.key).toList();
      expect(keys, ['b', 'c', 'a']);
    });

    test('rtdb-flutter#query-equal-to: Query.equalTo(value) filters results matching exact sort value', () async {
      final snap = await db
          .ref('players')
          .orderByChild('score')
          .equalTo(20)
          .get();
      final keys = snap.children.map((c) => c.key).toList();
      expect(keys, ['p3']);
    });

    test('rtdb-flutter#query-range: Query.startAt(value) / endAt(value) restricts range boundaries', () async {
      final snap = await db
          .ref('players')
          .orderByChild('score')
          .startAt(15)
          .endAt(30)
          .get();
      final keys = snap.children.map((c) => c.key).toList();
      expect(keys, ['p3', 'p1']);
    });

    test('rtdb-flutter#query-limit: Query.limitToFirst(limit) / limitToLast(limit) caps result window', () async {
      final firstTwo = await db
          .ref('players')
          .orderByChild('score')
          .limitToFirst(2)
          .get();
      expect(firstTwo.children.map((c) => c.key).toList(), ['p2', 'p3']);

      final lastTwo = await db
          .ref('players')
          .orderByChild('score')
          .limitToLast(2)
          .get();
      expect(lastTwo.children.map((c) => c.key).toList(), ['p3', 'p1']);
    });
  });

  // ── 8. Transactions & OnDisconnect (4 rows) ──────────────────────────────
  group('8. Transactions & OnDisconnect', () {
    test('rtdb-flutter#tx-run: DatabaseReference.runTransaction(handler) commits optimistic concurrency write', () async {
      final ref = db.ref('bank/balance');
      await ref.set(100);

      final result = await ref.runTransaction((mutableData) {
        final current = (mutableData.value as int?) ?? 0;
        mutableData.value = current + 50;
        return Transaction.success(mutableData);
      });

      expect(result.committed, isTrue);
      expect(result.snapshot.value, 150);
      expect((await ref.get()).value, 150);
    });

    test('rtdb-flutter#tx-abort: Transaction.abort() aborts transaction without modifying data', () async {
      final ref = db.ref('bank/locked');
      await ref.set(500);

      final result = await ref.runTransaction((mutableData) {
        return Transaction.abort();
      });

      expect(result.committed, isFalse);
      expect(result.snapshot.value, 500);
      expect((await ref.get()).value, 500);
    });

    test('rtdb-flutter#ondisconnect-set-remove: OnDisconnect.set(value) / remove() executes on disconnect', () async {
      final presenceRef = db.ref('presence/user1');
      await presenceRef.set('online');
      await presenceRef.onDisconnect().set('offline');

      expect((await presenceRef.get()).value, 'online');
      await db.goOffline();
      expect((await presenceRef.get()).value, 'offline');
    });

    test('rtdb-flutter#ondisconnect-cancel: OnDisconnect.cancel() cancels queued disconnect operations', () async {
      final statusRef = db.ref('presence/user2');
      await statusRef.set('active');
      await statusRef.onDisconnect().set('gone');
      await statusRef.onDisconnect().cancel();

      await db.goOffline();
      expect((await statusRef.get()).value, 'active');
    });
  });

  // ── 9. AuthLens Propagation & Resubscription ─────────────────────────────
  group('9. AuthLens Integration', () {
    test('propagates active AuthLens on worker-op and resubscribes active listeners upon identity change', () async {
      harness.credentialsProvider.setLens(AuthLens.admin);
      await db.ref('secure/data').set('secret');
      expect(harness.receivedOps.last['actAs'], {'mode': 'admin'});

      harness.credentialsProvider.setLens(AuthLens.asUser(uid: 'user-42'));
      await db.ref('secure/data').get();
      expect(harness.receivedOps.last['actAs'], {
        'mode': 'as',
        'uid': 'user-42',
      });

      final sub = db.ref('secure/stream').onValue.listen((_) {});
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(harness.receivedSubs.last['actAs'], {
        'mode': 'as',
        'uid': 'user-42',
      });

      // Switch identity to anon -> triggers automatic resubscription with new AuthLens
      harness.credentialsProvider.setLens(AuthLens.anon);
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(harness.receivedSubs.last['actAs'], {'mode': 'anon'});

      await sub.cancel();
    });
  });
}
