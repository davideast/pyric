/**
 * Deterministic observation builder and writer for the isolated
 * `@firebase/crashlytics@0.2.0` (`firebase@13.4.0`) offline SDK probe rig.
 *
 * Writes version-stamped JSON records under
 * `packages/conformance/observations/crashlytics/crashlytics-web-*.json`
 * while preserving committed `matrixRow` and `rowIds` linkage when present.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readObservationLinkage } from '../../observation-linkage.ts';
import {
  runCrashlyticsWebOfflineProbes,
  type CrashlyticsWebOfflineProbeReport,
} from './probes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CRASHLYTICS_WEB_OBSERVATIONS_DIR = join(
  HERE,
  '..',
  '..',
  '..',
  'observations',
  'crashlytics',
);

export interface CrashlyticsWebObservationDocument {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  observedAt: string;
  fbSdkVersion: string;
  crashlyticsSdkVersion: string;
  behavior: Record<string, unknown>;
}

interface ObservationSeed {
  name: string;
  defaultMatrixRow: string;
  defaultRowIds: string[];
  description: string;
  behavior: Record<string, unknown>;
}

function resolveLinkage(
  outDir: string,
  seed: ObservationSeed,
): { matrixRow: string; rowIds: string[] } {
  const existing = readObservationLinkage(join(outDir, `${seed.name}.json`));
  let matrixRow = seed.defaultMatrixRow;
  if (existing.matrixRow !== '') {
    matrixRow = existing.matrixRow;
  }
  let rowIds = [...seed.defaultRowIds];
  if (existing.rowIds.length > 0) {
    rowIds = existing.rowIds;
  }
  return { matrixRow, rowIds };
}

/**
 * Projects a live `CrashlyticsWebOfflineProbeReport` into the three canonical
 * version-stamped `crashlytics-web-*.json` observation documents.
 */
export function buildCrashlyticsWebObservations(
  report: CrashlyticsWebOfflineProbeReport,
  options?: {
    observedAt?: string;
    observationsDir?: string;
  },
): CrashlyticsWebObservationDocument[] {
  const observedAt = options?.observedAt ?? new Date().toISOString();
  const outDir = options?.observationsDir ?? CRASHLYTICS_WEB_OBSERVATIONS_DIR;

  const globalReq = report.otlpOptionsContract.globalRequests[0];
  const regionalReq = report.otlpOptionsContract.regionalRequests[0];
  const customReq = report.otlpOptionsContract.customEndpointRequests[0];

  const firstBatchScopes = report.browserLifecycleContract.firstErrorBatch[0]?.scopes ?? [];
  const firstErrorScope = firstBatchScopes.find((s) => s.scopeName === 'error-logger');
  const secondBatchScopes =
    report.browserLifecycleContract.secondErrorAutoFlushedBatch[0]?.scopes ?? [];
  const secondCustomScope = secondBatchScopes.find((s) => s.scopeName === 'custom-logger');

  const clearedPriorBreadcrumb =
    (secondCustomScope?.records.some((r) => r.body === 'crumb-one') ?? false) === false &&
    (secondCustomScope?.records.some((r) => r.body === 'crumb-after-first-error') ?? false) ===
      true;
  const deduplicatedRethrownError =
    (firstErrorScope?.records.filter((r) => r.body === 'caught-and-rethrown-error').length ?? 0) ===
    1;
  const autoFlushedOnHidden =
    report.browserLifecycleContract.secondErrorAutoFlushedBatch.length === 1;

  const seeds: ObservationSeed[] = [
    {
      name: 'crashlytics-web-instance-and-options',
      defaultMatrixRow: 'crashlytics#get-crashlytics-and-module-swap',
      defaultRowIds: ['crashlytics#get-crashlytics-and-module-swap'],
      description:
        'Offline @firebase/crashlytics@0.2.0 (firebase@13.4.0) browser-bundle capture of getCrashlytics(app, options) per-app singleton caching, breadcrumbs() feature descriptor shape ({ name: "breadcrumbs" }), and strict repeat-call option equality enforcement.',
      behavior: {
        ...report.instanceContract,
      },
    },
    {
      name: 'crashlytics-web-otlp-endpoints-and-attributes',
      defaultMatrixRow: 'crashlytics#record-error-and-attribute-precedence',
      defaultRowIds: [
        'crashlytics#local-broker-and-shared-worker-routing',
        'crashlytics#log-and-breadcrumbs-feature',
        'crashlytics#record-error-and-attribute-precedence',
        'crashlytics#flush-and-state-inspection',
        'crashlytics#endpoint-url-loopback-guard',
      ],
      description:
        'Offline @firebase/crashlytics@0.2.0 (firebase@13.4.0) browser-bundle OTLP ExportLogsServiceRequest capture with stubbed fetch (zero network egress) across global, regional, and loopback custom endpointUrl configurations, verifying appVersion, customAttributes precedence, registerGlobalLoggerProvider, direct custom-logger batching without breadcrumbs(), and Error/string/non-Error formatting.',
      behavior: {
        defaultLeavesGlobalProviderUnchanged:
          report.otlpOptionsContract.defaultLeavesGlobalProviderUnchanged,
        globalProviderRegistered: report.otlpOptionsContract.globalProviderRegistered,
        globalEndpointUrl: globalReq?.url ?? null,
        regionalEndpointUrl: regionalReq?.url ?? null,
        customEndpointNormalizedUrl: customReq?.url ?? null,
        globalRequests: report.otlpOptionsContract.globalRequests,
        regionalRequests: report.otlpOptionsContract.regionalRequests,
        customEndpointRequests: report.otlpOptionsContract.customEndpointRequests,
      },
    },
    {
      name: 'crashlytics-web-browser-lifecycle-and-breadcrumbs',
      defaultMatrixRow: 'crashlytics#unhandled-window-errors-and-deleted-app-guard',
      defaultRowIds: [
        'crashlytics#log-and-breadcrumbs-feature',
        'crashlytics#browser-navigation-and-visibility-breadcrumbs',
        'crashlytics#record-error-and-attribute-precedence',
        'crashlytics#unhandled-window-errors-and-deleted-app-guard',
      ],
      description:
        'Offline @firebase/crashlytics@0.2.0 (firebase@13.4.0) browser-bundle capture of session-id creation, breadcrumbs() on-error buffering and post-error clearing, window error and unhandledrejection listeners with ALREADY_LOGGED_FLAG deduplication, visibilitychange/pagehide auto-flush, captureUnhandledErrors: false opt-out, and deleteApp() listener teardown plus shut-down handle no-op vs fresh app/app-deleted.',
      behavior: {
        sessionIdStored: report.browserLifecycleContract.sessionIdStored,
        listenersWhenActive: report.browserLifecycleContract.listenersWhenActive,
        requestCountBeforeError: report.browserLifecycleContract.requestCountBeforeError,
        firstBatchScopeNames: firstBatchScopes.map((s) => s.scopeName),
        clearsBreadcrumbsAfterRecordError: clearedPriorBreadcrumb,
        deduplicatesAlreadyLoggedUnhandledError: deduplicatedRethrownError,
        autoFlushesOnVisibilityHidden: autoFlushedOnHidden,
        shutDownHandleNoOpsAfterDeleteApp:
          report.browserLifecycleContract.requestCountOnShutDownHandle === 0,
        firstErrorBatch: report.browserLifecycleContract.firstErrorBatch,
        secondErrorAutoFlushedBatch:
          report.browserLifecycleContract.secondErrorAutoFlushedBatch,
        listenersAfterDelete: report.browserLifecycleContract.listenersAfterDelete,
        requestCountOnShutDownHandle:
          report.browserLifecycleContract.requestCountOnShutDownHandle,
        getCrashlyticsOnFreshDeletedCode:
          report.browserLifecycleContract.getCrashlyticsOnFreshDeletedCode,
        listenersWhenUnhandledDisabled:
          report.browserLifecycleContract.listenersWhenUnhandledDisabled,
      },
    },
  ];

  return seeds.map((seed) => {
    const linkage = resolveLinkage(outDir, seed);
    return {
      name: seed.name,
      matrixRow: linkage.matrixRow,
      rowIds: linkage.rowIds,
      description: seed.description,
      observedAt,
      fbSdkVersion: report.firebaseVersion,
      crashlyticsSdkVersion: report.crashlyticsVersion,
      behavior: seed.behavior,
    };
  });
}

/**
 * Runs the isolated `firebase@13.4.0` offline Crashlytics web probe rig and
 * writes the three version-stamped observation JSON files.
 */
export async function writeCrashlyticsWebObservations(options?: {
  observationsDir?: string;
  observedAt?: string;
  fresh?: boolean;
  env?: NodeJS.ProcessEnv;
  mkdir?: (dir: string) => void;
  writeFile?: (filePath: string, content: string) => void;
}): Promise<CrashlyticsWebObservationDocument[]> {
  const outDir = options?.observationsDir ?? CRASHLYTICS_WEB_OBSERVATIONS_DIR;
  const report = await runCrashlyticsWebOfflineProbes({
    fresh: options?.fresh ?? true,
    env: options?.env,
  });
  const docs = buildCrashlyticsWebObservations(report, {
    observedAt: options?.observedAt,
    observationsDir: outDir,
  });
  const mkdirFn = options?.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const writeFileFn = options?.writeFile ?? ((filePath: string, content: string) => writeFileSync(filePath, content));
  mkdirFn(outDir);
  for (const doc of docs) {
    writeFileFn(join(outDir, `${doc.name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return docs;
}
