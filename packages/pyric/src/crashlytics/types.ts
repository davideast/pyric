/**
 * Public and broker wire types for `pyric/crashlytics`, mirroring
 * `@firebase/crashlytics@0.2.0` (`firebase@13.4.0` public preview) without
 * taking an external `@opentelemetry/api` runtime or type dependency.
 */
import type { FirebaseApp } from '../app/types.js';

/** Scalar attribute primitive compatible with OpenTelemetry `AttributeValue`. */
export type AttributePrimitive = string | number | boolean;

/**
 * Attribute value compatible with `@opentelemetry/api`'s `AttributeValue`
 * (`string`, `number`, `boolean`, or homogeneous primitive arrays).
 */
export type AttributeValue =
  | AttributePrimitive
  | Array<string | undefined | null>
  | Array<number | undefined | null>
  | Array<boolean | undefined | null>;

/** OpenTelemetry-compatible attribute map accepted by `log`, `recordError`, and `customAttributes`. */
export interface Attributes {
  [attributeKey: string]: AttributeValue | undefined;
}

/** Alias of {@link Attributes} for explicit Crashlytics attribute typing. */
export type CrashlyticsAttributes = Attributes;

/**
 * An instance of the Firebase Crashlytics Web SDK.
 * Obtain an instance via `getCrashlytics()`.
 */
export interface Crashlytics {
  /** The `FirebaseApp` associated with this `Crashlytics` instance. */
  app: FirebaseApp;
}

/**
 * Opaque feature plugin object returned by feature factories such as `breadcrumbs()`.
 */
export interface CrashlyticsFeature {}

/**
 * Options configuring a `Crashlytics` instance via `getCrashlytics(app, options)`.
 */
export interface CrashlyticsOptions {
  /**
   * Optional endpoint URL for OpenTelemetry Crashlytics ingestion.
   * Under the Pyric sandbox, only loopback or local sandbox paths are permitted;
   * off-machine URLs are refused before any network request can leave.
   */
  endpointUrl?: string;
  /** Target Google Cloud region (defaults to `"global"`). */
  region?: string;
  /** Application version identifier attached to recorded crash reports. */
  appVersion?: string;
  /**
   * Base set of custom attributes attached to recorded errors and logs.
   * Call-level attributes passed to `recordError()` or `log()` take precedence.
   */
  customAttributes?: CrashlyticsAttributes;
  /** Whether to register a global logger provider (defaults to `false`). */
  registerGlobalLoggerProvider?: boolean;
  /**
   * Whether to automatically capture browser `error` and `unhandledrejection`
   * window events (defaults to `true`).
   */
  captureUnhandledErrors?: boolean;
  /** Optional feature plugins such as `breadcrumbs()`. */
  features?: CrashlyticsFeature[];
}

// ---------------------------------------------------------------------------
// Shared Crashlytics broker & `crashlytics.*` wire contract types
// ---------------------------------------------------------------------------

/** Plain JSON scalar stored on Crashlytics wire frames across Web and native SDKs. */
export type PlainCrashlyticsValue = string | number | boolean | null;

/** Platform tag identifying the SDK that recorded a Crashlytics report. */
export type CrashlyticsSdkPlatform = 'web' | 'android' | 'ios' | 'flutter';

/** Single breadcrumb attached to a recorded Crashlytics report. */
export interface CrashlyticsBreadcrumb {
  message: string;
  timestampMs: number;
  attributes?: Record<string, PlainCrashlyticsValue>;
}

/** Single log entry stored in the per-app Crashlytics log ring buffer. */
export interface CrashlyticsLogEntry {
  message: string;
  timestampMs: number;
  attributes?: Record<string, PlainCrashlyticsValue>;
}

/** Recorded Crashlytics error report held in `reports` or `unsentReports`. */
export interface CrashlyticsReport {
  reportId: string;
  appId: string;
  name: string;
  message: string;
  stack: string | null;
  code: string | null;
  cause: string | null;
  fatal: boolean;
  attributes: Record<string, PlainCrashlyticsValue>;
  customKeys: Record<string, string | number | boolean>;
  userId: string | null;
  breadcrumbs: CrashlyticsBreadcrumb[];
  timestampMs: number;
  appVersion: string | null;
  region: string | null;
  sdkPlatform: CrashlyticsSdkPlatform;
  flushed: boolean;
}

/** Wire input for `crashlytics.recordError`. */
export interface CrashlyticsRecordErrorInput {
  appId?: string;
  name?: string;
  message: string;
  stack?: string | null;
  code?: string | null;
  cause?: string | null;
  fatal?: boolean;
  attributes?: Record<string, PlainCrashlyticsValue>;
  breadcrumbs?: CrashlyticsBreadcrumb[];
  timestampMs?: number;
  appVersion?: string | null;
  region?: string | null;
  sdkPlatform?: CrashlyticsSdkPlatform;
  deferred?: boolean;
}

/** Wire reply for `crashlytics.recordError`. */
export interface CrashlyticsRecordErrorResult {
  reportId: string;
  queued: boolean;
  flushed: boolean;
}

/** Wire input for `crashlytics.log`. */
export interface CrashlyticsLogInput {
  appId?: string;
  message: string;
  attributes?: Record<string, PlainCrashlyticsValue>;
  timestampMs?: number;
}

/** Wire reply for `crashlytics.log`. */
export interface CrashlyticsLogResult {
  logged: true;
  logCount: number;
}

/** Wire reply for `crashlytics.flush`. */
export interface CrashlyticsFlushResult {
  flushedCount: number;
}

/** Wire reply for `crashlytics.setCollectionEnabled`. */
export interface CrashlyticsSetCollectionEnabledResult {
  enabled: boolean;
}

/** Wire reply for `crashlytics.checkForUnsentReports`. */
export interface CrashlyticsCheckForUnsentReportsResult {
  hasUnsentReports: boolean;
  count: number;
}

/** Wire reply for `crashlytics.sendUnsentReports`. */
export interface CrashlyticsSendUnsentReportsResult {
  sentCount: number;
}

/** Wire reply for `crashlytics.deleteUnsentReports`. */
export interface CrashlyticsDeleteUnsentReportsResult {
  deletedCount: number;
}

/** Full inspectable per-app Crashlytics state returned by `crashlytics.getState`. */
export interface CrashlyticsAppState {
  collectionEnabled: boolean;
  userId: string | null;
  customKeys: Record<string, string | number | boolean>;
  appVersion: string | null;
  region: string | null;
  didCrashOnPreviousExecution: boolean;
  logs: CrashlyticsLogEntry[];
  reports: CrashlyticsReport[];
  unsentReports: CrashlyticsReport[];
}

/** Durable snapshot shape persisted across sandbox checkpoints and restarts. */
export interface CrashlyticsSnapshot {
  version: 1;
  nextSequence: number;
  apps: Array<[string, CrashlyticsAppState]>;
}
