import 'dart:async';

import 'package:firebase_core/firebase_core.dart' show Firebase;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_messaging.dart';

import '../helpers/fake_bridge.dart';

class _TestMessagingFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = FirebaseAppPlatform(
      appName,
      options ??
          const FirebaseOptions(
            apiKey: 'demo-key',
            appId: '1:999999999999:android:messagingunit',
            messagingSenderId: '999999999999',
            projectId: 'demo-messaging-unit',
          ),
    );
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    final existing = _apps[name];
    if (existing != null) return existing;
    throw FirebaseException(
      plugin: 'core',
      code: 'no-app',
      message: 'No Firebase App $name has been created.',
    );
  }
}

class _InMemoryMessagingHost {
  final FakeBridge bridge = FakeBridge();
  final Map<String, String> _tokensByReg = <String, String>{};
  final Set<String> _unregisteredTokens = <String>{};
  final Map<String, Set<String>> _topics = <String, Set<String>>{};
  final Map<String, String> _visibilityByRecipient = <String, String>{};
  final Map<String, String> _fgSubIdsByRecipient = <String, String>{};
  final Map<String, String> _bgSubIdsByRecipient = <String, String>{};
  int _tokenSeq = 0;
  bool messagingEnabled = true;

  _InMemoryMessagingHost() {
    bridge.onFrame = _handleFrame;
  }

  PyricBridgeClient createClient() {
    return PyricBridgeClient(
      uri: Uri.parse('ws://127.0.0.1:5174/sandbox'),
      channelFactory: bridge.connect,
    );
  }

  String _mintToken(int n) {
    final prefix = 'fcmReg${n.toString().padLeft(16, '0')}';
    final suffix = 'APA91b${'X' * (142 - prefix.length - 1 - 6)}';
    return '$prefix:$suffix';
  }

  void _handleFrame(Map<String, dynamic> frame) {
    final type = frame['type'];
    if (type == 'worker-sub') {
      final subId = frame['subId'] as String;
      final sub = Map<String, dynamic>.from(frame['sub'] as Map);
      final target = sub['target'];
      final recipientId = (sub['recipientId'] as String?) ?? 'sandbox-default';
      if (!messagingEnabled) {
        scheduleMicrotask(() {
          bridge.current.deliver(<String, dynamic>{
            'type': 'worker-snap',
            'subId': subId,
            'clientSessionId': bridge.sessionId,
            'value': <String, dynamic>{
              '__error': <String, dynamic>{
                'code': 'messaging/disabled',
                'message': 'Messaging disabled on host.',
              },
            },
          });
        });
        return;
      }
      if (target == 'messaging.foreground') {
        _fgSubIdsByRecipient[recipientId] = subId;
      } else if (target == 'messaging.background') {
        _bgSubIdsByRecipient[recipientId] = subId;
      }
      return;
    }

    if (type == 'worker-unsub') {
      final subId = frame['subId'] as String;
      _fgSubIdsByRecipient.removeWhere((_, v) => v == subId);
      _bgSubIdsByRecipient.removeWhere((_, v) => v == subId);
      return;
    }

    if (type != 'worker-op') return;
    final id = frame['id'] as String;
    final op = Map<String, dynamic>.from(frame['op'] as Map);
    final method = op['method'] as String;

    if (!messagingEnabled) {
      _replyErr(id, 'messaging/disabled', 'Messaging disabled on host.');
      return;
    }

    switch (method) {
      case 'messaging.getToken':
        final regId = (op['registrationId'] as String?) ?? 'swreg-port-default';
        final token =
            _tokensByReg.putIfAbsent(regId, () => _mintToken(++_tokenSeq));
        _replyOk(id, <String, dynamic>{'token': token});
      case 'messaging.deleteToken':
        final regId = (op['registrationId'] as String?) ?? 'swreg-port-default';
        final removed = _tokensByReg.remove(regId);
        if (removed != null) _unregisteredTokens.add(removed);
        _replyOk(id, true);
      case 'messaging.subscribeToTopic':
        final tokens = List<String>.from(op['tokens'] as List);
        final rawTopic = op['topic'] as String;
        final bare = rawTopic.startsWith('/topics/')
            ? rawTopic.substring('/topics/'.length)
            : rawTopic;
        final set = _topics.putIfAbsent(bare, () => <String>{});
        final errors = <Map<String, dynamic>>[];
        var okCount = 0;
        for (var i = 0; i < tokens.length; i++) {
          if (_unregisteredTokens.contains(tokens[i])) {
            errors.add(<String, dynamic>{
              'index': i,
              'reason': 'unregistered-token',
            });
          } else {
            set.add(tokens[i]);
            okCount++;
          }
        }
        _replyOk(id, <String, dynamic>{
          'successCount': okCount,
          'failureCount': errors.length,
          'errors': errors,
        });
      case 'messaging.unsubscribeFromTopic':
        final tokens = List<String>.from(op['tokens'] as List);
        final rawTopic = op['topic'] as String;
        final bare = rawTopic.startsWith('/topics/')
            ? rawTopic.substring('/topics/'.length)
            : rawTopic;
        final set = _topics[bare];
        for (final t in tokens) {
          set?.remove(t);
        }
        _replyOk(id, <String, dynamic>{
          'successCount': tokens.length,
          'failureCount': 0,
          'errors': const <Map<String, dynamic>>[],
        });
      case 'messaging.setVisibility':
        final recipientId = (op['recipientId'] as String?) ?? 'sandbox-default';
        _visibilityByRecipient[recipientId] = op['state'] as String;
        _replyOk(id, null);
      case 'messaging.deliver':
        final recipientId = (op['recipientId'] as String?) ?? 'sandbox-default';
        final spec = Map<String, dynamic>.from(op['spec'] as Map);
        final visOverride = spec['visibilityState'] as String?;
        if (visOverride != null) {
          _visibilityByRecipient[recipientId] = visOverride;
        }
        final payload = <String, dynamic>{
          'from': (spec['from'] as String?) ?? '999999999999',
          'messageId': (spec['messageId'] as String?) ?? 'msg-deliver-1',
          if (spec['data'] != null) 'data': spec['data'],
          if (spec['notification'] != null)
            'notification': spec['notification'],
        };
        final result = _routeToRecipient(recipientId, payload);
        _replyOk(id, result);
      case 'messaging.send':
        final msg = Map<String, dynamic>.from(op['message'] as Map);
        final targetToken = msg['token'] as String?;
        if (targetToken != null && _unregisteredTokens.contains(targetToken)) {
          _replyErr(id, 'NOT_FOUND', 'Requested entity was not found.');
          return;
        }
        _replyOk(id, <String, dynamic>{
          'name': 'projects/demo-messaging-unit/messages/msg-send-1',
          'messageId': 'msg-send-1',
          'target': <String, dynamic>{
            'kind': targetToken != null ? 'token' : 'topic',
          },
          'validateOnly': op['validateOnly'] == true,
        });
      default:
        _replyErr(id, 'unimplemented', 'Unhandled op $method');
    }
  }

  Map<String, dynamic> _routeToRecipient(
    String recipientId,
    Map<String, dynamic> payload,
  ) {
    final isVisible = _visibilityByRecipient[recipientId] == 'visible';
    final route = isVisible ? 'foreground' : 'background';
    final subId = isVisible
        ? _fgSubIdsByRecipient[recipientId]
        : _bgSubIdsByRecipient[recipientId];
    if (subId != null) {
      scheduleMicrotask(() {
        bridge.current.deliver(<String, dynamic>{
          'type': 'worker-snap',
          'subId': subId,
          'clientSessionId': bridge.sessionId,
          'value': payload,
        });
      });
    }
    return <String, dynamic>{
      'route': route,
      'handlerCount': subId != null ? 1 : 0,
      'payload': payload,
    };
  }

  void _replyOk(String id, Object? value) {
    scheduleMicrotask(() {
      bridge.current.deliver(<String, dynamic>{
        'type': 'worker-res',
        'id': id,
        'clientSessionId': bridge.sessionId,
        'ok': true,
        'value': value,
      });
    });
  }

  void _replyErr(String id, String code, String message) {
    scheduleMicrotask(() {
      bridge.current.deliver(<String, dynamic>{
        'type': 'worker-res',
        'id': id,
        'clientSessionId': bridge.sessionId,
        'ok': false,
        'error': <String, dynamic>{'code': code, 'message': message},
      });
    });
  }
}

void main() {
  setUp(() async {
    FirebasePlatform.instance = _TestMessagingFirebasePlatform();
    await Firebase.initializeApp();
    await Firebase.initializeApp(
      name: 'secondary',
      options: const FirebaseOptions(
        apiKey: 'sec-key',
        appId: '1:888888888888:android:secondary',
        messagingSenderId: '888888888888',
        projectId: 'demo-messaging-secondary',
      ),
    );
  });

  tearDown(() async {
    await FirebaseMessaging.clearInstancesForTest();
  });

  group('RemoteMessage and NotificationSettings wire codecs', () {
    test('round-trips full RemoteMessage, platform sub-blocks, and flat DeliveredPayload image', () {
      final original = RemoteMessage(
        senderId: '999999999999',
        category: 'promo',
        collapseKey: 'ck-1',
        contentAvailable: true,
        data: const <String, dynamic>{'orderId': '42', 'tier': 'gold'},
        from: '999999999999',
        messageId: 'mid-101',
        messageType: 'gcm',
        mutableContent: true,
        sentTime: DateTime.fromMillisecondsSinceEpoch(1700000000000),
        threadId: 'thread-7',
        ttl: 3600,
        notification: const RemoteNotification(
          title: 'Order Shipped',
          titleLocKey: 'ORDER_TITLE',
          titleLocArgs: <String>['42'],
          body: 'Arriving tomorrow',
          bodyLocKey: 'ORDER_BODY',
          bodyLocArgs: <String>['tomorrow'],
          android: AndroidNotification(
            channelId: 'orders',
            priority: AndroidNotificationPriority.highPriority,
            visibility: AndroidNotificationVisibility.public,
            count: 3,
            imageUrl: 'https://cdn.example.test/box.png',
          ),
          apple: AppleNotification(
            badge: '3',
            subtitle: 'Express',
            sound: AppleNotificationSound(
              critical: true,
              name: 'chime.caf',
              volume: 0.8,
            ),
          ),
          web: WebNotification(
            analyticsLabel: 'ship-campaign',
            image: 'https://cdn.example.test/box.png',
            link: 'https://example.test/orders/42',
          ),
        ),
      );

      final decoded = RemoteMessage.fromMap(original.toMap());
      expect(decoded.messageId, equals('mid-101'));
      expect(decoded.from, equals('999999999999'));
      expect(decoded.data, equals(<String, dynamic>{'orderId': '42', 'tier': 'gold'}));
      expect(decoded.sentTime?.millisecondsSinceEpoch, equals(1700000000000));
      expect(decoded.notification?.title, equals('Order Shipped'));
      expect(
        decoded.notification?.android?.priority,
        equals(AndroidNotificationPriority.highPriority),
      );
      expect(
        decoded.notification?.android?.visibility,
        equals(AndroidNotificationVisibility.public),
      );
      expect(decoded.notification?.apple?.sound?.critical, isTrue);
      expect(decoded.notification?.web?.link, equals('https://example.test/orders/42'));

      final delivered = remoteMessageFromDeliveredPayload(<String, dynamic>{
        'from': '999999999999',
        'messageId': 'mid-flat-1',
        'data': <String, String>{'route': '/inbox'},
        'notification': <String, String>{
          'title': 'Hello',
          'body': 'From Broker',
          'image': 'https://cdn.example.test/hero.png',
        },
      });
      expect(delivered.notification?.title, equals('Hello'));
      expect(delivered.notification?.body, equals('From Broker'));
      expect(
        delivered.notification?.web?.image,
        equals('https://cdn.example.test/hero.png'),
      );
      expect(
        delivered.notification?.android?.imageUrl,
        equals('https://cdn.example.test/hero.png'),
      );
      expect(
        delivered.notification?.apple?.imageUrl,
        equals('https://cdn.example.test/hero.png'),
      );
    });

    test('round-trips NotificationSettings and permission state transitions', () async {
      final messaging = FirebaseMessaging.instance;
      expect(await messaging.isSupported(), isTrue);
      expect(messaging.isAutoInitEnabled, isTrue);
      expect(await messaging.getAPNSToken(), isNull);

      messaging.setAPNSTokenForTesting('apns-hex-01');
      expect(await messaging.getAPNSToken(), equals('apns-hex-01'));

      final provisional = await messaging.requestPermission(
        provisional: true,
        criticalAlert: true,
        announcement: true,
      );
      expect(
        provisional.authorizationStatus,
        equals(AuthorizationStatus.provisional),
      );
      expect(provisional.criticalAlert, equals(AppleNotificationSetting.enabled));
      expect(
        NotificationSettings.fromMap(provisional.toMap()),
        equals(provisional),
      );

      await messaging.setForegroundNotificationPresentationOptions(
        alert: true,
        badge: true,
        sound: true,
      );
      expect(
        messaging.foregroundPresentationOptions,
        equals(const ForegroundPresentationOptions(
          alert: true,
          badge: true,
          sound: true,
        )),
      );

      await messaging.setDeliveryMetricsExportToBigQuery(true);
      expect(messaging.isDeliveryMetricsExportToBigQueryEnabled, isTrue);
    });
  });

  group('Token lifecycle, topics, delivery routing, and errors', () {
    test('mints stable 142-char token, rotates after deleteToken, and emits onTokenRefresh only on change', () async {
      final host = _InMemoryMessagingHost();
      final client = host.createClient();
      addTearDown(client.disconnect);
      FirebaseMessaging.registerWith(bridgeClient: client);

      final refreshed = <String>[];
      final refreshSub =
          FirebaseMessaging.instance.onTokenRefresh.listen(refreshed.add);
      addTearDown(refreshSub.cancel);

      final t1 = await FirebaseMessaging.instance.getToken();
      final t1Repeat = await FirebaseMessaging.instance.getToken();
      expect(t1, isNotNull);
      expect(t1!.length, equals(142));
      expect(t1, contains(':APA91b'));
      expect(t1Repeat, equals(t1));
      await settle();
      expect(refreshed, equals(<String>[t1]));

      await FirebaseMessaging.instance.deleteToken();
      final t2 = await FirebaseMessaging.instance.getToken();
      expect(t2, isNotNull);
      expect(t2, isNot(equals(t1)));
      await settle();
      expect(refreshed, equals(<String>[t1, t2!]));
    });

    test('validates topic syntax and isolates multi-app instanceFor registrations', () async {
      final host = _InMemoryMessagingHost();
      final client = host.createClient();
      addTearDown(client.disconnect);
      FirebaseMessaging.registerWith(bridgeClient: client);

      final primary = FirebaseMessaging.instance;
      final secondary = FirebaseMessaging.instanceFor(
        app: Firebase.app('secondary'),
      );

      final primaryToken = await primary.getToken();
      final secondaryToken = await secondary.getToken();
      expect(primaryToken, isNot(equals(secondaryToken)));

      await primary.subscribeToTopic('weather_alerts');
      await primary.subscribeToTopic('/topics/release.notes~v1');
      await primary.unsubscribeFromTopic('weather_alerts');

      await expectLater(
        () => primary.subscribeToTopic('invalid topic with spaces'),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_messaging')
              .having((e) => e.code, 'code', 'invalid-topic-name'),
        ),
      );
      await expectLater(
        () => primary.subscribeToTopic('/topics/'),
        throwsA(
          isA<FirebaseException>().having((e) => e.code, 'code', 'invalid-topic-name'),
        ),
      );
    });

    test('routes foreground onMessage, background onBackgroundMessage, getInitialMessage, and onMessageOpenedApp', () async {
      final host = _InMemoryMessagingHost();
      final client = host.createClient();
      addTearDown(client.disconnect);
      FirebaseMessaging.registerWith(bridgeClient: client);

      final foregroundReceived = <RemoteMessage>[];
      final backgroundReceived = <RemoteMessage>[];
      final openedReceived = <RemoteMessage>[];

      final fgSub = FirebaseMessaging.onMessage.listen(foregroundReceived.add);
      final openedSub =
          FirebaseMessaging.onMessageOpenedApp.listen(openedReceived.add);
      addTearDown(fgSub.cancel);
      addTearDown(openedSub.cancel);
      FirebaseMessaging.onBackgroundMessage((msg) async {
        backgroundReceived.add(msg);
      });

      final messaging = FirebaseMessaging.instance;
      final fgOutcome = await messaging.deliver(
        visibilityState: 'visible',
        messageId: 'fg-1',
        data: const <String, String>{'screen': 'chat'},
        notification: const <String, String>{'title': 'Ping', 'body': 'Visible'},
      );
      expect(fgOutcome.route, equals('foreground'));
      await until(() => foregroundReceived.length == 1);
      expect(foregroundReceived.single.messageId, equals('fg-1'));
      expect(foregroundReceived.single.data['screen'], equals('chat'));
      expect(backgroundReceived, isEmpty);

      final bgOutcome = await messaging.deliver(
        visibilityState: 'hidden',
        messageId: 'bg-1',
        data: const <String, String>{'sync': 'quiet'},
      );
      expect(bgOutcome.route, equals('background'));
      await until(() => backgroundReceived.length == 1);
      expect(backgroundReceived.single.messageId, equals('bg-1'));
      expect(foregroundReceived.length, equals(1));

      const launchMsg = RemoteMessage(
        messageId: 'cold-launch-1',
        data: <String, dynamic>{'deepLink': '/promo/99'},
      );
      messaging.simulateNotificationOpen(launchMsg, asInitialMessage: true);
      expect(
        (await messaging.getInitialMessage())?.messageId,
        equals('cold-launch-1'),
      );
      expect(await messaging.getInitialMessage(), isNull);

      const warmTapMsg = RemoteMessage(
        messageId: 'warm-tap-1',
        data: <String, dynamic>{'deepLink': '/inbox'},
      );
      messaging.simulateNotificationOpen(warmTapMsg);
      await until(() => openedReceived.length == 1);
      expect(openedReceived.single.messageId, equals('warm-tap-1'));
    });

    test('maps permission-blocked, disabled capability gate, and unregistered send errors to FirebaseException', () async {
      final host = _InMemoryMessagingHost();
      final client = host.createClient();
      addTearDown(client.disconnect);
      FirebaseMessaging.registerWith(bridgeClient: client);

      final messaging = FirebaseMessaging.instance;
      final token = await messaging.getToken();
      await messaging.deleteToken();

      await expectLater(
        () => messaging.sendBrokerMessage(<String, dynamic>{
          'token': token,
          'data': <String, String>{'k': 'v'},
        }),
        throwsA(
          isA<FirebaseMessagingSendException>()
              .having((e) => e.plugin, 'plugin', 'firebase_messaging')
              .having((e) => e.code, 'code', 'unregistered')
              .having((e) => e.status, 'status', 'NOT_FOUND'),
        ),
      );

      messaging.setAuthorizationStatusForTesting(AuthorizationStatus.denied);
      await expectLater(
        () => messaging.getToken(),
        throwsA(
          isA<FirebaseException>().having((e) => e.code, 'code', 'permission-blocked'),
        ),
      );

      messaging.setAuthorizationStatusForTesting(AuthorizationStatus.authorized);
      host.messagingEnabled = false;
      await expectLater(
        () => messaging.getToken(),
        throwsA(
          isA<FirebaseException>().having((e) => e.code, 'code', 'disabled'),
        ),
      );
    });
  });
}
