/**
 * Per-sandbox in-memory Crashlytics broker shared across Web (`pyric/crashlytics`),
 * the SharedWorker / `HostedRuntime` host (`host-crashlytics.ts`), and native
 * Android / iOS / Flutter Crashlytics SDKs over the `crashlytics.*` wire contract.
 */
import { getClock } from '../sandbox/clock.js';
import type { Sandbox } from '../sandbox/types/service.js';
import type {
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

export const DEFAULT_CRASHLYTICS_APP_ID = 'default';
export const MAX_CRASHLYTICS_LOGS = 256;
export const MAX_CRASHLYTICS_REPORTS = 256;

interface MutableAppCrashlyticsState {
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

function createEmptyAppState(): MutableAppCrashlyticsState {
  return {
    collectionEnabled: true,
    userId: null,
    customKeys: {},
    appVersion: null,
    region: null,
    didCrashOnPreviousExecution: false,
    logs: [],
    reports: [],
    unsentReports: [],
  };
}

function resolveAppKey(appId: string | undefined): string {
  if (typeof appId === 'string' && appId.trim().length > 0) {
    return appId.trim();
  }
  return DEFAULT_CRASHLYTICS_APP_ID;
}

function sanitizePlainRecord(
  input: Record<string, PlainCrashlyticsValue> | undefined,
): Record<string, PlainCrashlyticsValue> {
  const out: Record<string, PlainCrashlyticsValue> = {};
  if (input === undefined) {
    return out;
  }
  for (const [key, value] of Object.entries(input)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      out[key] = value;
    }
  }
  return out;
}

function cloneBreadcrumbs(items: readonly CrashlyticsBreadcrumb[]): CrashlyticsBreadcrumb[] {
  return items.map((entry) => {
    const cloned: CrashlyticsBreadcrumb = {
      message: entry.message,
      timestampMs: entry.timestampMs,
    };
    if (entry.attributes !== undefined) {
      cloned.attributes = sanitizePlainRecord(entry.attributes);
    }
    return cloned;
  });
}

function cloneLogEntries(items: readonly CrashlyticsLogEntry[]): CrashlyticsLogEntry[] {
  return items.map((entry) => {
    const cloned: CrashlyticsLogEntry = {
      message: entry.message,
      timestampMs: entry.timestampMs,
    };
    if (entry.attributes !== undefined) {
      cloned.attributes = sanitizePlainRecord(entry.attributes);
    }
    return cloned;
  });
}

function cloneReport(report: CrashlyticsReport): CrashlyticsReport {
  return {
    reportId: report.reportId,
    appId: report.appId,
    name: report.name,
    message: report.message,
    stack: report.stack,
    code: report.code,
    cause: report.cause,
    fatal: report.fatal,
    attributes: { ...report.attributes },
    customKeys: { ...report.customKeys },
    userId: report.userId,
    breadcrumbs: cloneBreadcrumbs(report.breadcrumbs),
    timestampMs: report.timestampMs,
    appVersion: report.appVersion,
    region: report.region,
    sdkPlatform: report.sdkPlatform,
    flushed: report.flushed,
  };
}

function cloneAppState(state: MutableAppCrashlyticsState): CrashlyticsAppState {
  return {
    collectionEnabled: state.collectionEnabled,
    userId: state.userId,
    customKeys: { ...state.customKeys },
    appVersion: state.appVersion,
    region: state.region,
    didCrashOnPreviousExecution: state.didCrashOnPreviousExecution,
    logs: cloneLogEntries(state.logs),
    reports: state.reports.map(cloneReport),
    unsentReports: state.unsentReports.map(cloneReport),
  };
}

function pushRing<T>(buffer: T[], entry: T, cap: number): void {
  buffer.push(entry);
  while (buffer.length > cap) {
    buffer.shift();
  }
}

function isCrashlyticsSnapshot(raw: unknown): raw is CrashlyticsSnapshot {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const candidate = raw as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.nextSequence === 'number' &&
    Array.isArray(candidate.apps)
  );
}

/**
 * In-memory Crashlytics broker managing per-app error reports, unsent report
 * queues, log ring buffers, custom keys, user identifiers, and collection gates.
 */
export class CrashlyticsBroker {
  private readonly apps = new Map<string, MutableAppCrashlyticsState>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private nextSequence = 1;

  constructor(options: { sandbox?: Sandbox; now?: () => number } = {}) {
    if (options.now !== undefined) {
      this.now = options.now;
    } else if (options.sandbox !== undefined) {
      const targetSandbox = options.sandbox;
      this.now = () => getClock(targetSandbox).now();
    } else {
      this.now = () => Date.now();
    }
  }

  private stateFor(appId: string | undefined): { key: string; state: MutableAppCrashlyticsState } {
    const key = resolveAppKey(appId);
    let existing = this.apps.get(key);
    if (existing === undefined) {
      existing = createEmptyAppState();
      this.apps.set(key, existing);
    }
    return { key, state: existing };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  log(input: CrashlyticsLogInput): CrashlyticsLogResult {
    const { state } = this.stateFor(input.appId);
    let timestampMs = this.now();
    if (typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs)) {
      timestampMs = input.timestampMs;
    }
    const entry: CrashlyticsLogEntry = {
      message: input.message,
      timestampMs,
    };
    if (input.attributes !== undefined) {
      entry.attributes = sanitizePlainRecord(input.attributes);
    }
    pushRing(state.logs, entry, MAX_CRASHLYTICS_LOGS);
    this.notify();
    return { logged: true, logCount: state.logs.length };
  }

  recordError(input: CrashlyticsRecordErrorInput): CrashlyticsRecordErrorResult {
    const { key, state } = this.stateFor(input.appId);
    if (typeof input.appVersion === 'string' && input.appVersion.length > 0) {
      state.appVersion = input.appVersion;
    }
    if (typeof input.region === 'string' && input.region.length > 0) {
      state.region = input.region;
    }

    let timestampMs = this.now();
    if (typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs)) {
      timestampMs = input.timestampMs;
    }

    let resolvedName = 'Error';
    if (typeof input.name === 'string' && input.name.length > 0) {
      resolvedName = input.name;
    }

    let resolvedStack: string | null = null;
    if (typeof input.stack === 'string') {
      resolvedStack = input.stack;
    }

    let resolvedCode: string | null = null;
    if (typeof input.code === 'string') {
      resolvedCode = input.code;
    }

    let resolvedCause: string | null = null;
    if (typeof input.cause === 'string') {
      resolvedCause = input.cause;
    }

    let sdkPlatform: CrashlyticsSdkPlatform = 'web';
    if (
      input.sdkPlatform === 'web' ||
      input.sdkPlatform === 'android' ||
      input.sdkPlatform === 'ios' ||
      input.sdkPlatform === 'flutter'
    ) {
      sdkPlatform = input.sdkPlatform;
    }

    let resolvedBreadcrumbs: CrashlyticsBreadcrumb[];
    if (input.breadcrumbs !== undefined) {
      resolvedBreadcrumbs = cloneBreadcrumbs(input.breadcrumbs);
    } else {
      resolvedBreadcrumbs = state.logs.map((logEntry) => {
        const crumb: CrashlyticsBreadcrumb = {
          message: logEntry.message,
          timestampMs: logEntry.timestampMs,
        };
        if (logEntry.attributes !== undefined) {
          crumb.attributes = sanitizePlainRecord(logEntry.attributes);
        }
        return crumb;
      });
    }

    let resolvedAppVersion = state.appVersion;
    if (typeof input.appVersion === 'string') {
      resolvedAppVersion = input.appVersion;
    }

    let resolvedRegion = state.region;
    if (typeof input.region === 'string') {
      resolvedRegion = input.region;
    }

    const reportId = `crash-${this.nextSequence}`;
    this.nextSequence += 1;

    const isFatal = input.fatal === true;
    if (isFatal) {
      state.didCrashOnPreviousExecution = true;
    }

    const queueAsUnsent = !state.collectionEnabled || input.deferred === true;
    const report: CrashlyticsReport = {
      reportId,
      appId: key,
      name: resolvedName,
      message: input.message,
      stack: resolvedStack,
      code: resolvedCode,
      cause: resolvedCause,
      fatal: isFatal,
      attributes: sanitizePlainRecord(input.attributes),
      customKeys: { ...state.customKeys },
      userId: state.userId,
      breadcrumbs: resolvedBreadcrumbs,
      timestampMs,
      appVersion: resolvedAppVersion,
      region: resolvedRegion,
      sdkPlatform,
      flushed: false,
    };

    if (queueAsUnsent) {
      pushRing(state.unsentReports, report, MAX_CRASHLYTICS_REPORTS);
      this.notify();
      return { reportId, queued: true, flushed: false };
    }

    pushRing(state.reports, report, MAX_CRASHLYTICS_REPORTS);
    this.notify();
    return { reportId, queued: true, flushed: false };
  }

  flush(appId?: string): CrashlyticsFlushResult {
    const { state } = this.stateFor(appId);
    let flushedCount = 0;
    for (const report of state.reports) {
      if (!report.flushed) {
        report.flushed = true;
        flushedCount += 1;
      }
    }
    if (flushedCount > 0) {
      this.notify();
    }
    return { flushedCount };
  }

  setUserId(appId: string | undefined, userId: string): null {
    const { state } = this.stateFor(appId);
    state.userId = userId;
    this.notify();
    return null;
  }

  setCustomKeys(
    appId: string | undefined,
    keys: Record<string, PlainCrashlyticsValue>,
  ): null {
    const { state } = this.stateFor(appId);
    for (const [key, value] of Object.entries(keys)) {
      if (value === null) {
        delete state.customKeys[key];
      } else if (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        state.customKeys[key] = value;
      }
    }
    this.notify();
    return null;
  }

  setCollectionEnabled(
    appId: string | undefined,
    enabled: boolean | null,
  ): CrashlyticsSetCollectionEnabledResult {
    const { state } = this.stateFor(appId);
    if (enabled === null) {
      state.collectionEnabled = true;
    } else {
      state.collectionEnabled = enabled;
    }
    this.notify();
    return { enabled: state.collectionEnabled };
  }

  checkForUnsentReports(appId?: string): CrashlyticsCheckForUnsentReportsResult {
    const { state } = this.stateFor(appId);
    const count = state.unsentReports.length;
    return { hasUnsentReports: count > 0, count };
  }

  sendUnsentReports(appId?: string): CrashlyticsSendUnsentReportsResult {
    const { state } = this.stateFor(appId);
    const pending = state.unsentReports.splice(0);
    for (const report of pending) {
      report.flushed = true;
      pushRing(state.reports, report, MAX_CRASHLYTICS_REPORTS);
    }
    if (pending.length > 0) {
      this.notify();
    }
    return { sentCount: pending.length };
  }

  deleteUnsentReports(appId?: string): CrashlyticsDeleteUnsentReportsResult {
    const { state } = this.stateFor(appId);
    const deletedCount = state.unsentReports.length;
    state.unsentReports.length = 0;
    if (deletedCount > 0) {
      this.notify();
    }
    return { deletedCount };
  }

  getState(appId?: string): CrashlyticsAppState {
    const { state } = this.stateFor(appId);
    return cloneAppState(state);
  }

  snapshot(): CrashlyticsSnapshot {
    const apps: Array<[string, CrashlyticsAppState]> = [];
    for (const [key, state] of this.apps.entries()) {
      apps.push([key, cloneAppState(state)]);
    }
    apps.sort((left, right) => left[0].localeCompare(right[0]));
    return {
      version: 1,
      nextSequence: this.nextSequence,
      apps,
    };
  }

  restore(raw: unknown): void {
    this.apps.clear();
    this.nextSequence = 1;
    if (!isCrashlyticsSnapshot(raw)) {
      return;
    }
    this.nextSequence = Math.max(1, Math.floor(raw.nextSequence));
    for (const [key, saved] of raw.apps) {
      if (typeof key !== 'string' || typeof saved !== 'object' || saved === null) {
        continue;
      }
      let restoredCustomKeys: Record<string, string | number | boolean> = {};
      if (saved.customKeys !== undefined && saved.customKeys !== null) {
        restoredCustomKeys = { ...saved.customKeys };
      }
      let restoredUnsent: CrashlyticsReport[] = [];
      if (Array.isArray(saved.unsentReports)) {
        restoredUnsent = saved.unsentReports.map(cloneReport);
      }
      this.apps.set(key, {
        collectionEnabled: saved.collectionEnabled !== false,
        userId: typeof saved.userId === 'string' ? saved.userId : null,
        customKeys: restoredCustomKeys,
        appVersion: typeof saved.appVersion === 'string' ? saved.appVersion : null,
        region: typeof saved.region === 'string' ? saved.region : null,
        didCrashOnPreviousExecution: saved.didCrashOnPreviousExecution === true,
        logs: Array.isArray(saved.logs) ? cloneLogEntries(saved.logs) : [],
        reports: Array.isArray(saved.reports) ? saved.reports.map(cloneReport) : [],
        unsentReports: restoredUnsent,
      });
    }
    this.notify();
  }

  reset(): void {
    const hadState = this.apps.size > 0 || this.nextSequence > 1;
    this.apps.clear();
    this.nextSequence = 1;
    if (hadState) {
      this.notify();
    }
  }
}

const brokers = new WeakMap<Sandbox, CrashlyticsBroker>();

/**
 * Returns the per-sandbox {@link CrashlyticsBroker}, creating and registering
 * it with `sandbox.registerPersistableService('crashlytics', ...)` on first access.
 */
export function getCrashlyticsBroker(sandbox: Sandbox): CrashlyticsBroker {
  const existing = brokers.get(sandbox);
  if (existing !== undefined) {
    return existing;
  }
  const broker = new CrashlyticsBroker({ sandbox });
  brokers.set(sandbox, broker);
  sandbox.registerPersistableService('crashlytics', {
    snapshot: () => broker.snapshot(),
    restore: (data) => broker.restore(data),
    reset: () => broker.reset(),
    subscribe: (listener) => broker.onChange(listener),
  });
  return broker;
}

/** Resets an already-initialized Crashlytics broker on `sandbox` without allocating one when unused. */
export function resetCrashlyticsBroker(sandbox: Sandbox): void {
  const existing = brokers.get(sandbox);
  if (existing !== undefined) {
    existing.reset();
  }
}
