import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_messaging.dart';

class _LiveMessagingFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps = <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final projectId =
        Platform.environment['PYRIC_LIVE_PROJECT_ID'] ?? 'demo-flutter-live';
    final app = FirebaseAppPlatform(
      appName,
      options ??
          FirebaseOptions(
            apiKey: 'demo-flutter-live-key',
            appId: '1:999999999999:android:messaginglive',
            messagingSenderId: '999999999999',
            projectId: projectId,
          ),
    );
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    final existing = _apps[name];
    if (existing != null) return existing;
    final projectId =
        Platform.environment['PYRIC_LIVE_PROJECT_ID'] ?? 'demo-flutter-live';
    final created = FirebaseAppPlatform(
      name,
      FirebaseOptions(
        apiKey: 'demo-flutter-live-key',
        appId: '1:999999999999:android:messaginglive',
        messagingSenderId: '999999999999',
        projectId: projectId,
      ),
    );
    _apps[name] = created;
    return created;
  }
}

Uri? _resolveLiveBridgeUri() {
  final liveRaw = Platform.environment['PYRIC_LIVE_BRIDGE_URL']?.trim() ?? '';
  if (liveRaw.isNotEmpty) return Uri.parse(liveRaw);
  final fallbackRaw = Platform.environment['PYRIC_BRIDGE_URL']?.trim() ?? '';
  if (fallbackRaw.isNotEmpty) return Uri.parse(fallbackRaw);
  return null;
}

bool _isDedicatedMessagingHost() {
  return Platform.environment['PYRIC_LIVE_MESSAGING_HOST'] == '1';
}

Future<void> _waitForCondition(
  bool Function() predicate, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (predicate()) return;
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  fail('Timed out waiting for live messaging condition.');
}

void main() {
  final liveBridgeUri = _resolveLiveBridgeUri();

  setUpAll(() async {
    FirebasePlatform.instance = _LiveMessagingFirebasePlatform();
    await Firebase.initializeApp();
    await Firebase.initializeApp(name: 'secondary');
  });

  tearDown(() async {
    await FirebaseMessaging.clearInstancesForTest();
  });

  group('Pyric Flutter Cloud Messaging live-host conformance', () {
    test('messaging-live#1: verifies token stability, rotation, topics, visibility routing, and broker send rejections', () async {
      if (liveBridgeUri == null) {
        final offline = FirebaseMessaging.instance;
        final settings = await offline.requestPermission(provisional: true);
        expect(
          settings.authorizationStatus,
          equals(AuthorizationStatus.provisional),
        );
        expect(validateAndNormalizeTopic('/topics/offline_smoke'), 'offline_smoke');
        offline.simulateNotificationOpen(
          const RemoteMessage(messageId: 'offline-init-1'),
          asInitialMessage: true,
        );
        expect(
          (await offline.getInitialMessage())?.messageId,
          equals('offline-init-1'),
        );
        expect(await offline.getInitialMessage(), isNull);
        return;
      }

      final bridge = PyricBridgeClient(uri: liveBridgeUri);
      addTearDown(bridge.disconnect);
      await bridge.connect();
      FirebaseMessaging.registerWith(bridgeClient: bridge);
      final messaging = FirebaseMessaging.instance;

      if (!_isDedicatedMessagingHost()) {
        // Generic `native-flutter-conformance.test.ts` runs with `messaging`
        // omitted on InitPayload; verify the capability gate maps to `disabled`.
        await expectLater(
          () => messaging.getToken(),
          throwsA(
            isA<FirebaseException>()
                .having((e) => e.plugin, 'plugin', 'firebase_messaging')
                .having((e) => e.code, 'code', 'disabled'),
          ),
        );
        return;
      }

      final refreshedTokens = <String>[];
      final foregroundMessages = <RemoteMessage>[];
      final backgroundMessages = <RemoteMessage>[];
      final openedMessages = <RemoteMessage>[];

      final tokenSub = messaging.onTokenRefresh.listen(refreshedTokens.add);
      final fgSub = FirebaseMessaging.onMessage.listen(foregroundMessages.add);
      final openSub =
          FirebaseMessaging.onMessageOpenedApp.listen(openedMessages.add);
      addTearDown(tokenSub.cancel);
      addTearDown(fgSub.cancel);
      addTearDown(openSub.cancel);

      FirebaseMessaging.onBackgroundMessage((message) async {
        backgroundMessages.add(message);
      });

      // 1. Token minting and stability (`messaging-web-token-shape` / `stability`).
      final token1 = await messaging.getToken();
      final token1Again = await messaging.getToken();
      expect(token1, isNotNull);
      expect(token1!.length, equals(142));
      expect(token1, contains(':APA91b'));
      expect(token1Again, equals(token1));
      await _waitForCondition(() => refreshedTokens.length == 1);
      expect(refreshedTokens.single, equals(token1));

      // 2. Visible client routes direct token send + topic/condition sends to `onMessage`.
      await messaging.setVisibility('visible');
      final tokenSend = await messaging.sendBrokerMessage(<String, dynamic>{
        'token': token1,
        'notification': <String, String>{
          'title': 'Live Alert',
          'body': 'Token Route',
          'imageUrl': 'https://cdn.example.test/live.png',
        },
        'data': <String, String>{'kind': 'direct-token', 'seq': '1'},
      });
      expect(tokenSend.messageId, isNotEmpty);
      await _waitForCondition(() => foregroundMessages.length == 1);
      expect(foregroundMessages.first.from, equals('999999999999'));
      expect(foregroundMessages.first.notification?.title, equals('Live Alert'));
      expect(
        foregroundMessages.first.notification?.web?.image,
        equals('https://cdn.example.test/live.png'),
      );
      expect(foregroundMessages.first.data['kind'], equals('direct-token'));
      expect(backgroundMessages, isEmpty);

      // 3. Topic subscribe, condition match, and unsubscribe stop fanout.
      await messaging.subscribeToTopic('breaking_news');
      await messaging.subscribeToTopic('/topics/vip_tier');

      await messaging.sendBrokerMessage(<String, dynamic>{
        'condition': "'breaking_news' in topics && 'vip_tier' in topics",
        'data': <String, String>{'kind': 'condition-hit'},
      });
      await _waitForCondition(() => foregroundMessages.length == 2);
      expect(foregroundMessages[1].data['kind'], equals('condition-hit'));
      expect(foregroundMessages[1].notification, isNull);

      await messaging.unsubscribeFromTopic('breaking_news');
      await messaging.sendBrokerMessage(<String, dynamic>{
        'topic': 'breaking_news',
        'data': <String, String>{'kind': 'after-unsub'},
      });
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(foregroundMessages.length, equals(2));

      // 4. Hidden client routes exclusively to `onBackgroundMessage`.
      await messaging.setVisibility('hidden');
      await messaging.sendBrokerMessage(<String, dynamic>{
        'topic': 'vip_tier',
        'data': <String, String>{'kind': 'background-vip'},
      });
      await _waitForCondition(() => backgroundMessages.length == 1);
      expect(backgroundMessages.single.data['kind'], equals('background-vip'));
      expect(foregroundMessages.length, equals(2));

      // 5. Direct `deliver(...)` driver honors `visibilityState`.
      final delivered = await messaging.deliver(
        visibilityState: 'visible',
        data: const <String, String>{'kind': 'driver-deliver'},
        notification: const <String, String>{
          'title': 'Driver',
          'body': 'Injected',
        },
      );
      expect(delivered.route, equals('foreground'));
      expect(delivered.handlerCount, greaterThanOrEqualTo(1));
      await _waitForCondition(() => foregroundMessages.length == 3);
      expect(foregroundMessages[2].data['kind'], equals('driver-deliver'));

      // 6. `deleteToken()` immediately invalidates sends (`UNREGISTERED` / `NOT_FOUND`)
      //    and subsequent `getToken()` mints a fresh token and fires `onTokenRefresh`.
      await messaging.deleteToken();
      await expectLater(
        () => messaging.sendBrokerMessage(<String, dynamic>{
          'token': token1,
          'data': <String, String>{'kind': 'dead-token'},
        }),
        throwsA(
          isA<FirebaseMessagingSendException>()
              .having((e) => e.plugin, 'plugin', 'firebase_messaging')
              .having((e) => e.code, 'code', 'unregistered')
              .having((e) => e.status, 'status', 'NOT_FOUND'),
        ),
      );

      final token2 = await messaging.getToken();
      expect(token2, isNotNull);
      expect(token2, isNot(equals(token1)));
      await _waitForCondition(() => refreshedTokens.length == 2);
      expect(refreshedTokens[1], equals(token2));

      // 7. Secondary FirebaseApp instance isolates token and recipient routing.
      final secondary = FirebaseMessaging.instanceFor(
        app: Firebase.app('secondary'),
      );
      final secondaryMessages = <RemoteMessage>[];
      final secSub = secondary.onForegroundMessage.listen(secondaryMessages.add);
      addTearDown(secSub.cancel);
      final secondaryToken = await secondary.getToken();
      expect(secondaryToken, isNotNull);
      expect(secondaryToken, isNot(equals(token2)));
      await secondary.setVisibility('visible');
      await secondary.sendBrokerMessage(<String, dynamic>{
        'token': secondaryToken,
        'data': <String, String>{'targetApp': 'secondary'},
      });
      await _waitForCondition(() => secondaryMessages.length == 1);
      expect(secondaryMessages.single.data['targetApp'], equals('secondary'));

      // 8. Notification tap lifecycle (`getInitialMessage` + `onMessageOpenedApp`).
      messaging.simulateNotificationOpen(
        foregroundMessages.first,
        asInitialMessage: true,
      );
      expect(
        (await messaging.getInitialMessage())?.messageId,
        equals(foregroundMessages.first.messageId),
      );
      expect(await messaging.getInitialMessage(), isNull);

      messaging.simulateNotificationOpen(foregroundMessages[1]);
      await _waitForCondition(() => openedMessages.length == 1);
      expect(
        openedMessages.single.messageId,
        equals(foregroundMessages[1].messageId),
      );
    });
  });
}
