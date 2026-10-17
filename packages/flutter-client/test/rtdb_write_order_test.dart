import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_flutter_client.dart';

import 'helpers/fake_bridge.dart';
import 'helpers/rtdb_test_harness.dart' show MockRtdbCredentialsProvider;

// #1026. Writes and onDisconnect operations from one database reach the
// bridge in the order the app called them. Each write method runs
// synchronously into `PyricBridgeClient.op`, which sends the frame or appends
// it to the held FIFO before anything can yield, so call order is frame order.
void main() {
  const rounds = 50;

  late FakeBridge bridge;
  late PyricBridgeClient client;
  late MockRtdbCredentialsProvider credentials;
  late PyricDatabase db;

  setUp(() {
    bridge = FakeBridge();
    client = PyricBridgeClient(
      channelFactory: bridge.connect,
      reconnectDelay: (_) => Duration.zero,
    );
    credentials = MockRtdbCredentialsProvider();
    db = PyricDatabase(bridgeClient: client, credentialsProvider: credentials);
    answerWrites(bridge);
  });

  tearDown(() async {
    await client.disconnect();
    await credentials.dispose();
  });

  /// Issues the presence sample's pair [rounds] times without awaiting, and
  /// returns the write frames it expects, in call order.
  List<String> issuePresencePairs(String label) {
    final expected = <String>[];
    for (var i = 0; i < rounds; i++) {
      final status = db.ref('status/$label-$i');
      status.onDisconnect().set('offline').ignore();
      status.set('online').ignore();
      expected
        ..add('rtdb.onDisconnectSet /status/$label-$i offline')
        ..add('rtdb.set /status/$label-$i online');
    }
    return expected;
  }

  /// Issues every write and onDisconnect method once without awaiting, and
  /// returns the write frames it expects, in call order.
  List<String> issueEveryWriteMethod() {
    final ref = db.ref('rooms/a');
    final disconnect = ref.onDisconnect();
    disconnect.set('gone').ignore();
    ref.set('one').ignore();
    disconnect.setWithPriority('gone', 1).ignore();
    ref.update({'title': 'two'}).ignore();
    disconnect.update({'title': 'left'}).ignore();
    ref.setPriority(2).ignore();
    disconnect.remove().ignore();
    ref.setWithPriority('three', 3).ignore();
    disconnect.cancel().ignore();
    ref.remove().ignore();
    return [
      'rtdb.onDisconnectSet /rooms/a gone',
      'rtdb.set /rooms/a one',
      'rtdb.onDisconnectSet /rooms/a gone',
      'rtdb.update /rooms/a {title: two}',
      'rtdb.onDisconnectUpdate /rooms/a {title: left}',
      'rtdb.setPriority /rooms/a null',
      'rtdb.onDisconnectRemove /rooms/a null',
      'rtdb.setWithPriority /rooms/a three',
      'rtdb.onDisconnectCancel /rooms/a null',
      'rtdb.remove /rooms/a null',
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

  test('onDisconnect().set then set, issued $rounds times while attached, reach the bridge in call order', () async {
    await client.connect();
    final expected = issuePresencePairs('attached');
    expect(writesOn(bridge.current), expected);
  });

  test('onDisconnect().set then set, issued $rounds times while held, reach the new socket in call order', () async {
    await client.connect();
    await dropAndHold();
    final expected = issuePresencePairs('held');
    await settle();
    expect(bridge.frames.where(isWrite), isEmpty, reason: 'nothing is sent while held');

    await reattach();
    expect(writesOn(bridge.current), expected);
  });

  test('writes issued right after the re-attach go behind the held ones', () async {
    await client.connect();
    await dropAndHold();
    final held = issuePresencePairs('held');

    await reattach();
    final after = issuePresencePairs('after');
    expect(writesOn(bridge.current), [...held, ...after]);
  });

  test('every write and onDisconnect method keeps call order, attached and held', () async {
    await client.connect();
    final attached = issueEveryWriteMethod();
    expect(writesOn(bridge.current), attached);

    await dropAndHold();
    final held = issueEveryWriteMethod();
    await reattach();
    expect(writesOn(bridge.current), held);
  });
}

bool isWrite(Map<String, dynamic> frame) {
  if (frame['type'] != 'worker-op') return false;
  final method = (frame['op'] as Map)['method'] as String;
  return method.startsWith('rtdb.') && method != 'rtdb.get';
}

/// One write frame as `method path value`; the value falls back to `values`.
String describeWrite(Map<String, dynamic> frame) {
  final op = frame['op'] as Map;
  final payload = op.containsKey('value') ? op['value'] : op['values'];
  return '${op['method']} ${op['path']} $payload';
}

List<String> writesOn(FakeSocket socket) =>
    socket.sent.where(isWrite).map(describeWrite).toList();

/// Answers every RTDB write the way the host does, so each write settles.
void answerWrites(FakeBridge bridge) {
  bridge.onFrame = (frame) {
    if (!isWrite(frame)) return;
    final socket = bridge.current;
    scheduleMicrotask(() => socket.deliver(
        {'type': 'worker-res', 'id': frame['id'], 'ok': true, 'value': null}));
  };
}
