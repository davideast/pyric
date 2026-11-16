import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_flutter_client.dart';
import 'package:pyric_firestore/src/database/instance_name.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

class _CaptureChannel extends StreamChannelMixin<dynamic>
    implements WebSocketChannel {
  final StreamController<dynamic> toServer =
      StreamController<dynamic>.broadcast();
  final StreamController<dynamic> toClient =
      StreamController<dynamic>.broadcast();

  @override
  Stream<dynamic> get stream => toClient.stream;

  @override
  WebSocketSink get sink => _CaptureSink(toServer);

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  Future<void> get ready => Future.value();
}

class _CaptureSink implements WebSocketSink {
  final StreamController<dynamic> _controller;
  _CaptureSink(this._controller);

  @override
  void add(dynamic data) => _controller.add(data);

  @override
  void addError(Object error, [StackTrace? st]) =>
      _controller.addError(error, st);

  @override
  Future<void> addStream(Stream<dynamic> s) => _controller.addStream(s);

  @override
  Future<void> close([int? closeCode, String? closeReason]) =>
      _controller.close();

  @override
  Future<void> get done => _controller.done;
}

void main() {
  group('resolveDatabaseInstanceName', () {
    test('extracts instance name from standard, regional, ns query, and bare URLs', () {
      expect(
        resolveDatabaseInstanceName('https://secondary-db.firebaseio.com'),
        equals('secondary-db'),
      );
      expect(
        resolveDatabaseInstanceName(
          'https://analytics-eu.europe-west1.firebasedatabase.app/',
        ),
        equals('analytics-eu'),
      );
      expect(
        resolveDatabaseInstanceName('http://localhost:9000/?ns=tenant-b'),
        equals('tenant-b'),
      );
      expect(
        resolveDatabaseInstanceName('http://127.0.0.1:9000/?ns=Custom-NS'),
        equals('custom-ns'),
      );
      expect(
        resolveDatabaseInstanceName('regional-cache'),
        equals('regional-cache'),
      );
    });

    test('returns null for absent, default, localhost, or project-default URLs', () {
      expect(resolveDatabaseInstanceName(null), isNull);
      expect(resolveDatabaseInstanceName(''), isNull);
      expect(resolveDatabaseInstanceName('default'), isNull);
      expect(
        resolveDatabaseInstanceName('https://default.firebaseio.com'),
        isNull,
      );
      expect(resolveDatabaseInstanceName('http://localhost:9000/'), isNull);
      expect(resolveDatabaseInstanceName('http://127.0.0.1:9000/'), isNull);
      expect(
        resolveDatabaseInstanceName(
          'https://demo-proj-default-rtdb.firebaseio.com',
          projectId: 'demo-proj',
        ),
        isNull,
      );
      expect(
        resolveDatabaseInstanceName(
          'https://demo-proj.firebaseio.com',
          projectId: 'demo-proj',
        ),
        isNull,
      );
    });
  });

  group('PyricDatabase wire instance propagation', () {
    late _CaptureChannel channel;
    late List<Map<String, dynamic>> sentFrames;
    late StreamSubscription<dynamic> serverSub;
    late PyricBridgeClient bridge;

    setUp(() async {
      channel = _CaptureChannel();
      sentFrames = [];
      serverSub = channel.toServer.stream.listen((raw) {
        if (raw is! String) return;
        final frame = jsonDecode(raw) as Map<String, dynamic>;
        sentFrames.add(frame);
        final type = frame['type'];
        if (type == 'attach') {
          channel.toClient.add(
            jsonEncode({
              'type': 'attach-ack',
              'protocol': 1,
              'peerConnected': true,
            }),
          );
        } else if (type == 'worker-op') {
          final id = frame['id'] as String;
          final op = frame['op'] as Map<String, dynamic>;
          final method = op['method'] as String;
          Object? value;
          if (method == 'rtdb.get') {
            value = {
              'key': 'item',
              'exists': true,
              'value': 1,
              'priority': null,
              'entries': const <dynamic>[],
            };
          } else if (method == 'rtdb.transactionCommit') {
            value = {
              'committed': true,
              'snapshot': {
                'key': 'item',
                'exists': true,
                'value': 2,
                'priority': null,
                'entries': const <dynamic>[],
              },
            };
          }
          channel.toClient.add(
            jsonEncode({
              'type': 'worker-res',
              'id': id,
              'ok': true,
              'value': value,
            }),
          );
        }
      });

      bridge = PyricBridgeClient(
        channelFactory: (uri, headers) async => channel,
      );
      await bridge.connect();
    });

    tearDown(() async {
      await bridge.disconnect();
      await serverSub.cancel();
      await channel.toServer.close();
      await channel.toClient.close();
    });

    test('stamps wire instance on all rtdb.* ops and subscriptions for non-default databaseURL', () async {
      final db = PyricDatabase(
        databaseURL: 'https://analytics-eu.europe-west1.firebasedatabase.app',
        bridgeClient: bridge,
      );
      final ref = db.ref('items/item');

      await ref.get();
      await ref.set({'count': 1});
      await ref.setPriority(10);
      await ref.setWithPriority({'count': 2}, 20);
      await ref.update({'count': 3});
      await ref.remove();
      await ref.runTransaction((data) {
        data.value = 2;
        return Transaction.success(data);
      });
      await ref.onDisconnect().set('gone');
      await ref.onDisconnect().setWithPriority('gone', 1);
      await ref.onDisconnect().update({'status': 'offline'});
      await ref.onDisconnect().remove();
      await ref.onDisconnect().cancel();
      await db.goOffline();
      await db.goOnline();

      final sub = ref.onValue.listen((_) {});
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();

      final rtdbOps = sentFrames
          .where((f) => f['type'] == 'worker-op')
          .map((f) => f['op'] as Map<String, dynamic>)
          .where((op) => (op['method'] as String).startsWith('rtdb.'))
          .toList();

      expect(rtdbOps, isNotEmpty);
      for (final op in rtdbOps) {
        expect(
          op['instance'],
          equals('analytics-eu'),
          reason: 'Expected instance on ${op['method']}',
        );
      }

      final rtdbSubs = sentFrames
          .where((f) => f['type'] == 'worker-sub')
          .map((f) => (f['sub'] as Map<String, dynamic>)['target']
              as Map<String, dynamic>)
          .where((target) => target['service'] == 'rtdb')
          .toList();

      expect(rtdbSubs, hasLength(1));
      expect(rtdbSubs.single['instance'], equals('analytics-eu'));
    });

    test('omits wire instance for default PyricDatabase', () async {
      final db = PyricDatabase(bridgeClient: bridge);
      final ref = db.ref('items/item');

      await ref.get();
      await ref.set({'count': 1});
      final sub = ref.onValue.listen((_) {});
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();

      final rtdbOps = sentFrames
          .where((f) => f['type'] == 'worker-op')
          .map((f) => f['op'] as Map<String, dynamic>)
          .where((op) => (op['method'] as String).startsWith('rtdb.'))
          .toList();

      expect(rtdbOps, hasLength(2));
      for (final op in rtdbOps) {
        expect(op.containsKey('instance'), isFalse);
      }

      final rtdbSubs = sentFrames
          .where((f) => f['type'] == 'worker-sub')
          .map((f) => (f['sub'] as Map<String, dynamic>)['target']
              as Map<String, dynamic>)
          .where((target) => target['service'] == 'rtdb')
          .toList();

      expect(rtdbSubs, hasLength(1));
      expect(rtdbSubs.single.containsKey('instance'), isFalse);
    });
  });
}
