import 'dart:async';

import 'package:firebase_app_check_platform_interface/firebase_app_check_platform_interface.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart'
    show DiagnosticLevel, FlutterErrorDetails, debugPrint;

import '../transport/bridge_client.dart';
import 'crashlytics_bridge_session.dart';
import 'crashlytics_local_store.dart';
import 'crashlytics_types.dart';
import 'crashlytics_wire_codec.dart';

/// Alias matching Pyric's Flutter package naming convention.
typedef PyricFirebaseCrashlytics = FirebaseCrashlytics;

/// Short alias for [FirebaseCrashlytics].
typedef PyricCrashlytics = FirebaseCrashlytics;

/// Pure-Dart Firebase Crashlytics client backed by Pyric's WebSocket bridge.
///
/// Mirrors FlutterFire's `firebase_crashlytics` public API (`instance`,
/// `instanceFor`, `isCrashlyticsCollectionEnabled`,
/// `setCrashlyticsCollectionEnabled`, `recordError`, `recordFlutterError`,
/// `recordFlutterFatalError`, `log`, `setUserIdentifier`, `setCustomKey`,
/// `checkForUnsentReports`, `sendUnsentReports`, `deleteUnsentReports`,
/// `didCrashOnPreviousExecution`, `crash`, and `flush`) while routing all 10
/// `crashlytics.*` operations onto the shared sandbox `CrashlyticsBroker`.
class FirebaseCrashlytics {
  FirebaseCrashlytics._({
    required FirebaseApp? app,
    required CrashlyticsBridgeSession session,
    required int Function() clockMillis,
  })  : _boundApp = app,
        _session = session,
        _clockMillis = clockMillis {
    _liveInstances.add(this);
  }

  static FirebaseCrashlytics? _defaultInstance;
  static final Map<String, FirebaseCrashlytics> _instancesByKey =
      <String, FirebaseCrashlytics>{};
  static final Set<FirebaseCrashlytics> _liveInstances =
      <FirebaseCrashlytics>{};

  static PyricBridgeClient? _registeredBridgeClient;
  static FirebaseAppCheckPlatform? _registeredAppCheck;

  /// Default [FirebaseCrashlytics] singleton for the default [FirebaseApp].
  static FirebaseCrashlytics get instance {
    final existing = _defaultInstance;
    if (existing != null && !existing._session.isDisposed) {
      return existing;
    }
    final created = _createInstance(
      app: _tryDefaultApp(),
      bridgeClient: null,
      appCheck: null,
      clockMillis: null,
    );
    _defaultInstance = created;
    return created;
  }

  /// Returns a [FirebaseCrashlytics] instance scoped to [app] (and optional bridge overrides).
  static FirebaseCrashlytics instanceFor({
    FirebaseApp? app,
    PyricBridgeClient? bridgeClient,
    FirebaseAppCheckPlatform? appCheck,
    int Function()? clockMillis,
  }) {
    final resolvedApp = app ?? _tryDefaultApp();
    final appName = resolvedApp?.name ?? defaultFirebaseAppName;
    final hasCustomOverrides =
        bridgeClient != null || appCheck != null || clockMillis != null;

    if (!hasCustomOverrides && appName == defaultFirebaseAppName) {
      return instance;
    }

    if (!hasCustomOverrides) {
      final cached = _instancesByKey[appName];
      if (cached != null && !cached._session.isDisposed) {
        return cached;
      }
    }

    final created = _createInstance(
      app: resolvedApp,
      bridgeClient: bridgeClient,
      appCheck: appCheck,
      clockMillis: clockMillis,
    );
    if (!hasCustomOverrides) {
      _instancesByKey[appName] = created;
    }
    return created;
  }

  /// Registers shared bridge and App Check defaults used by subsequent [instance]
  /// and [instanceFor] calls.
  static void registerWith({
    PyricBridgeClient? bridgeClient,
    FirebaseAppCheckPlatform? appCheck,
  }) {
    _registeredBridgeClient = bridgeClient;
    _registeredAppCheck = appCheck;
    _defaultInstance = null;
    _instancesByKey.clear();
  }

  /// Disposes all cached instances, clears registered defaults, and resets test state.
  static Future<void> clearInstancesForTest() async {
    final toDispose = _liveInstances.toList(growable: false);
    _liveInstances.clear();
    _defaultInstance = null;
    _instancesByKey.clear();
    _registeredBridgeClient = null;
    _registeredAppCheck = null;
    for (final inst in toDispose) {
      await inst.dispose();
    }
  }

  static FirebaseCrashlytics _createInstance({
    required FirebaseApp? app,
    required PyricBridgeClient? bridgeClient,
    required FirebaseAppCheckPlatform? appCheck,
    required int Function()? clockMillis,
  }) {
    final session = CrashlyticsBridgeSession.resolve(
      app: app,
      explicitBridge: bridgeClient,
      registeredBridge: _registeredBridgeClient,
      explicitAppCheck: appCheck,
      registeredAppCheck: _registeredAppCheck,
    );
    return FirebaseCrashlytics._(
      app: app,
      session: session,
      clockMillis: clockMillis ?? (() => DateTime.now().millisecondsSinceEpoch),
    );
  }

  static FirebaseApp? _tryDefaultApp() {
    try {
      return Firebase.app();
    } catch (_) {
      return null;
    }
  }

  final FirebaseApp? _boundApp;
  final CrashlyticsBridgeSession _session;
  final int Function() _clockMillis;
  final LocalCrashlyticsStore _local = LocalCrashlyticsStore();
  final Set<Future<void>> _inFlightOps = <Future<void>>{};

  /// Associated [FirebaseApp], if initialized.
  FirebaseApp? get app => _boundApp ?? _tryDefaultApp();

  /// Wire `appId` (`null` for `[DEFAULT]`, `app.name` for named apps).
  String? get wireAppId {
    final name = app?.name;
    if (name == null || name.isEmpty || name == defaultFirebaseAppName) {
      return null;
    }
    return name;
  }

  /// Underlying [PyricBridgeClient] used by this Crashlytics instance.
  PyricBridgeClient get bridgeClient => _session.bridgeClient;

  /// Whether Crashlytics report collection is currently enabled for this app.
  bool get isCrashlyticsCollectionEnabled {
    final override = _local.collectionOverride;
    if (override != null) {
      return override;
    }
    try {
      return app?.isAutomaticDataCollectionEnabled ?? true;
    } on UnimplementedError {
      return true;
    }
  }

  /// Plugin constants map matching FlutterFire platform interface conventions.
  Map<dynamic, dynamic> get pluginConstants => <dynamic, dynamic>{
        'isCrashlyticsCollectionEnabled': isCrashlyticsCollectionEnabled,
      };

  /// Connects this [FirebaseCrashlytics] instance to `ws://<host>:<port>/__pyric/sandbox`.
  Future<void> useCrashlyticsEmulator(String host, int port) {
    return _session.useEmulator(host, port);
  }

  /// Alias for [useCrashlyticsEmulator].
  Future<void> useEmulator(String host, int port) {
    return _session.useEmulator(host, port);
  }

  /// Enables or disables automatic Crashlytics collection (pass `null` to reset
  /// back to [FirebaseApp.isAutomaticDataCollectionEnabled]).
  Future<void> setCrashlyticsCollectionEnabled(bool? enabled) async {
    _local.collectionOverride = enabled;
    if (_session.hasLiveBridge) {
      await _session.runOp(
        'crashlytics.setCollectionEnabled',
        <String, dynamic>{
          ..._baseParams(),
          'enabled': enabled,
        },
      );
    }
  }

  /// Associates [identifier] with subsequent fatal and non-fatal reports.
  Future<void> setUserIdentifier(String identifier) async {
    final truncated = truncateCrashlyticsString(identifier);
    _local.userId = truncated;
    if (_session.hasLiveBridge) {
      await _session.runOp('crashlytics.setUserId', <String, dynamic>{
        ..._baseParams(),
        'userId': truncated,
      });
    }
  }

  /// Associates a custom [key] and scalar [value] (`bool`, `int`, `num`, `String`)
  /// with subsequent fatal and non-fatal reports.
  Future<void> setCustomKey(String key, Object value) async {
    final normalized = normalizeCrashlyticsCustomEntry(key, value);
    _local.putCustomKey(normalized.key, normalized.value);
    if (_session.hasLiveBridge) {
      await _session.runOp('crashlytics.setCustomKeys', <String, dynamic>{
        ..._baseParams(),
        'keys': <String, dynamic>{normalized.key: normalized.value},
      });
    }
  }

  /// Batch-updates custom keys; passing `null` for a key removes it on the broker.
  Future<void> setCustomKeysAndValues(
    Map<String, Object?> keysAndValues,
  ) async {
    if (keysAndValues.isEmpty) {
      return;
    }
    final normalized = normalizeCrashlyticsCustomKeyBatch(keysAndValues);
    _local.applyCustomKeyBatch(normalized);
    if (_session.hasLiveBridge) {
      await _session.runOp('crashlytics.setCustomKeys', <String, dynamic>{
        ..._baseParams(),
        'keys': Map<String, dynamic>.from(normalized),
      });
    }
  }

  /// Logs a breadcrumb [message] attached to subsequent fatal and non-fatal reports.
  Future<void> log(String message) async {
    final ts = _clockMillis();
    _local.addLog(message, ts);
    if (_session.hasLiveBridge) {
      await _session.runOp('crashlytics.log', <String, dynamic>{
        ..._baseParams(),
        'message': message,
        'timestampMs': ts,
      });
    }
  }

  /// Submits a fatal or non-fatal Crashlytics report for [exception] and [stack].
  Future<void> recordError(
    dynamic exception,
    StackTrace? stack, {
    dynamic reason,
    Iterable<Object> information = const <Object>[],
    bool? printDetails,
    bool fatal = false,
  }) async {
    final infoText = information.isEmpty ? '' : information.join('\n');
    final reasonText = reason?.toString().trim();

    if (printDetails == true) {
      debugPrint('----------------FIREBASE CRASHLYTICS----------------');
      if (reasonText != null && reasonText.isNotEmpty) {
        debugPrint('The following exception was thrown $reasonText:');
      }
      debugPrint('$exception');
      if (infoText.isNotEmpty) {
        debugPrint(infoText);
      }
      if (stack != null) {
        debugPrint('$stack');
      }
      debugPrint('----------------------------------------------------');
    }

    final meta = extractDartExceptionMetadata(exception);
    final formattedStack = formatDartStackTrace(stack);
    final ts = _clockMillis();
    final enabledNow = isCrashlyticsCollectionEnabled;

    final attributes = <String, Object?>{
      ..._local.customKeys,
      if (reasonText != null && reasonText.isNotEmpty) 'reason': reasonText,
      if (infoText.isNotEmpty) 'information': infoText,
    };
    final crumbsSnapshot =
        List<CrashlyticsBreadcrumb>.unmodifiable(_local.breadcrumbs);

    if (fatal) {
      _local.didCrashOnPreviousExecution = true;
    }

    _local.recordReport(
      appId: wireAppId ?? 'default',
      name: meta.name,
      message: meta.message,
      stack: formattedStack,
      code: meta.code,
      cause: meta.cause,
      fatal: fatal,
      attributes: attributes,
      breadcrumbsSnapshot: crumbsSnapshot,
      timestampMs: ts,
      deferred: !enabledNow,
    );

    if (_session.hasLiveBridge) {
      await _session.runOp('crashlytics.recordError', <String, dynamic>{
        ..._baseParams(),
        'name': meta.name,
        'message': meta.message,
        'stack': formattedStack,
        if (meta.code != null) 'code': meta.code,
        if (meta.cause != null) 'cause': meta.cause,
        'fatal': fatal,
        if (attributes.isNotEmpty) 'attributes': attributes,
        if (crumbsSnapshot.isNotEmpty)
          'breadcrumbs': crumbsSnapshot
              .map((crumb) => crumb.toWireMap())
              .toList(growable: false),
        'timestampMs': ts,
        'sdkPlatform': crashlyticsSdkPlatformFlutter,
        'deferred': !enabledNow,
      });
    }
  }

  /// Submits a Crashlytics report for an error caught by the Flutter framework.
  Future<void> recordFlutterError(
    FlutterErrorDetails flutterErrorDetails, {
    bool fatal = false,
  }) {
    final contextReason = flutterErrorDetails.context
        ?.toStringDeep(minLevel: DiagnosticLevel.info)
        .trim();
    final effectiveReason =
        (contextReason != null && contextReason.isNotEmpty)
            ? contextReason
            : flutterErrorDetails.library;
    final collected = flutterErrorDetails.informationCollector?.call();
    final information = <Object>[
      if (collected != null)
        for (final Object? node in collected)
          if (node != null) node,
    ];

    return recordError(
      flutterErrorDetails.exceptionAsString(),
      flutterErrorDetails.stack,
      reason: effectiveReason,
      information: information,
      printDetails: false,
      fatal: fatal,
    );
  }

  /// Submits a fatal Crashlytics report for an error caught by the Flutter framework.
  Future<void> recordFlutterFatalError(
    FlutterErrorDetails flutterErrorDetails,
  ) {
    return recordFlutterError(flutterErrorDetails, fatal: true);
  }

  /// Checks whether any deferred reports are queued in `unsentReports`.
  Future<bool> checkForUnsentReports() async {
    await _drainInFlightOps();
    if (_session.hasLiveBridge) {
      final raw = await _session.runOp(
        'crashlytics.checkForUnsentReports',
        _baseParams(),
      );
      if (raw is Map) {
        final flag = raw['hasUnsentReports'];
        if (flag is bool) {
          return flag;
        }
        final count = (raw['count'] as num?)?.toInt() ?? 0;
        return count > 0;
      }
      return false;
    }
    return _local.unsentReports.isNotEmpty;
  }

  /// Promotes all queued `unsentReports` into flushed `reports`.
  Future<void> sendUnsentReports() async {
    await _drainInFlightOps();
    _local.promoteUnsentReports();
    if (_session.hasLiveBridge) {
      await _session.runOp('crashlytics.sendUnsentReports', _baseParams());
    }
  }

  /// Discards all queued `unsentReports` without uploading them.
  Future<void> deleteUnsentReports() async {
    await _drainInFlightOps();
    _local.unsentReports.clear();
    if (_session.hasLiveBridge) {
      await _session.runOp('crashlytics.deleteUnsentReports', _baseParams());
    }
  }

  /// Returns whether a fatal crash occurred during a previous execution (or simulated crash).
  Future<bool> didCrashOnPreviousExecution() async {
    await _drainInFlightOps();
    if (_session.hasLiveBridge) {
      final raw = await _session.runOp('crashlytics.getState', _baseParams());
      if (raw is Map && raw['didCrashOnPreviousExecution'] == true) {
        _local.didCrashOnPreviousExecution = true;
      }
    }
    return _local.didCrashOnPreviousExecution;
  }

  /// Test helper overriding the local previous-execution crash flag.
  void simulatePreviousCrashForTest([bool didCrash = true]) {
    _local.didCrashOnPreviousExecution = didCrash;
  }

  /// Guarded test-friendly crash simulation: records a fatal Crashlytics report
  /// and throws [CrashlyticsSimulatedCrashError] (`StateError`) rather than
  /// aborting the Dart VM process.
  Never crash() {
    _local.didCrashOnPreviousExecution = true;
    final error = CrashlyticsSimulatedCrashError();
    final stack = StackTrace.current;
    final pending = recordError(
      error,
      stack,
      reason: 'FirebaseCrashlytics.crash()',
      printDetails: false,
      fatal: true,
    ).catchError((Object _) {});
    _trackInFlight(pending);
    throw error;
  }

  /// Marks all recorded reports for this app as flushed on the sandbox broker.
  Future<void> flush() async {
    await _drainInFlightOps();
    _local.markReportsFlushed();
    if (_session.hasLiveBridge) {
      await _session.runOp('crashlytics.flush', _baseParams());
    }
  }

  /// Reads the raw broker state map (`crashlytics.getState`) for this app.
  Future<Map<String, dynamic>> getState() async {
    await _drainInFlightOps();
    if (_session.hasLiveBridge) {
      final raw = await _session.runOp('crashlytics.getState', _baseParams());
      if (raw is Map) {
        final normalized = Map<String, dynamic>.from(raw);
        if (normalized['didCrashOnPreviousExecution'] == true) {
          _local.didCrashOnPreviousExecution = true;
        }
        return normalized;
      }
    }
    return _local
        .snapshot(collectionEnabled: isCrashlyticsCollectionEnabled)
        .toWireMap();
  }

  /// Reads a strongly typed [CrashlyticsAppState] snapshot for this app.
  Future<CrashlyticsAppState> fetchAppState() async {
    final raw = await getState();
    return CrashlyticsAppState.fromWireMap(raw);
  }

  /// Awaits pending background operations and disconnects any owned bridge client.
  Future<void> dispose() async {
    _liveInstances.remove(this);
    await _drainInFlightOps();
    await _session.dispose();
  }

  Map<String, dynamic> _baseParams() {
    final id = wireAppId;
    if (id == null) {
      return <String, dynamic>{};
    }
    return <String, dynamic>{'appId': id};
  }

  void _trackInFlight(Future<void> future) {
    _inFlightOps.add(future);
    future.whenComplete(() => _inFlightOps.remove(future));
  }

  Future<void> _drainInFlightOps() async {
    while (_inFlightOps.isNotEmpty) {
      await Future.wait(List<Future<void>>.of(_inFlightOps));
    }
  }
}
