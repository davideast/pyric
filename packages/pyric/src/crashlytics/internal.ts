/**
 * `pyric/crashlytics/internal` -- internal broker and transport seams shared
 * with `@pyric/cli`'s SharedWorker / `HostedRuntime` host (`host-crashlytics.ts`)
 * and served browser entries (`entries/crashlytics.ts`).
 *
 * Not part of the public `firebase/crashlytics` API surface.
 */
export {
  CrashlyticsBroker,
  DEFAULT_CRASHLYTICS_APP_ID,
  getCrashlyticsBroker,
  MAX_CRASHLYTICS_LOGS,
  MAX_CRASHLYTICS_REPORTS,
  resetCrashlyticsBroker,
} from './broker.js';

export {
  createTransportCrashlytics,
  normalizeCrashlyticsAttributes,
  normalizeThrownError,
  registerCrashlyticsTransport,
  validateCrashlyticsEndpointUrl,
  type CrashlyticsClientTransport,
} from './client.js';

export type {
  CrashlyticsAppState,
  CrashlyticsBreadcrumb,
  CrashlyticsCheckForUnsentReportsResult,
  CrashlyticsDeleteUnsentReportsResult,
  CrashlyticsFlushResult,
  CrashlyticsLogEntry,
  CrashlyticsLogInput,
  CrashlyticsLogResult,
  CrashlyticsRecordErrorInput,
  CrashlyticsRecordErrorResult,
  CrashlyticsReport,
  CrashlyticsSdkPlatform,
  CrashlyticsSendUnsentReportsResult,
  CrashlyticsSetCollectionEnabledResult,
  CrashlyticsSnapshot,
  PlainCrashlyticsValue,
} from './types.js';
