import 'dart:async';

import 'package:firebase_app_check_platform_interface/firebase_app_check_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart' show Firebase;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter/foundation.dart'
    show DiagnosticsNode, ErrorDescription, FlutterErrorDetails;
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_crashlytics.dart';

import '../helpers/fake_bridge.dart';

class _TestCrashlyticsFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps =
      <String, FirebaseAppPlatform>{};
  final Map<String, bool> _autoCollection = <String, bool>{};

  void setAppAutoCollection(String name, bool enabled) {
    _autoCollection[name] = enabled;
  }

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final app = _StubFirebaseAppPlatform(
      appName,
      options ??
          const FirebaseOptions(
            apiKey: 'demo-key',
            appId: '1:888888888888:android:crashlyticsunit',
            messagingSenderId: '888888888888',
            projectId: 'demo-crashlytics-unit',
          ),
      () => _autoCollection[appName] ?? true,
    );
    _apps[appName] = app;
    return app;
  }

  @override
  FirebaseAppPlatform app([String name = defaultFirebaseAppName]) {
    final existing = _apps[name];
    if (existing != null) {
      return existing;
    }
    throw FirebaseException(
      plugin: 'core',
      code: 'no-app',
      message: 'No Firebase App $name has been created.',
    );
  }
}

class _StubFirebaseAppPlatform extends FirebaseAppPlatform {
  _StubFirebaseAppPlatform(
    super.name,
    super.options,
    this._readAutoCollection,
  );

  final bool Function() _readAutoCollection;

  @override
  bool get isAutomaticDataCollectionEnabled => _readAutoCollection();
}

class _StubAppCheckPlatform extends FirebaseAppCheckPlatform {
  _StubAppCheckPlatform(this.mintedToken) : super();

  String? mintedToken;

  @override
  Future<String?> getToken([bool forceRefresh = false]) async => mintedToken;
}

class _AppBrokerState {
  bool collectionEnabled = true;
  String? userId;
  final Map<String, dynamic> customKeys = <String, dynamic>{};
  bool didCrashOnPreviousExecution = false;
  final List<Map<String, dynamic>> logs = <Map<String, dynamic>>[];
  final List<Map<String, dynamic>> reports = <Map<String, dynamic>>[];
  final List<Map<String, dynamic>> unsentReports = <Map<String, dynamic>>[];
}

class _InMemoryCrashlyticsWireHost {
  _InMemoryCrashlyticsWireHost() {
    bridge.onFrame = _handleFrame;
  }

  final FakeBridge bridge = FakeBridge();
  final Map<String, _AppBrokerState> _apps = <String, _AppBrokerState>{};
  final List<Map<String, dynamic>> recordedOps = <Map<String, dynamic>>[];
  int _seq = 0;
  String? forcedErrorCode;

  PyricBridgeClient createClient() {
    return PyricBridgeClient(
      uri: Uri.parse('ws://127.0.0.1:5174/__pyric/sandbox'),
      channelFactory: bridge.connect,
    );
  }

  _AppBrokerState _stateFor(Object? rawAppId) {
    final key = (rawAppId is String && rawAppId.trim().isNotEmpty)
        ? rawAppId.trim()
        : 'default';
    return _apps.putIfAbsent(key, _AppBrokerState.new);
  }

  void _handleFrame(Map<String, dynamic> frame) {
    if (frame['type'] != 'worker-op') {
      return;
    }
    final id = frame['id'] as String;
    final op = Map<String, dynamic>.from(frame['op'] as Map);
    recordedOps.add(op);
    if (forcedErrorCode != null) {
      _replyErr(id, forcedErrorCode!, 'Forced host failure');
      return;
    }
    final method = op['method'] as String;
    final state = _stateFor(op['appId']);

    switch (method) {
      case 'crashlytics.setCollectionEnabled':
        final enabled = op['enabled'] as bool?;
        state.collectionEnabled = enabled ?? true;
        _replyOk(id, <String, dynamic>{'enabled': state.collectionEnabled});
      case 'crashlytics.setUserId':
        state.userId = op['userId'] as String;
        _replyOk(id, null);
      case 'crashlytics.setCustomKeys':
        final keys = Map<String, dynamic>.from(op['keys'] as Map);
        for (final entry in keys.entries) {
          if (entry.value == null) {
            state.customKeys.remove(entry.key);
          } else {
            state.customKeys[entry.key] = entry.value;
          }
        }
        _replyOk(id, null);
      case 'crashlytics.log':
        state.logs.add(<String, dynamic>{
          'message': op['message'],
          'timestampMs': op['timestampMs'] ?? 0,
        });
        _replyOk(id, <String, dynamic>{
          'logged': true,
          'logCount': state.logs.length,
        });
      case 'crashlytics.recordError':
        _seq += 1;
        final reportId = 'crash-$_seq';
        final fatal = op['fatal'] == true;
        if (fatal) {
          state.didCrashOnPreviousExecution = true;
        }
        final deferred = !state.collectionEnabled || op['deferred'] == true;
        final report = <String, dynamic>{
          'reportId': reportId,
          'appId': (op['appId'] as String?) ?? 'default',
          'name': op['name'] ?? 'Error',
          'message': op['message'],
          'stack': op['stack'],
          'code': op['code'],
          'cause': op['cause'],
          'fatal': fatal,
          'attributes': op['attributes'] is Map
              ? Map<String, dynamic>.from(op['attributes'] as Map)
              : <String, dynamic>{},
          'customKeys': Map<String, dynamic>.from(state.customKeys),
          'userId': state.userId,
          'breadcrumbs': op['breadcrumbs'] is List
              ? List<dynamic>.from(op['breadcrumbs'] as List)
              : <dynamic>[],
          'timestampMs': op['timestampMs'] ?? 0,
          'appVersion': op['appVersion'],
          'region': op['region'],
          'sdkPlatform': op['sdkPlatform'] ?? 'flutter',
          'flushed': false,
        };
        if (deferred) {
          state.unsentReports.add(report);
        } else {
          state.reports.add(report);
        }
        _replyOk(id, <String, dynamic>{
          'reportId': reportId,
          'queued': true,
          'flushed': false,
        });
      case 'crashlytics.checkForUnsentReports':
        final count = state.unsentReports.length;
        _replyOk(id, <String, dynamic>{
          'hasUnsentReports': count > 0,
          'count': count,
        });
      case 'crashlytics.sendUnsentReports':
        final pending = List<Map<String, dynamic>>.of(state.unsentReports);
        state.unsentReports.clear();
        for (final report in pending) {
          report['flushed'] = true;
          state.reports.add(report);
        }
        _replyOk(id, <String, dynamic>{'sentCount': pending.length});
      case 'crashlytics.deleteUnsentReports':
        final count = state.unsentReports.length;
        state.unsentReports.clear();
        _replyOk(id, <String, dynamic>{'deletedCount': count});
      case 'crashlytics.flush':
        var flushed = 0;
        for (final report in state.reports) {
          if (report['flushed'] != true) {
            report['flushed'] = true;
            flushed += 1;
          }
        }
        _replyOk(id, <String, dynamic>{'flushedCount': flushed});
      case 'crashlytics.getState':
        _replyOk(id, <String, dynamic>{
          'collectionEnabled': state.collectionEnabled,
          'userId': state.userId,
          'customKeys': Map<String, dynamic>.from(state.customKeys),
          'appVersion': null,
          'region': null,
          'didCrashOnPreviousExecution': state.didCrashOnPreviousExecution,
          'logs': List<Map<String, dynamic>>.of(state.logs),
          'reports': List<Map<String, dynamic>>.of(state.reports),
          'unsentReports': List<Map<String, dynamic>>.of(state.unsentReports),
        });
      default:
        _replyErr(id, 'unknown-op', 'Unsupported op: $method');
    }
  }

  void _replyOk(String id, Object? value) {
    scheduleMicrotask(() {
      bridge.current.deliver(<String, dynamic>{
        'type': 'worker-res',
        'id': id,
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
        'ok': false,
        'error': <String, dynamic>{'code': code, 'message': message},
      });
    });
  }
}

void main() {
  late _TestCrashlyticsFirebasePlatform platform;

  setUp(() async {
    platform = _TestCrashlyticsFirebasePlatform();
    FirebasePlatform.instance = platform;
    await Firebase.initializeApp();
    await Firebase.initializeApp(name: 'secondary');
  });

  tearDown(() async {
    await FirebaseCrashlytics.clearInstancesForTest();
  });

  group('FirebaseCrashlytics offline & codec behavior', () {
    test('supports full offline workflow without an active WebSocket host', () async {
      final crashlytics = FirebaseCrashlytics.instance;
      expect(crashlytics.isCrashlyticsCollectionEnabled, isTrue);
      expect(crashlytics.pluginConstants['isCrashlyticsCollectionEnabled'], isTrue);
      expect(await crashlytics.didCrashOnPreviousExecution(), isFalse);

      await crashlytics.setUserIdentifier('offline-user-42');
      await crashlytics.setCustomKey('tier', 'pro');
      await crashlytics.setCustomKey('retries', 3);
      await crashlytics.setCustomKey('ratio', 0.75);
      await crashlytics.setCustomKey('beta', true);
      await crashlytics.log('opened settings screen');

      await crashlytics.recordError(
        StateError('offline non-fatal failure'),
        StackTrace.current,
        reason: ErrorDescription('while saving preferences'),
        information: const <Object>['prefKey=theme', 'attempt=1'],
        fatal: false,
      );
      await crashlytics.flush();

      final state = await crashlytics.fetchAppState();
      expect(state.userId, equals('offline-user-42'));
      expect(state.customKeys['tier'], equals('pro'));
      expect(state.customKeys['retries'], equals(3));
      expect(state.customKeys['ratio'], equals(0.75));
      expect(state.customKeys['beta'], isTrue);
      expect(state.reports, hasLength(1));
      expect(state.reports.single.flushed, isTrue);
      expect(state.reports.single.sdkPlatform, equals('flutter'));
      expect(
        state.reports.single.attributes['reason'],
        equals('while saving preferences'),
      );
      expect(
        state.reports.single.attributes['information'],
        equals('prefKey=theme\nattempt=1'),
      );
      expect(
        state.reports.single.breadcrumbs.single.message,
        equals('opened settings screen'),
      );
    });

    test('normalizes non-finite doubles and rejects empty keys or invalid types', () async {
      final crashlytics = FirebaseCrashlytics.instance;
      await crashlytics.setCustomKey('nanVal', double.nan);
      await crashlytics.setCustomKey('infVal', double.infinity);
      final state = await crashlytics.fetchAppState();
      expect(state.customKeys['nanVal'], equals('NaN'));
      expect(state.customKeys['infVal'], equals('Infinity'));

      await expectLater(
        () => crashlytics.setCustomKey('   ', 'bad'),
        throwsArgumentError,
      );
      await expectLater(
        () => crashlytics.setCustomKey('badObj', <String>['not-scalar']),
        throwsArgumentError,
      );
      await expectLater(
        () => crashlytics.useCrashlyticsEmulator('', 0),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_crashlytics')
              .having((e) => e.code, 'code', 'invalid-argument'),
        ),
      );
    });

    test('caps rolling breadcrumbs at 64 FIFO entries', () async {
      var tick = 1000;
      final crashlytics = FirebaseCrashlytics.instanceFor(
        clockMillis: () => tick++,
      );
      for (var i = 0; i < 70; i++) {
        await crashlytics.log('crumb-$i');
      }
      await crashlytics.recordError(Exception('after rollover'), null);
      final state = await crashlytics.fetchAppState();
      final crumbs = state.reports.single.breadcrumbs;
      expect(crumbs, hasLength(64));
      expect(crumbs.first.message, equals('crumb-6'));
      expect(crumbs.last.message, equals('crumb-69'));
    });
  });

  group('FirebaseCrashlytics mock WebSocket bridge wire contract', () {
    test('routes all 10 crashlytics.* ops, App Check tokens, and per-app isolation', () async {
      final wireHost = _InMemoryCrashlyticsWireHost();
      final client = wireHost.createClient();
      addTearDown(client.disconnect);
      await client.connect();

      final appCheck = _StubAppCheckPlatform('stub-app-check-jwt-1');
      FirebaseCrashlytics.registerWith(
        bridgeClient: client,
        appCheck: appCheck,
      );

      final defaultCrashlytics = FirebaseCrashlytics.instance;
      final secondaryApp = Firebase.app('secondary');
      final secondaryCrashlytics = FirebaseCrashlytics.instanceFor(
        app: secondaryApp,
      );
      expect(identical(FirebaseCrashlytics.instance, defaultCrashlytics), isTrue);
      expect(
        identical(
          FirebaseCrashlytics.instanceFor(app: secondaryApp),
          secondaryCrashlytics,
        ),
        isTrue,
      );
      expect(defaultCrashlytics.wireAppId, isNull);
      expect(secondaryCrashlytics.wireAppId, equals('secondary'));

      await defaultCrashlytics.setUserIdentifier('uid-default');
      await secondaryCrashlytics.setUserIdentifier('uid-secondary');

      await defaultCrashlytics.setCustomKeysAndValues(<String, Object?>{
        'screen': 'checkout',
        'cartSize': 2,
        'tempFlag': true,
      });
      await defaultCrashlytics.setCustomKeysAndValues(<String, Object?>{
        'tempFlag': null,
      });

      await defaultCrashlytics.log('tapped pay');
      await defaultCrashlytics.recordError(
        FirebaseException(
          plugin: 'cloud_firestore',
          code: 'permission-denied',
          message: 'Missing or insufficient permissions.',
        ),
        StackTrace.current,
        reason: 'payment_write_denied',
        fatal: false,
      );

      await defaultCrashlytics.recordFlutterError(
        FlutterErrorDetails(
          exception: const FormatException('Bad currency symbol'),
          stack: StackTrace.current,
          library: 'widgets library',
          context: ErrorDescription('building CheckoutSummary'),
          informationCollector: () => <DiagnosticsNode>[
            ErrorDescription('locale=en_US'),
          ],
        ),
      );

      await defaultCrashlytics.setCrashlyticsCollectionEnabled(false);
      expect(defaultCrashlytics.isCrashlyticsCollectionEnabled, isFalse);

      await defaultCrashlytics.recordFlutterFatalError(
        FlutterErrorDetails(
          exception: StateError('Deferred fatal framework crash'),
          stack: StackTrace.current,
          context: ErrorDescription('during layout'),
        ),
      );

      expect(await defaultCrashlytics.checkForUnsentReports(), isTrue);
      await defaultCrashlytics.deleteUnsentReports();
      expect(await defaultCrashlytics.checkForUnsentReports(), isFalse);

      expect(
        () => defaultCrashlytics.crash(),
        throwsA(
          isA<CrashlyticsSimulatedCrashError>().having(
            (e) => e,
            'is StateError',
            isA<StateError>(),
          ),
        ),
      );
      expect(await defaultCrashlytics.checkForUnsentReports(), isTrue);
      await defaultCrashlytics.sendUnsentReports();
      expect(await defaultCrashlytics.checkForUnsentReports(), isFalse);
      expect(await defaultCrashlytics.didCrashOnPreviousExecution(), isTrue);

      await defaultCrashlytics.setCrashlyticsCollectionEnabled(null);
      expect(defaultCrashlytics.isCrashlyticsCollectionEnabled, isTrue);
      await defaultCrashlytics.flush();

      final defaultState = await defaultCrashlytics.fetchAppState();
      final secondaryState = await secondaryCrashlytics.fetchAppState();

      expect(defaultState.userId, equals('uid-default'));
      expect(defaultState.customKeys, equals(<String, Object>{
        'screen': 'checkout',
        'cartSize': 2,
      }));
      expect(defaultState.reports, hasLength(3));
      expect(defaultState.reports[0].code, equals('cloud_firestore/permission-denied'));
      expect(defaultState.reports[0].flushed, isTrue);
      expect(defaultState.reports[1].attributes['reason'], equals('building CheckoutSummary'));
      expect(defaultState.reports[1].attributes['information'], equals('locale=en_US'));
      expect(defaultState.reports[2].fatal, isTrue);
      expect(defaultState.unsentReports, isEmpty);

      expect(secondaryState.userId, equals('uid-secondary'));
      expect(secondaryState.reports, isEmpty);

      final seenMethods = wireHost.recordedOps.map((op) => op['method']).toSet();
      expect(
        seenMethods,
        containsAll(<String>[
          'crashlytics.setUserId',
          'crashlytics.setCustomKeys',
          'crashlytics.log',
          'crashlytics.recordError',
          'crashlytics.setCollectionEnabled',
          'crashlytics.checkForUnsentReports',
          'crashlytics.sendUnsentReports',
          'crashlytics.deleteUnsentReports',
          'crashlytics.flush',
          'crashlytics.getState',
        ]),
      );
      for (final op in wireHost.recordedOps) {
        expect(op['appCheckToken'], equals('stub-app-check-jwt-1'));
      }
    });

    test('maps bridge errors into FirebaseException under firebase_crashlytics', () async {
      final wireHost = _InMemoryCrashlyticsWireHost()
        ..forcedErrorCode = 'crashlytics/live-refused';
      final client = wireHost.createClient();
      addTearDown(client.disconnect);
      await client.connect();

      final crashlytics = FirebaseCrashlytics.instanceFor(bridgeClient: client);
      await expectLater(
        () => crashlytics.log('blocked in live mode'),
        throwsA(
          isA<FirebaseException>()
              .having((e) => e.plugin, 'plugin', 'firebase_crashlytics')
              .having((e) => e.code, 'code', 'live-refused'),
        ),
      );
    });
  });
}
