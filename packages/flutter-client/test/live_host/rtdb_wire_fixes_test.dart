import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_flutter_client.dart';

import '../helpers/rtdb_test_harness.dart';

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

  test('ServerValue sentinels emit pure Firebase .sv wire markers', () {
    expect(ServerValue.timestamp, equals(const <String, dynamic>{'.sv': 'timestamp'}));
    expect(
      ServerValue.increment(7),
      equals(<String, dynamic>{
        '.sv': <String, dynamic>{'increment': 7},
      }),
    );
  });

  test('runTransaction deep-clones MutableData so in-place Map mutation preserves CAS expected value and abort snapshot', () async {
    final ref = db.ref('counters/doc');
    await ref.set(<String, dynamic>{'count': 10, 'label': 'initial'});

    final aborted = await ref.runTransaction((mutableData) {
      final map = mutableData.value as Map<String, dynamic>;
      map['count'] = 999;
      return Transaction.abort();
    });
    expect(aborted.committed, isFalse);
    expect(aborted.snapshot.value, equals(<String, dynamic>{'count': 10, 'label': 'initial'}));

    final committed = await ref.runTransaction((mutableData) {
      final map = mutableData.value as Map<String, dynamic>;
      map['count'] = (map['count'] as int) + 5;
      mutableData.priority = 42;
      return Transaction.success(mutableData);
    });
    expect(committed.committed, isTrue);

    final txGetOp = harness.receivedOps.lastWhere((op) => op['method'] == 'rtdb.get');
    expect(txGetOp['transaction'], isTrue);

    final commitOp = harness.receivedOps.lastWhere(
      (op) => op['method'] == 'rtdb.transactionCommit',
    );
    expect(
      commitOp['expected'],
      equals(<String, dynamic>{'count': 10, 'label': 'initial'}),
    );
    expect(
      commitOp['value'],
      equals(<String, dynamic>{
        'count': 15,
        'label': 'initial',
        '.priority': 42,
      }),
    );
  });

  test('PyricDataSnapshot.fromWire traverses array-coerced List children and nested exportValue priorities', () {
    final rootRef = db.ref('org');
    final snap = PyricDataSnapshot.fromWire(rootRef, <String, dynamic>{
      'key': 'org',
      'exists': true,
      'value': <String, dynamic>{
        'tags': <Object?>['alpha', 'beta'],
        'lead': <String, dynamic>{'name': 'Ada'},
      },
      'priority': 1,
      'exportValue': <String, dynamic>{
        '.priority': 1,
        'tags': <String, dynamic>{
          '0': <String, dynamic>{'.value': 'alpha', '.priority': 10},
          '1': 'beta',
        },
        'lead': <String, dynamic>{
          '.priority': 'top',
          'name': 'Ada',
        },
      },
      'entries': <Map<String, dynamic>>[
        <String, dynamic>{
          'key': 'lead',
          'value': <String, dynamic>{'name': 'Ada'},
          'priority': 'top',
          'exportValue': <String, dynamic>{'.priority': 'top', 'name': 'Ada'},
        },
        <String, dynamic>{
          'key': 'tags',
          'value': <Object?>['alpha', 'beta'],
          'priority': null,
          'exportValue': <String, dynamic>{
            '0': <String, dynamic>{'.value': 'alpha', '.priority': 10},
            '1': 'beta',
          },
        },
      ],
    });

    expect(snap.child('tags').children.map((c) => c.key).toList(), equals(<String?>['0', '1']));
    expect(snap.child('tags/0').exists, isTrue);
    expect(snap.child('tags/0').value, equals('alpha'));
    expect(snap.child('tags/0').priority, equals(10));
    expect(snap.child('tags/1').value, equals('beta'));
    expect(snap.child('tags/2').exists, isFalse);
    expect(snap.child('lead').priority, equals('top'));
    expect(snap.child('lead/name').value, equals('Ada'));
  });
}
