/// Shared value types, constants, and simulated crash error for `pyric_crashlytics`.
library;

/// Canonical FlutterFire plugin identifier used on [FirebaseException.plugin].
const String firebaseCrashlyticsPluginName = 'firebase_crashlytics';

/// Wire `sdkPlatform` identifier sent on `crashlytics.recordError`.
const String crashlyticsSdkPlatformFlutter = 'flutter';

/// Maximum rolling breadcrumbs retained locally per [FirebaseCrashlytics] instance.
const int maxCrashlyticsBreadcrumbs = 64;

/// Maximum custom key/value entries retained per [FirebaseCrashlytics] instance.
const int maxCrashlyticsCustomKeys = 64;

/// Maximum local reports retained in offline mode per [FirebaseCrashlytics] instance.
const int maxCrashlyticsReports = 256;

/// Maximum character length for custom keys, values, and user identifiers.
const int maxCrashlyticsStringChars = 1024;

/// Deterministic error thrown by `FirebaseCrashlytics.crash()` in place of
/// terminating the Dart VM or Flutter test runner process.
class CrashlyticsSimulatedCrashError extends StateError {
  CrashlyticsSimulatedCrashError([
    super.message =
        'Simulated fatal crash triggered by FirebaseCrashlytics.crash().',
  ]);
}

/// One breadcrumb attached to a [CrashlyticsReport].
class CrashlyticsBreadcrumb {
  const CrashlyticsBreadcrumb({
    required this.message,
    required this.timestampMs,
    this.attributes,
  });

  factory CrashlyticsBreadcrumb.fromWireMap(Map<dynamic, dynamic> raw) {
    final attrsRaw = raw['attributes'];
    return CrashlyticsBreadcrumb(
      message: (raw['message'] as String?) ?? '',
      timestampMs: (raw['timestampMs'] as num?)?.toInt() ?? 0,
      attributes: attrsRaw is Map
          ? Map<String, Object?>.unmodifiable(
              Map<String, Object?>.from(attrsRaw),
            )
          : null,
    );
  }

  final String message;
  final int timestampMs;
  final Map<String, Object?>? attributes;

  Map<String, dynamic> toWireMap() {
    return <String, dynamic>{
      'message': message,
      'timestampMs': timestampMs,
      if (attributes != null && attributes!.isNotEmpty)
        'attributes': Map<String, dynamic>.from(attributes!),
    };
  }
}

/// One log entry stored in the per-app Crashlytics log ring buffer.
class CrashlyticsLogEntry {
  const CrashlyticsLogEntry({
    required this.message,
    required this.timestampMs,
    this.attributes,
  });

  factory CrashlyticsLogEntry.fromWireMap(Map<dynamic, dynamic> raw) {
    final attrsRaw = raw['attributes'];
    return CrashlyticsLogEntry(
      message: (raw['message'] as String?) ?? '',
      timestampMs: (raw['timestampMs'] as num?)?.toInt() ?? 0,
      attributes: attrsRaw is Map
          ? Map<String, Object?>.unmodifiable(
              Map<String, Object?>.from(attrsRaw),
            )
          : null,
    );
  }

  final String message;
  final int timestampMs;
  final Map<String, Object?>? attributes;

  Map<String, dynamic> toWireMap() {
    return <String, dynamic>{
      'message': message,
      'timestampMs': timestampMs,
      if (attributes != null && attributes!.isNotEmpty)
        'attributes': Map<String, dynamic>.from(attributes!),
    };
  }
}

/// One recorded fatal or non-fatal Crashlytics report in the sandbox broker.
class CrashlyticsReport {
  const CrashlyticsReport({
    required this.reportId,
    required this.appId,
    required this.name,
    required this.message,
    required this.stack,
    required this.code,
    required this.cause,
    required this.fatal,
    required this.attributes,
    required this.customKeys,
    required this.userId,
    required this.breadcrumbs,
    required this.timestampMs,
    required this.appVersion,
    required this.region,
    required this.sdkPlatform,
    required this.flushed,
  });

  factory CrashlyticsReport.fromWireMap(Map<dynamic, dynamic> raw) {
    final rawAttrs = raw['attributes'];
    final rawKeys = raw['customKeys'];
    final rawCrumbs = raw['breadcrumbs'];
    final crumbs = <CrashlyticsBreadcrumb>[];
    if (rawCrumbs is List) {
      for (final item in rawCrumbs) {
        if (item is Map) {
          crumbs.add(CrashlyticsBreadcrumb.fromWireMap(item));
        }
      }
    }
    return CrashlyticsReport(
      reportId: (raw['reportId'] as String?) ?? '',
      appId: (raw['appId'] as String?) ?? 'default',
      name: (raw['name'] as String?) ?? 'Error',
      message: (raw['message'] as String?) ?? '',
      stack: raw['stack'] as String?,
      code: raw['code'] as String?,
      cause: raw['cause'] as String?,
      fatal: raw['fatal'] == true,
      attributes: rawAttrs is Map
          ? Map<String, Object?>.unmodifiable(
              Map<String, Object?>.from(rawAttrs),
            )
          : const <String, Object?>{},
      customKeys: rawKeys is Map
          ? Map<String, Object>.unmodifiable(
              <String, Object>{
                for (final entry in rawKeys.entries)
                  if (entry.key is String && entry.value != null)
                    entry.key as String: entry.value as Object,
              },
            )
          : const <String, Object>{},
      userId: raw['userId'] as String?,
      breadcrumbs: List<CrashlyticsBreadcrumb>.unmodifiable(crumbs),
      timestampMs: (raw['timestampMs'] as num?)?.toInt() ?? 0,
      appVersion: raw['appVersion'] as String?,
      region: raw['region'] as String?,
      sdkPlatform:
          (raw['sdkPlatform'] as String?) ?? crashlyticsSdkPlatformFlutter,
      flushed: raw['flushed'] == true,
    );
  }

  final String reportId;
  final String appId;
  final String name;
  final String message;
  final String? stack;
  final String? code;
  final String? cause;
  final bool fatal;
  final Map<String, Object?> attributes;
  final Map<String, Object> customKeys;
  final String? userId;
  final List<CrashlyticsBreadcrumb> breadcrumbs;
  final int timestampMs;
  final String? appVersion;
  final String? region;
  final String sdkPlatform;
  final bool flushed;

  CrashlyticsReport copyWith({bool? flushed}) {
    return CrashlyticsReport(
      reportId: reportId,
      appId: appId,
      name: name,
      message: message,
      stack: stack,
      code: code,
      cause: cause,
      fatal: fatal,
      attributes: attributes,
      customKeys: customKeys,
      userId: userId,
      breadcrumbs: breadcrumbs,
      timestampMs: timestampMs,
      appVersion: appVersion,
      region: region,
      sdkPlatform: sdkPlatform,
      flushed: flushed ?? this.flushed,
    );
  }

  Map<String, dynamic> toWireMap() {
    return <String, dynamic>{
      'reportId': reportId,
      'appId': appId,
      'name': name,
      'message': message,
      'stack': stack,
      'code': code,
      'cause': cause,
      'fatal': fatal,
      'attributes': Map<String, dynamic>.from(attributes),
      'customKeys': Map<String, dynamic>.from(customKeys),
      'userId': userId,
      'breadcrumbs':
          breadcrumbs.map((crumb) => crumb.toWireMap()).toList(growable: false),
      'timestampMs': timestampMs,
      'appVersion': appVersion,
      'region': region,
      'sdkPlatform': sdkPlatform,
      'flushed': flushed,
    };
  }
}

/// Snapshot of per-app Crashlytics broker state returned by `crashlytics.getState`.
class CrashlyticsAppState {
  const CrashlyticsAppState({
    required this.collectionEnabled,
    required this.userId,
    required this.customKeys,
    required this.appVersion,
    required this.region,
    required this.didCrashOnPreviousExecution,
    required this.logs,
    required this.reports,
    required this.unsentReports,
  });

  factory CrashlyticsAppState.fromWireMap(Map<dynamic, dynamic> raw) {
    final rawKeys = raw['customKeys'];
    final rawLogs = raw['logs'];
    final rawReports = raw['reports'];
    final rawUnsent = raw['unsentReports'];

    final logs = <CrashlyticsLogEntry>[];
    if (rawLogs is List) {
      for (final entry in rawLogs) {
        if (entry is Map) {
          logs.add(CrashlyticsLogEntry.fromWireMap(entry));
        }
      }
    }

    final reports = <CrashlyticsReport>[];
    if (rawReports is List) {
      for (final entry in rawReports) {
        if (entry is Map) {
          reports.add(CrashlyticsReport.fromWireMap(entry));
        }
      }
    }

    final unsentReports = <CrashlyticsReport>[];
    if (rawUnsent is List) {
      for (final entry in rawUnsent) {
        if (entry is Map) {
          unsentReports.add(CrashlyticsReport.fromWireMap(entry));
        }
      }
    }

    return CrashlyticsAppState(
      collectionEnabled: raw['collectionEnabled'] != false,
      userId: raw['userId'] as String?,
      customKeys: rawKeys is Map
          ? Map<String, Object>.unmodifiable(
              <String, Object>{
                for (final entry in rawKeys.entries)
                  if (entry.key is String && entry.value != null)
                    entry.key as String: entry.value as Object,
              },
            )
          : const <String, Object>{},
      appVersion: raw['appVersion'] as String?,
      region: raw['region'] as String?,
      didCrashOnPreviousExecution: raw['didCrashOnPreviousExecution'] == true,
      logs: List<CrashlyticsLogEntry>.unmodifiable(logs),
      reports: List<CrashlyticsReport>.unmodifiable(reports),
      unsentReports: List<CrashlyticsReport>.unmodifiable(unsentReports),
    );
  }

  final bool collectionEnabled;
  final String? userId;
  final Map<String, Object> customKeys;
  final String? appVersion;
  final String? region;
  final bool didCrashOnPreviousExecution;
  final List<CrashlyticsLogEntry> logs;
  final List<CrashlyticsReport> reports;
  final List<CrashlyticsReport> unsentReports;

  Map<String, dynamic> toWireMap() {
    return <String, dynamic>{
      'collectionEnabled': collectionEnabled,
      'userId': userId,
      'customKeys': Map<String, dynamic>.from(customKeys),
      'appVersion': appVersion,
      'region': region,
      'didCrashOnPreviousExecution': didCrashOnPreviousExecution,
      'logs': logs.map((entry) => entry.toWireMap()).toList(growable: false),
      'reports':
          reports.map((report) => report.toWireMap()).toList(growable: false),
      'unsentReports': unsentReports
          .map((report) => report.toWireMap())
          .toList(growable: false),
    };
  }
}
