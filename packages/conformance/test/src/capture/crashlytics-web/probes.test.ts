import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deleteApp, getApps, initializeApp } from 'pyric/app';
import { bindAppRegistrySandbox, resetAppRegistryForTests } from 'pyric/app/internal';
import {
  breadcrumbs,
  flush,
  getCrashlytics,
  log,
  recordError,
} from 'pyric/crashlytics';
import { getCrashlyticsBroker } from 'pyric/crashlytics/internal';
import { initializeSandbox } from 'pyric/sandbox';
import {
  ensureCrashlyticsWebFb13Fixture,
  ISOLATED_CRASHLYTICS_FIREBASE_VERSION,
  ISOLATED_CRASHLYTICS_PACKAGE_VERSION,
  normalizeOtlpLogsBatch,
  runCrashlyticsWebOfflineProbes,
  type CrashlyticsWebInstanceContractResult,
  type CrashlyticsWebOfflineProbeReport,
  type NormalizedOtlpHttpRequest,
  type NormalizedOtlpLogRecord,
  type NormalizedOtlpScopeLogs,
  type OtlpAttributeEntry,
} from '../../../../src/capture/crashlytics-web/probes.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../../../..');

afterEach(async () => {
  const activeApps = [...getApps()];
  for (const app of activeApps) {
    await deleteApp(app).catch(() => undefined);
  }
  resetAppRegistryForTests();
});

describe('isolated firebase@13.4.0 (@firebase/crashlytics@0.2.0) offline SDK probe rig', () => {
  test(
    'keeps root workspace pinned to firebase@^13.4.0 alongside the isolated firebase@13.4.0 cache',
    () => {
      const rootPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
        devDependencies?: Record<string, string>;
      };
      const rootFirebaseSpec = rootPkg.devDependencies?.firebase ?? '';
      const strippedFirebaseVersion = rootFirebaseSpec.replace(/^[\^~]/, '');
      expect(Bun.semver.satisfies(strippedFirebaseVersion, '^13.4.0')).toBe(true);

      const fixture = ensureCrashlyticsWebFb13Fixture();
      expect(fixture.firebaseVersion).toBe(ISOLATED_CRASHLYTICS_FIREBASE_VERSION);
      expect(fixture.crashlyticsVersion).toBe(ISOLATED_CRASHLYTICS_PACKAGE_VERSION);
    },
    120_000,
  );

  test(
    'captures real OTLP log contracts across global, regional, and custom endpoints with zero egress',
    async () => {
    const report: CrashlyticsWebOfflineProbeReport = await runCrashlyticsWebOfflineProbes();
    expect(report.firebaseVersion).toBe('13.4.0');
    expect(report.crashlyticsVersion).toBe('0.2.0');

    const { otlpOptionsContract } = report;
    expect(otlpOptionsContract.defaultLeavesGlobalProviderUnchanged).toBe(true);
    expect(otlpOptionsContract.globalProviderRegistered).toBe(true);

    const globalReq: NormalizedOtlpHttpRequest | undefined = otlpOptionsContract.globalRequests[0];
    expect(globalReq).toBeDefined();
    expect(globalReq?.url).toBe('https://clienttelemetry.googleapis.com/v1/logs');
    expect(globalReq?.method).toBe('POST');
    expect(globalReq?.keepalive).toBe(true);
    expect(globalReq?.headers['content-type']).toBe('application/json');
    expect(globalReq?.headers['x-goog-api-key']).toBe('probe-key-global');
    expect(globalReq?.resourceAttributes).toEqual({
      'service.name': 'firebase_telemetry_service',
      'gcp.project_id': 'demo-otlp-global',
      'gcp.firebase.app_id': '1:200:web:globalotlp',
    });

    const globalScope: NormalizedOtlpScopeLogs | undefined = globalReq?.scopes[0];
    expect(globalScope?.scopeName).toBe('custom-logger');
    const globalRecord: NormalizedOtlpLogRecord | undefined = globalScope?.records[0];
    expect(globalRecord).toEqual({
      severityNumber: 9,
      body: 'global-log-entry',
      attributes: {
        tier: 'override-log',
        tags: ['alpha', 'beta'],
        env: 'dev',
        'app.build_id': 'unset',
      },
    });

    const regionalReq = otlpOptionsContract.regionalRequests[0];
    expect(regionalReq?.url).toBe(
      'https://clienttelemetry.europe-west1.rep.googleapis.com/v1/logs',
    );
    expect(regionalReq?.resourceAttributes).toEqual({
      'service.name': 'firebase_telemetry_service',
      'gcp.project_id': 'demo-otlp-regional',
      'gcp.firebase.app_id': '1:200:web:regionalotlp',
      'cloud.region': 'europe-west1',
    });
    const errorScope = regionalReq?.scopes.find((s) => s.scopeName === 'error-logger');
    expect(errorScope?.records).toEqual([
      {
        severityNumber: 17,
        body: 'regional-type-failure',
        attributes: {
          'exception.type': 'TypeError',
          'exception.stacktrace': 'No stack trace available',
          'exception.message': 'regional-type-failure',
          shared: 'from-call',
          attempt: 3,
          env: 'prod',
          'app.build_id': '2.4.1',
        },
      },
      {
        severityNumber: 17,
        body: 'plain-string-error',
        attributes: {
          env: 'prod',
          shared: 'from-options',
          'app.build_id': '2.4.1',
        },
      },
      {
        severityNumber: 17,
        body: 'Unknown error type: object',
        attributes: {
          env: 'prod',
          shared: 'from-options',
          'app.build_id': '2.4.1',
        },
      },
      {
        severityNumber: 17,
        body: 'Unknown error type: number',
        attributes: {
          env: 'prod',
          shared: 'from-options',
          'app.build_id': '2.4.1',
        },
      },
    ]);

    const customEpReq = otlpOptionsContract.customEndpointRequests[0];
    expect(customEpReq?.url).toBe('http://127.0.0.1:4318/v1/logs');
    expect(customEpReq?.resourceAttributes['cloud.region']).toBe('us-east1');
    expect(customEpReq?.scopes.map((s) => s.scopeName)).toContain('external-otel-scope');

    const sampleAttr: OtlpAttributeEntry = {
      key: 'session.id',
      value: { stringValue: 'abc-123' },
    };
    const normalizedSynthetic = normalizeOtlpLogsBatch([
      {
        url: 'http://127.0.0.1:4318/v1/logs',
        method: 'POST',
        headers: {},
        keepalive: true,
        body: {
          resourceLogs: [
            {
              resource: { attributes: [sampleAttr] },
              scopeLogs: [],
            },
          ],
        },
      },
    ]);
    expect(normalizedSynthetic[0]?.resourceAttributes['session.id']).toBe('<uuid>');
    },
    120_000,
  );

  test(
    'verifies differential parity between real @firebase/crashlytics@0.2.0 and pyric/crashlytics',
    async () => {
    const report = await runCrashlyticsWebOfflineProbes();
    const realInst: CrashlyticsWebInstanceContractResult = report.instanceContract;

    // 1. Instance caching, breadcrumbs() shape, and conflicting-options rejection
    const pyricCrumb = breadcrumbs();
    expect(Object.keys(pyricCrumb)).toEqual(realInst.breadcrumbFeatureKeys);
    expect((pyricCrumb as { name?: string }).name).toBe(realInst.breadcrumbFeatureName);

    const appSandbox = initializeSandbox();
    bindAppRegistrySandbox(appSandbox);
    try {
      const sharedParityConfig = {
        projectId: 'parity-crashlytics-web',
        appId: '1:900:web:paritycfg',
      };
      const pyricDefaultApp = initializeApp(sharedParityConfig, 'parity-default-app');
      const pyricDefaultHandle = getCrashlytics(pyricDefaultApp);
      expect(getCrashlytics(pyricDefaultApp, {}) === pyricDefaultHandle).toBe(
        realInst.defaultSameEmpty,
      );
      expect(getCrashlytics(pyricDefaultApp) === pyricDefaultHandle).toBe(
        realInst.defaultSameOmitted,
      );

      const pyricConfiguredApp = initializeApp(sharedParityConfig, 'parity-configured-app');
      const pyricConfiguredHandle = getCrashlytics(pyricConfiguredApp, {
        appVersion: '3.1.0',
        customAttributes: { surface: 'checkout' },
        features: [breadcrumbs()],
      });
      expect(
        getCrashlytics(pyricConfiguredApp, {
          appVersion: '3.1.0',
          customAttributes: { surface: 'checkout' },
          features: [breadcrumbs()],
        }) === pyricConfiguredHandle,
      ).toBe(realInst.namedSameOptions);

      let pyricOmittedErr: string | null = null;
      try {
        getCrashlytics(pyricConfiguredApp);
      } catch (err) {
        pyricOmittedErr = err instanceof Error ? err.message : String(err);
      }
      expect(pyricOmittedErr).toBe(realInst.omittedAfterOptionsError);

      let pyricMismatchErr: string | null = null;
      try {
        getCrashlytics(pyricConfiguredApp, { appVersion: '9.9.9' });
      } catch (err) {
        pyricMismatchErr = err instanceof Error ? err.message : String(err);
      }
      expect(pyricMismatchErr).toBe(realInst.mismatchedOptionsError);

      // 2. Browser breadcrumbs buffering, deduplication, auto-flush, and deleteApp lifecycle
      const realLife = report.browserLifecycleContract;
      expect(realLife.sessionIdStored).toBe(true);
      expect(realLife.requestCountBeforeError).toBe(0);
      expect(realLife.listenersWhenActive.error).toBe(1);
      expect(realLife.listenersWhenActive.unhandledrejection).toBe(1);
      expect(realLife.listenersWhenUnhandledDisabled.error ?? 0).toBe(0);
      expect(realLife.listenersWhenUnhandledDisabled.unhandledrejection ?? 0).toBe(0);

      const firstBatchScopes = realLife.firstErrorBatch.flatMap((req) => req.scopes);
      const firstErrorRecords =
        firstBatchScopes.find((s) => s.scopeName === 'error-logger')?.records ?? [];
      expect(firstErrorRecords.map((r) => r.body)).toEqual([
        'caught-and-rethrown-error',
        'unhandled-rejection-boom',
      ]);
      const firstCustomLogs =
        firstBatchScopes.find((s) => s.scopeName === 'custom-logger')?.records ?? [];
      expect(firstCustomLogs.map((r) => r.body)).toEqual(['crumb-one']);
      const firstVisibilityLogs =
        firstBatchScopes.find((s) => s.scopeName === 'visibility-logger')?.records ?? [];
      expect(firstVisibilityLogs.map((r) => r.body)).toEqual(['Foreground lifecycle event']);

      const secondBatchScopes = realLife.secondErrorAutoFlushedBatch.flatMap((req) => req.scopes);
      const secondCustomLogs =
        secondBatchScopes.find((s) => s.scopeName === 'custom-logger')?.records ?? [];
      expect(secondCustomLogs.map((r) => r.body)).toEqual(['crumb-after-first-error']);

      expect(realLife.listenersAfterDelete).toEqual({
        load: 0,
        pagehide: 0,
        visibilitychange: 0,
        error: 0,
        unhandledrejection: 0,
      });
      expect(realLife.requestCountOnShutDownHandle).toBe(0);
      expect(realLife.getCrashlyticsOnFreshDeletedCode).toBe('app/app-deleted');

      // Mirror the same sequence on pyric/crashlytics:
      log(pyricConfiguredHandle, 'crumb-one', { step: 1 });
      recordError(pyricConfiguredHandle, new Error('caught-and-rethrown-error'), { handled: true });
      log(pyricConfiguredHandle, 'crumb-after-first-error', { step: 2 });
      recordError(pyricConfiguredHandle, new Error('second-distinct-error'));
      await flush(pyricConfiguredHandle);

      const broker = getCrashlyticsBroker(appSandbox);
      const pyricState = broker.getState('1:900:web:paritycfg');
      expect(pyricState.reports).toHaveLength(2);
      expect(pyricState.reports[0]?.breadcrumbs.map((b) => b.message)).toEqual(['crumb-one']);
      expect(pyricState.reports[1]?.breadcrumbs.map((b) => b.message)).toEqual([
        'crumb-after-first-error',
      ]);

      await deleteApp(pyricConfiguredApp);
      let pyricDeletedCode: string | null = null;
      try {
        getCrashlytics(pyricConfiguredApp);
      } catch (err) {
        pyricDeletedCode = (err as { code?: string }).code ?? null;
      }
      expect(pyricDeletedCode).toBe(realLife.getCrashlyticsOnFreshDeletedCode);

      log(pyricConfiguredHandle, 'post-delete-log');
      recordError(pyricConfiguredHandle, new Error('post-delete-error'));
      await flush(pyricConfiguredHandle);
      expect(broker.getState('1:900:web:paritycfg').reports).toHaveLength(2);
    } finally {
      appSandbox.dispose();
    }
    },
    120_000,
  );
});
