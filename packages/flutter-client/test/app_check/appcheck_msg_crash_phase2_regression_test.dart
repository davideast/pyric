import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_app_check.dart';
import 'package:pyric_firestore/pyric_crashlytics.dart';
import 'package:pyric_firestore/pyric_messaging.dart';

import '../auth/mock_bridge_helper.dart';

const FirebaseOptions _opts = FirebaseOptions(
  apiKey: 'demo-key',
  appId: '1:123456:android:abc',
  messagingSenderId: '123456',
  projectId: 'demo-p2',
);

class _TestFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(appName, options ?? _opts);
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    final existing = _apps[name];
    if (existing != null) return existing;
    throw StateError('Missing app $name');
  }
}

void _onOutbound(
  MockBridgeHarness harness,
  void Function(Map<String, dynamic> msg) handler,
) {
  harness.channel.toServerController.stream.listen((raw) {
    if (raw is! String) return;
    final msg = Map<String, dynamic>.from(jsonDecode(raw) as Map);
    if (msg['type'] == 'attach') {
      harness.ackAttach(clientSessionId: 'sess-amc-p2');
      return;
    }
    handler(msg);
  });
}

void main() {
  setUp(() async {
    FirebasePlatform.instance = _TestFirebasePlatform();
    await Firebase.initializeApp(options: _opts);
    await Firebase.initializeApp(name: 'secondary', options: _opts);
  });

  tearDown(() async {
    await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
    await FirebaseMessaging.clearInstancesForTest();
    await FirebaseCrashlytics.clearInstancesForTest();
  });

  test('P2-F03 & P2-F04: activated AppCheck auto-attaches token, guards stale mint, and avoids 0ms refresh storm', () async {
    final harness = MockBridgeHarness();
    final firstMint = Completer<Map<String, dynamic>>();
    var mintCount = 0;
    final recordedOps = <Map<String, dynamic>>[];
    final recordedSubs = <Map<String, dynamic>>[];

    _onOutbound(harness, (msg) {
      if (msg['type'] == 'worker-op') {
        final op = Map<String, dynamic>.from(msg['op'] as Map);
        recordedOps.add(op);
        if (op['method'] == 'appCheck.getToken') {
          mintCount++;
          if (mintCount == 1) {
            firstMint.future.then((value) {
              harness.sendToClient({
                'type': 'worker-res',
                'id': msg['id'],
                'ok': true,
                'value': value,
              });
            });
          } else {
            harness.sendToClient({
              'type': 'worker-res',
              'id': msg['id'],
              'ok': true,
              'value': {
                'token': 'tok-fresh',
                'expireTimeMillis': 1000 + 20000,
              },
            });
          }
          return;
        }
        harness.sendToClient({
          'type': 'worker-res',
          'id': msg['id'],
          'ok': true,
          'value': <String, dynamic>{},
        });
      } else if (msg['type'] == 'worker-sub') {
        recordedSubs.add(Map<String, dynamic>.from(msg['sub'] as Map));
      }
    });

    final client = harness.createClient();
    await client.connect();

    const nowMs = 1000;
    final appCheck = PyricFirebaseAppCheckPlatform(
      bridgeClient: client,
      clockMillis: () => nowMs,
      isTokenAutoRefreshEnabled: true,
    );
    await appCheck.activate();

    final emitted = <String?>[];
    final tokSub = appCheck.onTokenChange.listen(emitted.add);

    final slowStandard = appCheck.getToken(false);
    await pumpEventQueue();
    final fastForced = await appCheck.getToken(true);
    expect(fastForced, 'tok-fresh');

    firstMint.complete({
      'token': 'tok-stale',
      'expireTimeMillis': nowMs + 600000,
    });
    expect(await slowStandard, 'tok-stale');
    final beforeDelayMints = mintCount;
    // Short-lived token (TTL < 5 min) must not spin at 0ms.
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(mintCount, beforeDelayMints);
    await pumpEventQueue();
    expect(emitted, ['tok-fresh']);

    await client.op('firestore.get', {'path': 'items/1'});
    final internalSub = client.subscribeRaw({'target': 'authState'}).listen((_) {});
    final dataSub = client.subscribeRaw({'target': {'service': 'rtdb', 'path': '/x'}}).listen((_) {});
    await pumpEventQueue();

    final fsOp = recordedOps.lastWhere((o) => o['method'] == 'firestore.get');
    expect(fsOp['appCheckToken'], 'tok-fresh');
    final authWireSub = recordedSubs.firstWhere((s) => s['target'] == 'authState');
    expect(authWireSub.containsKey('appCheckToken'), isFalse);
    final rtdbWireSub = recordedSubs.firstWhere((s) => s['target'] is Map);
    expect(rtdbWireSub['appCheckToken'], 'tok-fresh');

    final headers = await attachAppCheckHeaderToHttpHeaders(
      const <String, String>{'content-length': '0'},
      client.appCheckTokenProvider,
    );
    expect(headers['X-Firebase-AppCheck'], 'tok-fresh');

    await internalSub.cancel();
    await dataSub.cancel();
    await tokSub.cancel();
    await appCheck.dispose();
    await client.disconnect();
  });

  test('P2-F05a: secondary Crashlytics app does not inherit root default AppCheck token', () async {
    final harness = MockBridgeHarness();
    final ops = <Map<String, dynamic>>[];
    _onOutbound(harness, (msg) {
      if (msg['type'] == 'worker-op') {
        final op = Map<String, dynamic>.from(msg['op'] as Map);
        ops.add(op);
        harness.sendToClient({
          'type': 'worker-res',
          'id': msg['id'],
          'ok': true,
          'value': op['method'] == 'appCheck.getToken'
              ? {'token': 'root-tok', 'expireTimeMillis': 9999999999999}
              : <String, dynamic>{},
        });
      }
    });

    final client = harness.createClient();
    await client.connect();

    final rootAppCheck = PyricFirebaseAppCheckPlatform.registerWith(
      bridgeClient: client,
    );
    await rootAppCheck.activate();
    client.appCheckTokenProvider = null;

    final secondaryApp = Firebase.app('secondary');
    final crash = FirebaseCrashlytics.instanceFor(
      app: secondaryApp,
      bridgeClient: client,
    );
    await crash.log('hello-secondary');
    final logOp = ops.lastWhere((o) => o['method'] == 'crashlytics.log');
    expect(logOp.containsKey('appCheckToken'), isFalse);

    await crash.dispose();
    await rootAppCheck.dispose();
    await client.disconnect();
  });

  test('P2-F09: Messaging deleteToken passes recipientId, prevents stale getToken overwrite, and guards non-finite sentTime', () async {
    final harness = MockBridgeHarness();
    final getTokenCompleter = Completer<String>();
    final deleteParams = <Map<String, dynamic>>[];
    _onOutbound(harness, (msg) {
      if (msg['type'] == 'worker-op') {
        final op = Map<String, dynamic>.from(msg['op'] as Map);
        if (op['method'] == 'messaging.getToken') {
          getTokenCompleter.future.then((tok) {
            harness.sendToClient({
              'type': 'worker-res',
              'id': msg['id'],
              'ok': true,
              'value': {'token': tok},
            });
          });
        } else if (op['method'] == 'messaging.deleteToken') {
          deleteParams.add(op);
          harness.sendToClient({
            'type': 'worker-res',
            'id': msg['id'],
            'ok': true,
            'value': <String, dynamic>{},
          });
        }
      }
    });

    final client = harness.createClient();
    await client.connect();

    final msg = FirebaseMessaging.instanceFor(
      bridgeClient: client,
      registrationId: 'reg-1',
      recipientId: 'rec-1',
    );
    final refreshes = <String>[];
    final sub = msg.onTokenRefresh.listen(refreshes.add);

    final pendingGet = msg.getToken();
    await pumpEventQueue();
    await msg.deleteToken();
    expect(deleteParams.single['recipientId'], 'rec-1');

    getTokenCompleter.complete('stale-token');
    expect(await pendingGet, 'stale-token');
    await pumpEventQueue();
    expect(refreshes, isEmpty);

    final decoded = RemoteMessage.fromMap({'sentTime': double.nan});
    expect(decoded.sentTime, isNull);

    await sub.cancel();
    await msg.dispose();
    await client.disconnect();
  });

  test('P2-F10: Crashlytics surrogate truncation, false didCrash sync, atomic mutation on failure, and disposed guard', () async {
    const emoji = '\u{1F600}';
    expect(truncateCrashlyticsString('a$emoji', 2), 'a');
    expect(truncateCrashlyticsString('a$emoji', 3), 'a$emoji');

    final harness = MockBridgeHarness();
    var failNext = true;
    _onOutbound(harness, (msg) {
      if (msg['type'] == 'worker-op') {
        final op = Map<String, dynamic>.from(msg['op'] as Map);
        if (op['method'] == 'crashlytics.setUserId' && failNext) {
          failNext = false;
          harness.sendToClient({
            'type': 'worker-res',
            'id': msg['id'],
            'ok': false,
            'error': {'code': 'unavailable', 'message': 'boom'},
          });
          return;
        }
        if (op['method'] == 'crashlytics.getState') {
          harness.sendToClient({
            'type': 'worker-res',
            'id': msg['id'],
            'ok': true,
            'value': {'didCrashOnPreviousExecution': false},
          });
          return;
        }
        harness.sendToClient({
          'type': 'worker-res',
          'id': msg['id'],
          'ok': true,
          'value': <String, dynamic>{},
        });
      }
    });

    final client = harness.createClient();
    await client.connect();

    final crash = FirebaseCrashlytics.instanceFor(bridgeClient: client);
    crash.simulatePreviousCrashForTest(true);
    expect(await crash.didCrashOnPreviousExecution(), isFalse);

    await expectLater(crash.setUserIdentifier('alice'), throwsA(isA<Object>()));
    await crash.dispose();
    await expectLater(crash.log('after-dispose'), throwsA(isA<FirebaseException>()));
    await client.disconnect();
  });
}
