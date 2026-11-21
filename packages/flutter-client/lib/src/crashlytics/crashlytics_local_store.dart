import 'dart:collection';

import 'crashlytics_types.dart';

/// In-memory Crashlytics state mirror used for local queries and offline unit runs.
class LocalCrashlyticsStore {
  bool? collectionOverride;
  String? userId;
  bool didCrashOnPreviousExecution = false;
  int _reportSequence = 0;

  final LinkedHashMap<String, Object> customKeys =
      LinkedHashMap<String, Object>();
  final ListQueue<CrashlyticsBreadcrumb> breadcrumbs =
      ListQueue<CrashlyticsBreadcrumb>();
  final List<CrashlyticsLogEntry> logs = <CrashlyticsLogEntry>[];
  final List<CrashlyticsReport> reports = <CrashlyticsReport>[];
  final List<CrashlyticsReport> unsentReports = <CrashlyticsReport>[];

  void putCustomKey(String key, Object value) {
    if (customKeys.containsKey(key) ||
        customKeys.length < maxCrashlyticsCustomKeys) {
      customKeys[key] = value;
    }
  }

  void applyCustomKeyBatch(Map<String, Object?> normalized) {
    for (final entry in normalized.entries) {
      final val = entry.value;
      if (val == null) {
        customKeys.remove(entry.key);
      } else {
        putCustomKey(entry.key, val);
      }
    }
  }

  void addLog(String message, int timestampMs) {
    if (breadcrumbs.length >= maxCrashlyticsBreadcrumbs) {
      breadcrumbs.removeFirst();
    }
    breadcrumbs.addLast(
      CrashlyticsBreadcrumb(message: message, timestampMs: timestampMs),
    );
    _pushRing(
      logs,
      CrashlyticsLogEntry(message: message, timestampMs: timestampMs),
      maxCrashlyticsReports,
    );
  }

  void recordReport({
    required String appId,
    required String name,
    required String message,
    required String stack,
    required String? code,
    required String? cause,
    required bool fatal,
    required Map<String, Object?> attributes,
    required List<CrashlyticsBreadcrumb> breadcrumbsSnapshot,
    required int timestampMs,
    required bool deferred,
  }) {
    _reportSequence += 1;
    final report = CrashlyticsReport(
      reportId: 'crash-$_reportSequence',
      appId: appId,
      name: name,
      message: message,
      stack: stack,
      code: code,
      cause: cause,
      fatal: fatal,
      attributes: Map<String, Object?>.unmodifiable(attributes),
      customKeys: Map<String, Object>.unmodifiable(customKeys),
      userId: userId,
      breadcrumbs: breadcrumbsSnapshot,
      timestampMs: timestampMs,
      appVersion: null,
      region: null,
      sdkPlatform: crashlyticsSdkPlatformFlutter,
      flushed: false,
    );
    if (deferred) {
      _pushRing(unsentReports, report, maxCrashlyticsReports);
    } else {
      _pushRing(reports, report, maxCrashlyticsReports);
    }
  }

  void promoteUnsentReports() {
    if (unsentReports.isEmpty) {
      return;
    }
    final pending = List<CrashlyticsReport>.of(unsentReports);
    unsentReports.clear();
    for (final report in pending) {
      _pushRing(
        reports,
        report.copyWith(flushed: true),
        maxCrashlyticsReports,
      );
    }
  }

  void markReportsFlushed() {
    for (var i = 0; i < reports.length; i++) {
      if (!reports[i].flushed) {
        reports[i] = reports[i].copyWith(flushed: true);
      }
    }
  }

  CrashlyticsAppState snapshot({required bool collectionEnabled}) {
    return CrashlyticsAppState(
      collectionEnabled: collectionEnabled,
      userId: userId,
      customKeys: Map<String, Object>.unmodifiable(customKeys),
      appVersion: null,
      region: null,
      didCrashOnPreviousExecution: didCrashOnPreviousExecution,
      logs: List<CrashlyticsLogEntry>.unmodifiable(logs),
      reports: List<CrashlyticsReport>.unmodifiable(reports),
      unsentReports: List<CrashlyticsReport>.unmodifiable(unsentReports),
    );
  }

  static void _pushRing<T>(List<T> buffer, T entry, int cap) {
    buffer.add(entry);
    while (buffer.length > cap) {
      buffer.removeAt(0);
    }
  }
}
