import 'dart:io';

import 'package:firebase_core/firebase_core.dart' show Firebase;
import 'package:firebase_core_platform_interface/firebase_core_platform_interface.dart';
import 'package:flutter/foundation.dart'
    show DiagnosticsNode, ErrorDescription, FlutterErrorDetails;
import 'package:flutter_test/flutter_test.dart';
import 'package:pyric_firestore/pyric_app_check.dart';
import 'package:pyric_firestore/pyric_crashlytics.dart';

class _LiveCrashlyticsFirebasePlatform extends FirebasePlatform {
  final Map<String, FirebaseAppPlatform> _apps =
      <String, FirebaseAppPlatform>{};

  @override
  List<FirebaseAppPlatform> get apps => _apps.values.toList();

  @override
  Future<FirebaseAppPlatform> initializeApp({
    String? name,
    FirebaseOptions? options,
  }) async {
    final appName = name ?? defaultFirebaseAppName;
    final projectId = Platform.environment['PYRIC_LIVE_PROJECT_ID']?.trim() ??
        'demo-flutter-crashlytics-live';
    final app = FirebaseAppPlatform(
      appName,
      options ??
          FirebaseOptions(
            apiKey: 'demo-flutter-crashlytics-key',
            appId: '1:777777777777:android:fluttercrashlytics',
            messagingSenderId: '777777777777',
            projectId: projectId,
          ),
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
    final projectId = Platform.environment['PYRIC_LIVE_PROJECT_ID']?.trim() ??
        'demo-flutter-crashlytics-live';
    final created = FirebaseAppPlatform(
      name,
      FirebaseOptions(
        apiKey: 'demo-flutter-crashlytics-key',
        appId: '1:777777777777:android:fluttercrashlytics',
        messagingSenderId: '777777777777',
        projectId: projectId,
      ),
    );
    _apps[name] = created;
    return created;
  }
}

Uri? _resolveLiveCrashlyticsBridgeUri() {
  final raw =
      Platform.environment['PYRIC_LIVE_CRASHLYTICS_BRIDGE_URL']?.trim() ?? '';
  if (raw.isEmpty) {
    return null;
  }
  return Uri.parse(raw);
}

void main() {
  HttpOverrides? previousHttpOverrides;

  setUp(() async {
    previousHttpOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    FirebasePlatform.instance = _LiveCrashlyticsFirebasePlatform();
    await Firebase.initializeApp();
    await Firebase.initializeApp(
      name: 'secondary',
      options: const FirebaseOptions(
        apiKey: 'demo-flutter-crashlytics-key',
        appId: '1:777777777777:ios:fluttercrashlyticssecondary',
        messagingSenderId: '777777777777',
        projectId: 'demo-flutter-crashlytics-live',
      ),
    );
  });

  tearDown(() async {
    await FirebaseCrashlytics.clearInstancesForTest();
    await PyricFirebaseAppCheckPlatform.clearInstancesForTest();
    HttpOverrides.global = previousHttpOverrides;
  });

  group('Pyric Flutter Crashlytics live-host conformance', () {
    test(
      'crashlytics-live#1: exercises all 10 crashlytics.* ops, App Check tokens, deferred queue, and multi-app isolation',
      () async {
        final liveUri = _resolveLiveCrashlyticsBridgeUri();
        if (liveUri == null) {
          if (Platform.environment['PYRIC_REQUIRE_CRASHLYTICS_LIVE'] == '1') {
            fail(
              'PYRIC_REQUIRE_CRASHLYTICS_LIVE=1 was set without PYRIC_LIVE_CRASHLYTICS_BRIDGE_URL.',
            );
          }
          final offline = FirebaseCrashlytics.instance;
          await offline.log('offline live-host fallback check');
          await offline.recordError(
            StateError('offline verification'),
            StackTrace.current,
          );
          final state = await offline.fetchAppState();
          expect(state.reports, hasLength(1));
          return;
        }

        final bridge = PyricBridgeClient(
          uri: liveUri,
          headers: <String, dynamic>{'Host': '${liveUri.host}:${liveUri.port}'},
        );
        addTearDown(bridge.disconnect);
        await bridge.connect();

        PyricFirebaseAppCheckPlatform.registerWith(bridgeClient: bridge);
        final appCheck = FirebaseAppCheckPlatform.instanceFor(
          app: Firebase.app(),
        );
        await appCheck.activate(providerAndroid: const AndroidDebugProvider());
        final mintedJwt = await appCheck.getToken(false);
        expect(mintedJwt, isNotNull);
        expect(mintedJwt!.split('.'), hasLength(3));

        final secondaryAppCheck = FirebaseAppCheckPlatform.instanceFor(
          app: Firebase.app('secondary'),
        );
        await secondaryAppCheck.activate(
          providerApple: const AppleDebugProvider(),
        );

        FirebaseCrashlytics.registerWith(bridgeClient: bridge);
        final primary = FirebaseCrashlytics.instance;
        final secondary = FirebaseCrashlytics.instanceFor(
          app: Firebase.app('secondary'),
        );

        // 1. User ID, custom keys, key deletion, and breadcrumbs.
        await primary.setUserIdentifier('flutter-live-user-1');
        await secondary.setUserIdentifier('flutter-secondary-user');

        await primary.setCustomKey('env', 'live-host');
        await primary.setCustomKey('buildNumber', 42);
        await primary.setCustomKey('sampleRate', 0.5);
        await primary.setCustomKey('darkTheme', true);
        await primary.setCustomKey('obsoleteKey', 'remove-me');
        await primary.setCustomKeysAndValues(<String, Object?>{
          'obsoleteKey': null,
        });

        await primary.log('step-1: opened home');
        await primary.log('step-2: tapped checkout');

        // 2. Non-fatal recordError and recordFlutterError while collection is enabled.
        await primary.recordError(
          FirebaseException(
            plugin: 'firebase_storage',
            code: 'unauthorized',
            message: 'User is not authorized to upload.',
          ),
          StackTrace.current,
          reason: 'avatar_upload_failed',
          information: const <Object>['bucket=avatars', 'uid=flutter-live-user-1'],
          fatal: false,
        );

        await primary.recordFlutterError(
          FlutterErrorDetails(
            exception: ArgumentError('Invalid price total: -1'),
            stack: StackTrace.current,
            library: 'widgets library',
            context: ErrorDescription('building OrderTotalCard'),
            informationCollector: () => <DiagnosticsNode>[
              ErrorDescription('currency=USD'),
            ],
          ),
        );

        await secondary.recordError(
          Exception('secondary isolated failure'),
          StackTrace.current,
          reason: 'secondary_probe',
        );

        // 3. Disabled collection -> deferred unsent queue -> deleteUnsentReports -> sendUnsentReports.
        expect(await primary.checkForUnsentReports(), isFalse);
        await primary.setCrashlyticsCollectionEnabled(false);
        expect(primary.isCrashlyticsCollectionEnabled, isFalse);

        await primary.recordError(
          StateError('discarded while disabled'),
          StackTrace.current,
          reason: 'to_be_deleted',
        );
        expect(await primary.checkForUnsentReports(), isTrue);
        await primary.deleteUnsentReports();
        expect(await primary.checkForUnsentReports(), isFalse);

        await primary.recordFlutterFatalError(
          FlutterErrorDetails(
            exception: StateError('deferred fatal widget crash'),
            stack: StackTrace.current,
            context: ErrorDescription('during frame paint'),
          ),
        );
        expect(await primary.checkForUnsentReports(), isTrue);
        await primary.sendUnsentReports();
        expect(await primary.checkForUnsentReports(), isFalse);

        // 4. Re-enable default collection via null override, test guarded crash(), and flush().
        await primary.setCrashlyticsCollectionEnabled(null);
        expect(primary.isCrashlyticsCollectionEnabled, isTrue);

        expect(() => primary.crash(), throwsStateError);
        await primary.flush();

        expect(await primary.didCrashOnPreviousExecution(), isTrue);
        expect(await secondary.didCrashOnPreviousExecution(), isFalse);

        // 5. Inspect authoritative broker state for both apps.
        final primaryState = await primary.fetchAppState();
        final secondaryState = await secondary.fetchAppState();

        expect(primaryState.collectionEnabled, isTrue);
        expect(primaryState.userId, equals('flutter-live-user-1'));
        expect(primaryState.didCrashOnPreviousExecution, isTrue);
        expect(primaryState.customKeys, equals(<String, Object>{
          'env': 'live-host',
          'buildNumber': 42,
          'sampleRate': 0.5,
          'darkTheme': true,
        }));
        expect(primaryState.logs.map((l) => l.message).toList(), equals(<String>[
          'step-1: opened home',
          'step-2: tapped checkout',
        ]));
        expect(primaryState.unsentReports, isEmpty);
        expect(primaryState.reports, hasLength(4));
        for (final report in primaryState.reports) {
          expect(report.sdkPlatform, equals('flutter'));
          expect(report.flushed, isTrue);
          expect(report.stack, isNotNull);
          expect(report.stack, isNotEmpty);
        }
        expect(
          primaryState.reports[0].code,
          equals('firebase_storage/unauthorized'),
        );
        expect(
          primaryState.reports[0].breadcrumbs.map((b) => b.message).toList(),
          equals(<String>['step-1: opened home', 'step-2: tapped checkout']),
        );
        expect(
          primaryState.reports[1].attributes['reason'],
          equals('building OrderTotalCard'),
        );
        expect(primaryState.reports[2].fatal, isTrue);
        expect(primaryState.reports[3].fatal, isTrue);

        expect(secondaryState.userId, equals('flutter-secondary-user'));
        expect(secondaryState.didCrashOnPreviousExecution, isFalse);
        expect(secondaryState.reports, hasLength(1));
        expect(
          secondaryState.reports.single.appId,
          equals('secondary'),
        );

        stdout.writeln('PYRIC_FLUTTER_CRASHLYTICS_LIVE_VERIFIED=1');
      },
    );
  });
}
