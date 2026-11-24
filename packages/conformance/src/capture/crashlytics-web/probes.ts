/**
 * Offline SDK probe runner for `@firebase/crashlytics@0.2.0` (`firebase@13.4.0`),
 * capturing real OpenTelemetry OTLP log batches and lifecycle semantics with
 * stubbed `fetch` (zero network egress).
 */
import { buildCrashlyticsWebBrowserProbeSource } from './browser-probe-source.ts';
import {
  ensureCrashlyticsWebFb13Fixture,
  runBundledBrowserProbeScript,
} from './fixture.ts';

export {
  ensureCrashlyticsWebFb13Fixture,
  ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
  ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
} from './fixture.ts';

export interface OtlpAttributeEntry {
  key: string;
  value: Record<string, unknown>;
}

export interface NormalizedOtlpLogRecord {
  severityNumber: number;
  body: string | null;
  attributes: Record<string, unknown>;
}

export interface NormalizedOtlpScopeLogs {
  scopeName: string;
  records: NormalizedOtlpLogRecord[];
}

export interface NormalizedOtlpHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  keepalive: boolean;
  resourceAttributes: Record<string, unknown>;
  scopes: NormalizedOtlpScopeLogs[];
}

export interface CrashlyticsWebInstanceContractResult {
  breadcrumbFeatureKeys: string[];
  breadcrumbFeatureName: string;
  defaultSameEmpty: boolean;
  defaultSameOmitted: boolean;
  namedSameOptions: boolean;
  distinctAppsIsolated: boolean;
  omittedAfterOptionsError: string | null;
  mismatchedOptionsError: string | null;
}

export interface CrashlyticsWebOfflineProbeReport {
  firebaseVersion: string;
  crashlyticsVersion: string;
  instanceContract: CrashlyticsWebInstanceContractResult;
  otlpOptionsContract: {
    defaultLeavesGlobalProviderUnchanged: boolean;
    globalProviderRegistered: boolean;
    globalRequests: NormalizedOtlpHttpRequest[];
    regionalRequests: NormalizedOtlpHttpRequest[];
    customEndpointRequests: NormalizedOtlpHttpRequest[];
  };
  browserLifecycleContract: {
    sessionIdStored: boolean;
    listenersWhenActive: Record<string, number>;
    requestCountBeforeError: number;
    firstErrorBatch: NormalizedOtlpHttpRequest[];
    secondErrorAutoFlushedBatch: NormalizedOtlpHttpRequest[];
    listenersAfterDelete: Record<string, number>;
    requestCountOnShutDownHandle: number;
    getCrashlyticsOnFreshDeletedCode: string | null;
    listenersWhenUnhandledDisabled: Record<string, number>;
  };
}

interface RawCapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  keepalive: boolean;
  body: {
    resourceLogs?: Array<{
      resource?: { attributes?: OtlpAttributeEntry[] };
      scopeLogs?: Array<{
        scope?: { name?: string };
        logRecords?: Array<{
          severityNumber?: number;
          body?: { stringValue?: string };
          attributes?: OtlpAttributeEntry[];
        }>;
      }>;
    }>;
  } | null;
}

interface RawBrowserProbeData {
  instanceContract: CrashlyticsWebInstanceContractResult;
  otlpOptionsContract: {
    defaultLeavesGlobalProviderUnchanged: boolean;
    globalProviderRegistered: boolean;
    globalRequests: RawCapturedRequest[];
    regionalRequests: RawCapturedRequest[];
    customEndpointRequests: RawCapturedRequest[];
  };
  browserLifecycleContract: {
    sessionIdStored: boolean;
    listenersWhenActive: Record<string, number>;
    requestCountBeforeError: number;
    firstErrorBatch: RawCapturedRequest[];
    secondErrorAutoFlushedBatch: RawCapturedRequest[];
    listenersAfterDelete: Record<string, number>;
    requestCountOnShutDownHandle: number;
    getCrashlyticsOnFreshDeletedCode: string | null;
    listenersWhenUnhandledDisabled: Record<string, number>;
  };
}

function decodeOtlpAnyValue(raw: Record<string, unknown> | undefined): unknown {
  if (raw === undefined) {
    return null;
  }
  if ('stringValue' in raw) {
    return raw.stringValue;
  }
  if ('intValue' in raw) {
    return Number(raw.intValue);
  }
  if ('doubleValue' in raw) {
    return Number(raw.doubleValue);
  }
  if ('boolValue' in raw) {
    return Boolean(raw.boolValue);
  }
  if ('arrayValue' in raw && typeof raw.arrayValue === 'object' && raw.arrayValue !== null) {
    const values = (raw.arrayValue as { values?: Array<Record<string, unknown>> }).values ?? [];
    return values.map((item) => decodeOtlpAnyValue(item));
  }
  return raw;
}

function normalizeAttributeMap(entries: readonly OtlpAttributeEntry[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (entries === undefined) {
    return out;
  }
  for (const entry of entries) {
    const decoded = decodeOtlpAnyValue(entry.value);
    if (entry.key === 'session.id' && typeof decoded === 'string' && decoded.length > 0) {
      out[entry.key] = '<uuid>';
    } else if (entry.key === 'exception.stacktrace' && typeof decoded === 'string') {
      if (decoded === 'No stack trace available') {
        out[entry.key] = decoded;
      } else {
        const firstLine = decoded.split('\n')[0] ?? decoded;
        out[entry.key] = `${firstLine}\n    at <stack>`;
      }
    } else {
      out[entry.key] = decoded;
    }
  }
  return out;
}

/** Normalizes volatile OTLP timestamps, session UUIDs, and stack frame paths for deterministic replay. */
export function normalizeOtlpLogsBatch(
  requests: readonly RawCapturedRequest[],
): NormalizedOtlpHttpRequest[] {
  return requests.map((req) => {
    const firstResourceLog = req.body?.resourceLogs?.[0];
    const resourceAttributes = normalizeAttributeMap(firstResourceLog?.resource?.attributes);
    const scopes: NormalizedOtlpScopeLogs[] = (firstResourceLog?.scopeLogs ?? []).map((sl) => {
      const records: NormalizedOtlpLogRecord[] = (sl.logRecords ?? []).map((lr) => ({
        severityNumber: lr.severityNumber ?? 0,
        body: lr.body?.stringValue ?? null,
        attributes: normalizeAttributeMap(lr.attributes),
      }));
      return {
        scopeName: sl.scope?.name ?? '',
        records,
      };
    });
    return {
      url: req.url,
      method: req.method,
      headers: { ...req.headers },
      keepalive: req.keepalive,
      resourceAttributes,
      scopes,
    };
  });
}

let cachedReportPromise: Promise<CrashlyticsWebOfflineProbeReport> | undefined;

/**
 * Executes all offline `@firebase/crashlytics@0.2.0` (`firebase@13.4.0`) probes
 * in an isolated browser-target bundle with stubbed `fetch` (zero network egress).
 */
export async function runCrashlyticsWebOfflineProbes(options?: {
  fresh?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<CrashlyticsWebOfflineProbeReport> {
  if (options?.fresh !== true && options?.env === undefined && cachedReportPromise !== undefined) {
    return cachedReportPromise;
  }

  const execute = async (): Promise<CrashlyticsWebOfflineProbeReport> => {
    ensureCrashlyticsWebFb13Fixture(options?.env);
    const source = buildCrashlyticsWebBrowserProbeSource();
    const { fixture, result } = runBundledBrowserProbeScript<RawBrowserProbeData>(
      source,
      options?.env,
    );
    return {
      firebaseVersion: fixture.firebaseVersion,
      crashlyticsVersion: fixture.crashlyticsVersion,
      instanceContract: result.instanceContract,
      otlpOptionsContract: {
        defaultLeavesGlobalProviderUnchanged:
          result.otlpOptionsContract.defaultLeavesGlobalProviderUnchanged,
        globalProviderRegistered: result.otlpOptionsContract.globalProviderRegistered,
        globalRequests: normalizeOtlpLogsBatch(result.otlpOptionsContract.globalRequests),
        regionalRequests: normalizeOtlpLogsBatch(result.otlpOptionsContract.regionalRequests),
        customEndpointRequests: normalizeOtlpLogsBatch(
          result.otlpOptionsContract.customEndpointRequests,
        ),
      },
      browserLifecycleContract: {
        sessionIdStored: result.browserLifecycleContract.sessionIdStored,
        listenersWhenActive: result.browserLifecycleContract.listenersWhenActive,
        requestCountBeforeError: result.browserLifecycleContract.requestCountBeforeError,
        firstErrorBatch: normalizeOtlpLogsBatch(result.browserLifecycleContract.firstErrorBatch),
        secondErrorAutoFlushedBatch: normalizeOtlpLogsBatch(
          result.browserLifecycleContract.secondErrorAutoFlushedBatch,
        ),
        listenersAfterDelete: result.browserLifecycleContract.listenersAfterDelete,
        requestCountOnShutDownHandle:
          result.browserLifecycleContract.requestCountOnShutDownHandle,
        getCrashlyticsOnFreshDeletedCode:
          result.browserLifecycleContract.getCrashlyticsOnFreshDeletedCode,
        listenersWhenUnhandledDisabled:
          result.browserLifecycleContract.listenersWhenUnhandledDisabled,
      },
    };
  };

  const promise = execute();
  if (options?.fresh !== true && options?.env === undefined) {
    cachedReportPromise = promise;
  }
  return promise;
}
