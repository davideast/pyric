import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_flutter_client.dart';

import 'helpers/fake_bridge.dart';
import 'helpers/rtdb_test_harness.dart' show MockRtdbCredentialsProvider;

// rtdb-flutter#info-connected. ADR-0019, amendment of 2026-10-16: the client
// serves `.info` itself, and an onDisconnect re-armed when `connected` turns
// true reaches the new socket after the whole restore.
void main() {
  late FakeBridge bridge;
  late PyricBridgeClient client;
  late MockRtdbCredentialsProvider credentials;
  late PyricDatabase db;
  late List<bool> connected;
  final subscriptions = <StreamSubscription<Object?>>[];

  setUp(() {
    bridge = FakeBridge();
    client = PyricBridgeClient(
      channelFactory: bridge.connect,
      reconnectDelay: (_) => Duration.zero,
    );
    credentials = MockRtdbCredentialsProvider();
    db = PyricDatabase(bridgeClient: client, credentialsProvider: credentials);
    connected = [];
  });

  tearDown(() async {
    for (final sub in subscriptions) {
      await sub.cancel();
    }
    subscriptions.clear();
    await client.disconnect();
    await credentials.dispose();
  });

  Iterable<Map<String, dynamic>> opsNamed(String method, FakeSocket socket) =>
      socket.sentOfType('worker-op').where((f) => (f['op'] as Map)['method'] == method);

  Map<String, dynamic> onlyOp(String method, FakeSocket socket) =>
      opsNamed(method, socket).single;

  void reply(Map<String, dynamic> frame, dynamic value) => bridge.current
      .deliver({'type': 'worker-res', 'id': frame['id'], 'ok': true, 'value': value});

  /// Answers every RTDB write the way the host does, so held writes settle.
  void answerWrites() {
    bridge.onFrame = (frame) {
      final isWorkerOp = frame['type'] == 'worker-op';
      final method = isWorkerOp ? (frame['op'] as Map)['method'] as String : '';
      final isRtdbWrite = method.startsWith('rtdb.') && method != 'rtdb.get';
      if (!isRtdbWrite) return;
      final socket = bridge.current;
      scheduleMicrotask(() => socket.deliver(
          {'type': 'worker-res', 'id': frame['id'], 'ok': true, 'value': null}));
    };
  }

  /// The presence sample: on each `true`, arm onDisconnect, then go online.
  void listenAsPresence() {
    subscriptions.add(db.ref('.info/connected').onValue.listen((event) {
      final isConnected = event.snapshot.value == true;
      connected.add(isConnected);
      if (!isConnected) return;
      final status = db.ref('status/u1');
      status.onDisconnect().set('offline').ignore();
      status.set('online').ignore();
    }));
  }

  void listenToRoom() {
    subscriptions.add(db.ref('rooms/a').onValue.listen((_) {}, onError: (_) {}));
  }

  bool mentionsInfo(Map<String, dynamic> frame) => jsonEncode(frame).contains('.info');

  test('connected reports false, true, false, true across a drop and a re-attach, with no repeated value', () async {
    listenAsPresence();
    await until(() => connected.length == 2);
    expect(connected, [false, true]);

    bridge.refuseConnections = true;
    bridge.current.drop();
    await until(() => connected.length == 3);
    await settle();
    expect(connected, [false, true, false], reason: 'failed attempts repeat no false');

    bridge.refuseConnections = false;
    await until(() => connected.length == 4);
    await settle();
    expect(connected, [false, true, false, true]);
  });

  test('an onDisconnect re-armed on true goes on the new socket after the replayed listener and the held write', () async {
    answerWrites();
    listenToRoom();
    listenAsPresence();
    await until(() => opsNamed('rtdb.onDisconnectSet', bridge.current).isNotEmpty);

    bridge.refuseConnections = true;
    bridge.current.drop();
    await until(() => connected.length == 3);
    db.ref('rooms/a/title').set('held').ignore();

    bridge.refuseConnections = false;
    await until(() => bridge.sockets.length == 2 &&
        opsNamed('rtdb.onDisconnectSet', bridge.current).isNotEmpty);
    final socket = bridge.sockets[1];
    final sent = socket.sent;
    final replayed = sent.indexOf(socket.sentOfType('worker-sub').singleWhere(
        (f) => ((f['sub'] as Map)['target'] as Map)['path'] == '/rooms/a'));
    final held = sent.indexOf(opsNamed('rtdb.set', socket)
        .singleWhere((f) => (f['op'] as Map)['path'] == '/rooms/a/title'));
    final rearmed = sent.indexOf(onlyOp('rtdb.onDisconnectSet', socket));
    expect(held, greaterThan(replayed));
    expect(rearmed, greaterThan(held));
    expect((sent[rearmed]['op'] as Map)['path'], '/status/u1');
  });

  test('on a replaced host, the re-arm waits for the Auth restore and goes after it and the replayed listener', () async {
    answerWrites();
    client.restoreAuth = (op) async {
      await op('auth.restorePortSession', {'uid': 'u1', 'tenantId': null});
    };
    listenToRoom();
    listenAsPresence();
    await until(() => opsNamed('rtdb.onDisconnectSet', bridge.current).isNotEmpty);

    bridge.hostInstanceId = 'host-b';
    bridge.current.drop();
    await until(() => bridge.sockets.length == 2 &&
        opsNamed('auth.restorePortSession', bridge.current).isNotEmpty);
    await settle();
    final socket = bridge.sockets[1];
    expect(connected, [false, true, false], reason: 'true waits for the restore');
    expect(opsNamed('rtdb.onDisconnectSet', socket), isEmpty);

    reply(onlyOp('auth.restorePortSession', socket), {'uid': 'u1'});
    await until(() => opsNamed('rtdb.onDisconnectSet', socket).isNotEmpty);
    final sent = socket.sent;
    final restored = sent.indexOf(onlyOp('auth.restorePortSession', socket));
    final replayed = sent.indexOf(socket.sentOfType('worker-sub').singleWhere(
        (f) => ((f['sub'] as Map)['target'] as Map)['path'] == '/rooms/a'));
    final rearmed = sent.indexOf(onlyOp('rtdb.onDisconnectSet', socket));
    expect(replayed, greaterThan(restored));
    expect(rearmed, greaterThan(replayed));
    expect(connected, [false, true, false, true]);
  });

  test('no frame for a path under .info is ever sent, across listeners, reads and a re-attach', () async {
    answerWrites();
    listenAsPresence();
    subscriptions
      ..add(db.ref('.info').onValue.listen((_) {}))
      ..add(db.ref('.info').onChildChanged.listen((_) {}))
      ..add(db.ref('.info/serverTimeOffset').onValue.listen((_) {}))
      ..add(db.ref('.info/authenticated').onValue.listen((_) {}));
    await until(() => connected.length == 2);
    await db.ref('.info/connected').get();
    await db.goOffline();
    await db.goOnline();

    bridge.current.drop();
    await until(() => bridge.sockets.length == 2 && connected.length == 6);
    await settle();
    expect(connected, [false, true, false, true, false, true]);
    expect(bridge.frames.where(mentionsInfo), isEmpty);
  });
}
