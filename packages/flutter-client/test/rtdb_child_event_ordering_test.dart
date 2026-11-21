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

  group('RTDB EventGenerator childMoved ordering and Index#indexedValueChanged', () {
    test(
      'Query.onChildMoved fires before onChildChanged under orderByValue even when onChildChanged subscribes first',
      () async {
        final scoresRef = db.ref('watched_scores');
        await scoresRef.set(<String, dynamic>{'a': 1, 'b': 2, 'c': 3});

        final ordered = scoresRef.orderByValue();
        final timeline = <String>[];

        // Subscribe onValue and onChildChanged BEFORE onChildMoved and onChildRemoved.
        final valueSub = ordered.onValue.listen((event) {
          timeline.add('value:${event.snapshot.children.length}');
        });
        final changedSub = ordered.onChildChanged.listen((event) {
          expect(event.type, PyricDatabaseEventType.childChanged);
          timeline.add(
            'changed:${event.snapshot.key}:${event.snapshot.value}:prev=${event.previousChildKey}',
          );
        });
        final movedSub = ordered.onChildMoved.listen((event) {
          expect(event.type, PyricDatabaseEventType.childMoved);
          timeline.add(
            'moved:${event.snapshot.key}:prev=${event.previousChildKey}',
          );
        });
        final addedSub = ordered.onChildAdded.listen((event) {
          timeline.add(
            'added:${event.snapshot.key}:prev=${event.previousChildKey}',
          );
        });
        final removedSub = ordered.onChildRemoved.listen((event) {
          timeline.add('removed:${event.snapshot.key}');
        });

        try {
          await Future<void>.delayed(const Duration(milliseconds: 30));
          expect(
            timeline.take(4).toList(),
            <String>[
              'added:a:prev=null',
              'added:b:prev=a',
              'added:c:prev=b',
              'value:3',
            ],
          );

          timeline.clear();
          // Multi-child update removing b, adding d=0, and moving a=10 after c=3.
          await scoresRef.update(<String, Object?>{
            'b': null,
            'd': 0,
            'a': 10,
          });
          await Future<void>.delayed(const Duration(milliseconds: 30));

          expect(
            timeline,
            <String>[
              'removed:b',
              'added:d:prev=null',
              'moved:a:prev=c',
              'changed:a:10:prev=c',
              'value:3',
            ],
          );
        } finally {
          await valueSub.cancel();
          await changedSub.cancel();
          await movedSub.cancel();
          await addedSub.cancel();
          await removedSub.cancel();
        }
      },
    );

    test(
      'Index#indexedValueChanged suppresses childMoved under orderByKey and unindexed child field updates',
      () async {
        final byKeyRef = db.ref('by_key');
        await byKeyRef.set(<String, dynamic>{'a': 1, 'b': 2});

        final byKey = byKeyRef.orderByKey();
        final byKeyEvents = <String>[];
        final keyMovedSub = byKey.onChildMoved.listen((event) {
          byKeyEvents.add('moved:${event.snapshot.key}');
        });
        final keyChangedSub = byKey.onChildChanged.listen((event) {
          byKeyEvents.add('changed:${event.snapshot.key}');
        });

        try {
          await Future<void>.delayed(const Duration(milliseconds: 25));
          await byKeyRef.child('a').set(99);
          await Future<void>.delayed(const Duration(milliseconds: 25));
          expect(byKeyEvents, <String>['changed:a']);
        } finally {
          await keyMovedSub.cancel();
          await keyChangedSub.cancel();
        }

        final byChildRef = db.ref('by_child');
        await byChildRef.set(<String, dynamic>{
          'u1': <String, dynamic>{'score': 10, 'label': 'init'},
          'u2': <String, dynamic>{'score': 20, 'label': 'peer'},
        });

        final byChild = byChildRef.orderByChild('score');
        final byChildEvents = <String>[];
        final childChangedSub = byChild.onChildChanged.listen((event) {
          byChildEvents.add('changed:${event.snapshot.key}');
        });
        final childMovedSub = byChild.onChildMoved.listen((event) {
          byChildEvents.add(
            'moved:${event.snapshot.key}:prev=${event.previousChildKey}',
          );
        });

        try {
          await Future<void>.delayed(const Duration(milliseconds: 25));

          // Editing unindexed field `label` fires only childChanged, never childMoved.
          await byChildRef.child('u1').set(<String, dynamic>{
            'score': 10,
            'label': 'renamed',
          });
          await Future<void>.delayed(const Duration(milliseconds: 25));
          expect(byChildEvents, <String>['changed:u1']);

          // Editing indexed field `score` fires childMoved BEFORE childChanged.
          await byChildRef.child('u1').set(<String, dynamic>{
            'score': 30,
            'label': 'renamed',
          });
          await Future<void>.delayed(const Duration(milliseconds: 25));
          expect(
            byChildEvents,
            <String>['changed:u1', 'moved:u1:prev=u2', 'changed:u1'],
          );
        } finally {
          await childChangedSub.cancel();
          await childMovedSub.cancel();
        }
      },
    );

    test(
      'Priority-ordered view emits childMoved before childChanged when child priority mutates',
      () async {
        final prioRef = db.ref('prio_board');
        await prioRef.child('item1').setWithPriority('alpha', 2);
        await prioRef.child('item2').setWithPriority('beta', 5);

        final ordered = prioRef.orderByPriority();
        final timeline = <String>[];
        final chgSub = ordered.onChildChanged.listen((event) {
          timeline.add(
            'changed:${event.snapshot.key}:prio=${event.snapshot.priority}',
          );
        });
        final movSub = ordered.onChildMoved.listen((event) {
          timeline.add(
            'moved:${event.snapshot.key}:prev=${event.previousChildKey}',
          );
        });

        try {
          await Future<void>.delayed(const Duration(milliseconds: 25));
          await prioRef.child('item1').setPriority(10);
          await Future<void>.delayed(const Duration(milliseconds: 25));

          expect(
            timeline,
            <String>['moved:item1:prev=item2', 'changed:item1:prio=10'],
          );
        } finally {
          await chgSub.cancel();
          await movSub.cancel();
        }
      },
    );
  });
}
