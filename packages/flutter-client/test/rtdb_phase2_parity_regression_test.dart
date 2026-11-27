import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_auth.dart';
import 'package:pyric_firestore/pyric_database.dart';

import 'auth/mock_bridge_helper.dart';

class _MutableLensProvider implements PyricAuthCredentialsProvider {
  AuthLens _current = AuthLens.anon;
  final StreamController<AuthLens> _controller =
      StreamController<AuthLens>.broadcast(sync: true);

  @override
  AuthLens get currentAuthLens => _current;

  @override
  Stream<AuthLens> get authLensChanges => _controller.stream;

  Future<String?> getIdToken({bool forceRefresh = false}) async => null;

  void setLens(AuthLens next) {
    _current = next;
    _controller.add(next);
  }

  Future<void> dispose() => _controller.close();
}

void main() {
  late MockBridgeHarness harness;
  late PyricBridgeClient client;
  late _MutableLensProvider authProvider;
  late PyricDatabase db;

  setUp(() async {
    setupMockFirebase();
    harness = MockBridgeHarness();
    client = harness.createClient();
    harness.channel.toServerController.stream.listen((raw) {
      if (raw is String && raw.contains('"type":"attach"')) {
        harness.ackAttach(clientSessionId: 'sess-rtdb-p2');
      }
    });
    authProvider = _MutableLensProvider();
    db = PyricDatabase(
      bridgeClient: client,
      credentialsProvider: authProvider,
    );
    await client.connect();
    await pumpEventQueue();
  });

  tearDown(() async {
    await authProvider.dispose();
    await client.disconnect();
  });

  test('P2-F01a: clears cached latestSnapshot across auth lens switch', () async {
    authProvider.setLens(AuthLens.asUser(uid: 'alice'));
    final aliceEvents = <Object?>[];
    final subA = db.ref('secrets/item').onValue.listen((ev) {
      aliceEvents.add(ev.snapshot.value);
    });
    await pumpEventQueue();

    final firstSub = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
    harness.sendToClient({
      'type': 'worker-snap',
      'subId': firstSub['subId'],
      'value': {'key': 'item', 'exists': true, 'value': 'ALICE_SECRET'},
    });
    await pumpEventQueue();
    expect(aliceEvents, ['ALICE_SECRET']);

    authProvider.setLens(AuthLens.asUser(uid: 'bob'));
    final bobEvents = <Object?>[];
    final subB = db.ref('secrets/item').onValue.listen((ev) {
      bobEvents.add(ev.snapshot.value);
    });
    await pumpEventQueue();
    expect(bobEvents, isEmpty);

    await subA.cancel();
    await subB.cancel();
  });

  test('P2-F01b: orders cached initial replay ahead of synchronous live snapshot', () async {
    final subA = db.ref('items/live').onValue.listen((_) {});
    await pumpEventQueue();
    final subMsg = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
    final subId = subMsg['subId'] as String;

    harness.sendToClient({
      'type': 'worker-snap',
      'subId': subId,
      'value': {'key': 'live', 'exists': true, 'value': 'v1'},
    });
    await pumpEventQueue();

    final secondListenerValues = <Object?>[];
    final subB = db.ref('items/live').onValue.listen((ev) {
      secondListenerValues.add(ev.snapshot.value);
    });
    // Deliver v2 synchronously before the scheduled initial-replay microtask runs.
    harness.sendToClient({
      'type': 'worker-snap',
      'subId': subId,
      'value': {'key': 'live', 'exists': true, 'value': 'v2'},
    });
    await pumpEventQueue();
    expect(secondListenerValues, ['v1', 'v2']);

    await subA.cancel();
    await subB.cancel();
  });

  test('P2-F08a: client-side query validation rejects invalid orderBy, bounds, and limits', () {
    final ref = db.ref('players');
    expect(() => ref.orderByChild(''), throwsArgumentError);
    expect(() => ref.orderByChild('a//b'), throwsArgumentError);
    expect(() => ref.orderByChild('a.b'), throwsArgumentError);
    expect(() => ref.orderByKey().orderByValue(), throwsArgumentError);
    expect(() => ref.orderByKey().startAt(1), throwsArgumentError);
    expect(() => ref.orderByKey().startAt('a', key: 'k'), throwsArgumentError);
    expect(() => ref.startAt(1).orderByKey(), throwsArgumentError);
    expect(() => ref.startAt('a', key: 'k').orderByKey(), throwsArgumentError);
    expect(() => ref.startAt('a').startAfter('b'), throwsArgumentError);
    expect(() => ref.endAt('z').endBefore('y'), throwsArgumentError);
    expect(() => ref.equalTo('a').startAt('b'), throwsArgumentError);
    expect(() => ref.startAt(double.nan), throwsArgumentError);
    expect(() => ref.startAt(double.infinity), throwsArgumentError);
    expect(() => ref.startAt({'nested': 1}), throwsArgumentError);
    expect(() => ref.startAt('a', key: 'bad/key'), throwsArgumentError);
    expect(() => ref.limitToFirst(0), throwsArgumentError);
    expect(() => ref.limitToLast(-1), throwsArgumentError);
    expect(() => ref.limitToFirst(2).limitToLast(2), throwsArgumentError);
  });

  test('P2-F08b & P2-F15: runTransaction pins txLens and falls back to currentSnap when uncommitted', () async {
    authProvider.setLens(AuthLens.asUser(uid: 'alice'));
    final actAsUids = <String?>[];
    harness.channel.toServerController.stream.listen((raw) {
      if (raw is! String) return;
      final msgs = harness.sentMessages.where((m) => m['type'] == 'worker-op').toList();
      if (msgs.isEmpty) return;
      final msg = msgs.last;
      final op = msg['op'] as Map<String, dynamic>;
      final method = op['method'];
      final actAs = op['actAs'] as Map<String, dynamic>?;
      if (method == 'rtdb.get') {
        actAsUids.add(actAs?['uid'] as String?);
        harness.sendToClient({
          'type': 'worker-res',
          'id': msg['id'],
          'ok': true,
          'value': {'key': 'count', 'exists': true, 'value': 10},
        });
      } else if (method == 'rtdb.transactionCommit') {
        actAsUids.add(actAs?['uid'] as String?);
        harness.sendToClient({
          'type': 'worker-res',
          'id': msg['id'],
          'ok': true,
          'value': {'committed': false, 'retry': false},
        });
      }
    });

    final result = await db.ref('counters/count').runTransaction((mutable) {
      authProvider.setLens(AuthLens.asUser(uid: 'bob'));
      mutable.value = 99;
      return Transaction.success(mutable);
    });

    expect(result.committed, isFalse);
    expect(result.snapshot.value, 10);
    expect(actAsUids, ['alice', 'alice']);
  });

  test('P2-F12: permission-denied emits error without killing lens recovery; lazy provider rebinds', () async {
    final lazyDb = PyricDatabase(bridgeClient: client);
    final errors = <Object>[];
    final values = <Object?>[];
    var done = false;

    final sub = lazyDb.ref('private/doc').onValue.listen(
      (ev) => values.add(ev.snapshot.value),
      onError: errors.add,
      onDone: () => done = true,
    );
    await pumpEventQueue();

    final firstSub = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
    harness.sendToClient({
      'type': 'worker-snap',
      'subId': firstSub['subId'],
      'value': {
        '__error': {'code': 'PERMISSION_DENIED', 'message': 'denied'},
      },
    });
    await pumpEventQueue();
    expect(errors.length, 1);
    expect(done, isFalse);

    // A second listener joining the parked denied view under the same lens
    // must receive the cached denial rather than hanging silently.
    final errors2 = <Object>[];
    final values2 = <Object?>[];
    final sub2 = lazyDb.ref('private/doc').onValue.listen(
      (ev) => values2.add(ev.snapshot.value),
      onError: errors2.add,
    );
    await pumpEventQueue();
    expect(errors2.length, 1);
    expect(values2, isEmpty);

    final lateProvider = _MutableLensProvider();
    lateProvider.setLens(AuthLens.asUser(uid: 'alice'));
    lazyDb.credentialsProvider = lateProvider;
    await pumpEventQueue();

    final reopenedSub = harness.sentMessages.lastWhere((m) => m['type'] == 'worker-sub');
    expect(reopenedSub['subId'], isNot(firstSub['subId']));
    harness.sendToClient({
      'type': 'worker-snap',
      'subId': reopenedSub['subId'],
      'value': {'key': 'doc', 'exists': true, 'value': 'unlocked'},
    });
    await pumpEventQueue();
    expect(values, ['unlocked']);
    expect(values2, ['unlocked']);

    await sub2.cancel();
    await sub.cancel();
    await lateProvider.dispose();
  });
}
