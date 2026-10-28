import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_firestore.dart';

import 'auth/mock_bridge_helper.dart' show setupMockFirebase;
import 'helpers/fake_bridge.dart';
import 'helpers/rtdb_test_harness.dart' show MockRtdbCredentialsProvider;

const firestoreWrites = {
  'setDoc',
  'updateDoc',
  'deleteDoc',
  'batchCommit',
  'txnCommit',
};

// #1032. Firestore writes from one client reach the bridge in the order the
// app called them. Each write method runs synchronously into
// `PyricBridgeClient.op`, which sends the frame or appends it to the held FIFO
// before anything can yield, so call order is frame order.
void main() {
  const rounds = 50;

  late FakeBridge bridge;
  late PyricBridgeClient client;
  late MockRtdbCredentialsProvider credentials;
  late PyricFirestorePlatform firestore;

  setUp(() {
    setupMockFirebase();
    bridge = FakeBridge();
    client = PyricBridgeClient(
      channelFactory: bridge.connect,
      reconnectDelay: (_) => Duration.zero,
    );
    credentials = MockRtdbCredentialsProvider();
    firestore = PyricFirestorePlatform(
      bridgeClient: client,
      credentialsProvider: credentials,
    );
    answerOps(bridge);
  });

  tearDown(() async {
    await client.disconnect();
    await credentials.dispose();
  });

  /// Issues `set` then `update` on one document [rounds] times without
  /// awaiting, and returns the write frames it expects, in call order.
  List<String> issueSetUpdatePairs(String label) {
    final expected = <String>[];
    final doc = firestore.doc('rooms/$label');
    for (var i = 0; i < rounds; i++) {
      doc.set({'n': i}).ignore();
      doc.update({FieldPath(const ['n']): i + 1}).ignore();
      expected
        ..add('setDoc rooms/$label {n: $i}')
        ..add('updateDoc rooms/$label {n: ${i + 1}}');
    }
    return expected;
  }

  /// Issues every write method once without awaiting, and returns the write
  /// frames it expects, in call order.
  List<Object> issueEveryWriteMethod() {
    final doc = firestore.doc('rooms/a');
    final rooms = firestore.collection('rooms') as PyricCollectionReference;
    doc.set({'title': 'one'}).ignore();
    doc.update({FieldPath(const ['title']): 'two'}).ignore();
    doc.set({'topic': 'three'}, SetOptions(merge: true)).ignore();
    rooms.add({'title': 'added'}).ignore();
    firestore.batch()
      ..set('rooms/b', {'title': 'batched'})
      ..update('rooms/a', {FieldPath(const ['title']): 'four'})
      ..delete('rooms/c')
      ..commit().ignore();
    doc.delete().ignore();
    return [
      'setDoc rooms/a {title: one}',
      'updateDoc rooms/a {title: two}',
      'setDoc rooms/a {topic: three} {merge: true}',
      matches(r'^setDoc rooms/[A-Za-z0-9]{20} \{title: added\}$'),
      'batchCommit set rooms/b, update rooms/a, delete rooms/c',
      'deleteDoc rooms/a',
    ];
  }

  /// Drops the socket and keeps the client from re-attaching, so writes are held.
  Future<void> dropAndHold() async {
    bridge.refuseConnections = true;
    bridge.current.drop();
    await until(() => !client.isConnected);
  }

  Future<void> reattach() async {
    bridge.refuseConnections = false;
    await client.connect();
  }

  test('set then update on one document, issued $rounds times while attached, reach the bridge in call order', () async {
    await client.connect();
    final expected = issueSetUpdatePairs('attached');
    expect(writesOn(bridge.current), expected);
  });

  test('set then update on one document, issued $rounds times while held, reach the new socket in call order', () async {
    await client.connect();
    await dropAndHold();
    final expected = issueSetUpdatePairs('held');
    await settle();
    expect(bridge.frames.where(isWrite), isEmpty, reason: 'nothing is sent while held');

    await reattach();
    expect(writesOn(bridge.current), expected);
  });

  test('writes issued right after the re-attach go behind the held ones', () async {
    await client.connect();
    await dropAndHold();
    final held = issueSetUpdatePairs('held');

    await reattach();
    final after = issueSetUpdatePairs('after');
    expect(writesOn(bridge.current), [...held, ...after]);
  });

  test('every write method keeps call order, attached and held', () async {
    await client.connect();
    final attached = issueEveryWriteMethod();
    expect(writesOn(bridge.current), attached);

    await dropAndHold();
    final held = issueEveryWriteMethod();
    await reattach();
    expect(writesOn(bridge.current), held);
  });

  // A transaction reads at call time and commits after its handler returns,
  // as in Firebase, so its commit is ordered against its own read only.
  test('a transaction reads at call time and commits its writes in call order, attached and held', () async {
    Future<void> transact() => firestore.runTransaction((txn) async {
          await txn.get('rooms/a');
          txn
            ..set('rooms/a', {'title': 'one'})
            ..update('rooms/a', {FieldPath(const ['title']): 'two'})
            ..delete('rooms/b');
        });
    const expected = [
      'getDoc rooms/a',
      'txnCommit set rooms/a, update rooms/a, delete rooms/b',
    ];

    await client.connect();
    await transact();
    expect(transactionFramesOn(bridge.current), expected);

    await dropAndHold();
    final sentBeforeHold = bridge.frames.length;
    final held = transact();
    await settle();
    expect(bridge.frames.length, sentBeforeHold, reason: 'nothing is sent while held');
    await reattach();
    await held;
    expect(transactionFramesOn(bridge.current), expected);
  });
}

String methodOf(Map<String, dynamic> frame) =>
    (frame['op'] as Map)['method'] as String;

bool isOp(Map<String, dynamic> frame) => frame['type'] == 'worker-op';

bool isWrite(Map<String, dynamic> frame) =>
    isOp(frame) && firestoreWrites.contains(methodOf(frame));

/// One write frame as `method path data [options]`, or `method` and its writes.
String describeWrite(Map<String, dynamic> frame) {
  final op = frame['op'] as Map;
  final writes = op['writes'];
  if (writes is List) {
    final described =
        writes.cast<Map>().map((w) => '${w['method']} ${w['path']}');
    return '${op['method']} ${described.join(', ')}';
  }
  final parts = [op['method'], op['path'], op['data'], op['options']];
  return parts.where((part) => part != null).join(' ');
}

List<String> writesOn(FakeSocket socket) =>
    socket.sent.where(isWrite).map(describeWrite).toList();

List<String> transactionFramesOn(FakeSocket socket) => socket.sent
    .where((frame) => isOp(frame) && const {'getDoc', 'txnCommit'}.contains(methodOf(frame)))
    .map(describeWrite)
    .toList();

/// Answers every operation the way the host does, so each one settles.
void answerOps(FakeBridge bridge) {
  bridge.onFrame = (frame) {
    if (!isOp(frame)) return;
    final socket = bridge.current;
    scheduleMicrotask(() => socket.deliver(
        {'type': 'worker-res', 'id': frame['id'], 'ok': true, 'value': null}));
  };
}
