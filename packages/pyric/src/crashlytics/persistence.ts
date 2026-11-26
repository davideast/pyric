import type {
  CrashlyticsAppState,
  CrashlyticsBreadcrumb,
  CrashlyticsLogEntry,
  CrashlyticsReport,
  CrashlyticsSdkPlatform,
  CrashlyticsSnapshot,
  PlainCrashlyticsValue,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCustomKeyValue(value: unknown): value is string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainCrashlyticsValue(value: unknown): value is PlainCrashlyticsValue {
  if (value === null) {
    return true;
  }
  return isCustomKeyValue(value);
}

function isCustomKeysRecord(value: unknown): value is Record<string, string | number | boolean> {
  if (!isRecord(value)) {
    return false;
  }
  for (const entry of Object.values(value)) {
    if (!isCustomKeyValue(entry)) {
      return false;
    }
  }
  return true;
}

function isPlainCrashlyticsRecord(value: unknown): value is Record<string, PlainCrashlyticsValue> {
  if (!isRecord(value)) {
    return false;
  }
  for (const entry of Object.values(value)) {
    if (!isPlainCrashlyticsValue(entry)) {
      return false;
    }
  }
  return true;
}

function isCrashlyticsSdkPlatform(value: unknown): value is CrashlyticsSdkPlatform {
  return (
    value === 'web' ||
    value === 'android' ||
    value === 'ios' ||
    value === 'flutter'
  );
}

function isCrashlyticsLogEntry(value: unknown): value is CrashlyticsLogEntry {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.message !== 'string') {
    return false;
  }
  if (typeof value.timestampMs !== 'number' || !Number.isFinite(value.timestampMs)) {
    return false;
  }
  if (value.attributes !== undefined && !isPlainCrashlyticsRecord(value.attributes)) {
    return false;
  }
  return true;
}

function isCrashlyticsBreadcrumb(value: unknown): value is CrashlyticsBreadcrumb {
  return isCrashlyticsLogEntry(value);
}

function isCrashlyticsReport(value: unknown): value is CrashlyticsReport {
  if (!isRecord(value)) {
    return false;
  }
  const hasStrings =
    typeof value.reportId === 'string' &&
    value.reportId.length > 0 &&
    typeof value.appId === 'string' &&
    value.appId.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.message === 'string';
  if (!hasStrings) {
    return false;
  }
  const hasNullableStrings =
    isNullableString(value.stack) &&
    isNullableString(value.code) &&
    isNullableString(value.cause) &&
    isNullableString(value.userId) &&
    isNullableString(value.appVersion) &&
    isNullableString(value.region);
  if (!hasNullableStrings) {
    return false;
  }
  const hasFlagsAndTime =
    typeof value.fatal === 'boolean' &&
    typeof value.flushed === 'boolean' &&
    typeof value.timestampMs === 'number' &&
    Number.isFinite(value.timestampMs) &&
    isCrashlyticsSdkPlatform(value.sdkPlatform);
  if (!hasFlagsAndTime) {
    return false;
  }
  const hasNestedRecords =
    isPlainCrashlyticsRecord(value.attributes) &&
    isCustomKeysRecord(value.customKeys) &&
    Array.isArray(value.breadcrumbs) &&
    value.breadcrumbs.every(isCrashlyticsBreadcrumb);
  return hasNestedRecords;
}

function isCrashlyticsAppState(value: unknown): value is CrashlyticsAppState {
  if (!isRecord(value)) {
    return false;
  }
  const hasScalars =
    typeof value.collectionEnabled === 'boolean' &&
    isNullableString(value.userId) &&
    isCustomKeysRecord(value.customKeys) &&
    isNullableString(value.appVersion) &&
    isNullableString(value.region) &&
    typeof value.didCrashOnPreviousExecution === 'boolean';
  if (!hasScalars) {
    return false;
  }
  const hasCollections =
    Array.isArray(value.logs) &&
    value.logs.every(isCrashlyticsLogEntry) &&
    Array.isArray(value.reports) &&
    value.reports.every(isCrashlyticsReport) &&
    Array.isArray(value.unsentReports) &&
    value.unsentReports.every(isCrashlyticsReport);
  return hasCollections;
}

function isCrashlyticsAppEntry(value: unknown): value is [string, CrashlyticsAppState] {
  const isPair = Array.isArray(value) && value.length === 2;
  if (!isPair) {
    return false;
  }
  const [appId, appState] = value;
  const hasAppId = typeof appId === 'string' && appId.trim().length > 0;
  if (!hasAppId) {
    return false;
  }
  return isCrashlyticsAppState(appState);
}

/** Validates a serialized Crashlytics broker snapshot envelope. */
export function isCrashlyticsSnapshot(raw: unknown): raw is CrashlyticsSnapshot {
  if (!isRecord(raw)) {
    return false;
  }
  const hasVersion = raw.version === 1;
  const hasSequence =
    typeof raw.nextSequence === 'number' &&
    Number.isInteger(raw.nextSequence) &&
    raw.nextSequence >= 1;
  const hasApps = Array.isArray(raw.apps) && raw.apps.every(isCrashlyticsAppEntry);
  return hasVersion && hasSequence && hasApps;
}

/** True when a per-app Crashlytics state carries non-default user or report data. */
export function hasCrashlyticsAppStateData(state: CrashlyticsAppState): boolean {
  return (
    state.collectionEnabled === false ||
    state.userId !== null ||
    Object.keys(state.customKeys).length > 0 ||
    state.appVersion !== null ||
    state.region !== null ||
    state.didCrashOnPreviousExecution === true ||
    state.logs.length > 0 ||
    state.reports.length > 0 ||
    state.unsentReports.length > 0
  );
}

/** True when a Crashlytics snapshot contains any non-default per-app state. */
export function hasCrashlyticsSnapshotData(snapshot: CrashlyticsSnapshot): boolean {
  return snapshot.apps.some(([, state]) => hasCrashlyticsAppStateData(state));
}
