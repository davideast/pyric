import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { deleteApp, initializeApp, type FirebaseOptions } from 'pyric/app';
import { bindAppRegistrySandbox, resetAppRegistryForTests } from 'pyric/app/internal';
import {
  breadcrumbs,
  flush,
  getCrashlytics,
  log,
  recordError,
} from 'pyric/crashlytics';
import { getCrashlyticsBroker } from 'pyric/crashlytics/internal';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import {
  buildCrashlyticsWebObservations,
  CRASHLYTICS_WEB_OBSERVATIONS_DIR,
  writeCrashlyticsWebObservations,
} from '../../../../src/capture/crashlytics-web/observations.ts';
import { runCrashlyticsWebOfflineProbes } from '../../../../src/capture/crashlytics-web/probes.ts';
import { checkObservationVersionProblems } from '../../../../src/check-observation-versions.ts';
import { loadObservations } from '../../../../src/ledger.ts';
import { createObservationGate } from '../../../../src/observation-gate.ts';

const SHARED_APP_CONFIG: FirebaseOptions = {
  apiKey: 'fake-key-replay',
  projectId: 'demo-crashlytics-replay',
  appId: '1:777:web:crashlyticsreplay',
};

const gate = createObservationGate({
  dir: CRASHLYTICS_WEB_OBSERVATIONS_DIR,
  match: (file) => file.startsWith('crashlytics-web-'),
});

interface FakeListenerTarget {
  target: EventTarget;
  activeCount(type: string): number;
}

function makeTrackedTarget(): FakeListenerTarget {
  const inner = new EventTarget();
  const counts = new Map<string, number>();
  const proxy = {
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (listener !== null) {
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      inner.addEventListener(type, listener, options);
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (listener !== null) {
        const next = (counts.get(type) ?? 1) - 1;
        counts.set(type, Math.max(0, next));
      }
      inner.removeEventListener(type, listener, options);
    },
    dispatchEvent(event: Event): boolean {
      return inner.dispatchEvent(event);
    },
  };
  return {
    target: proxy as unknown as EventTarget,
    activeCount(type: string): number {
      return counts.get(type) ?? 0;
    },
  };
}

describe('Crashlytics web oracle observation replay', () => {
  let activeSandbox: LocalSandbox | undefined;
  const savedWindow = (globalThis as Record<string, unknown>).window;
  const savedDocument = (globalThis as Record<string, unknown>).document;

  afterEach(() => {
    resetAppRegistryForTests();
    if (activeSandbox !== undefined) {
      activeSandbox.dispose();
      activeSandbox = undefined;
    }
    if (savedWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = savedWindow;
    }
    if (savedDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = savedDocument;
    }
  });

  afterAll(() => {
    const report = gate.report();
    expect(report.committed.length).toBe(3);
    expect(report.uncovered).toEqual([]);
  });

  test('replays crashlytics-web-instance-and-options against pyric/crashlytics', () => {
    const observed = gate.load('crashlytics-web-instance-and-options');
    const feature = breadcrumbs() as unknown as Record<string, unknown>;
    expect(Object.keys(feature)).toEqual(observed.breadcrumbFeatureKeys);
    expect(feature.name).toBe(observed.breadcrumbFeatureName);

    activeSandbox = initializeSandbox();
    bindAppRegistrySandbox(activeSandbox);

    const defaultApp = initializeApp(SHARED_APP_CONFIG);
    const firstDefault = getCrashlytics(defaultApp);
    expect(getCrashlytics(defaultApp, {}) === firstDefault).toBe(observed.defaultSameEmpty);
    expect(getCrashlytics(defaultApp) === firstDefault).toBe(observed.defaultSameOmitted);

    const configuredApp = initializeApp(SHARED_APP_CONFIG, 'configured');
    const configuredOptions = {
      appVersion: '2.4.1',
      region: 'us-central1',
      customAttributes: { env: 'staging', build: 42 },
      features: [breadcrumbs()],
    };
    const configuredFirst = getCrashlytics(configuredApp, configuredOptions);
    const configuredSecond = getCrashlytics(configuredApp, {
      appVersion: '2.4.1',
      region: 'us-central1',
      customAttributes: { env: 'staging', build: 42 },
      features: [breadcrumbs()],
    });
    expect(configuredSecond === configuredFirst).toBe(observed.namedSameOptions);
    expect(configuredFirst !== firstDefault).toBe(observed.distinctAppsIsolated);

    let omittedError: string | null = null;
    try {
      getCrashlytics(configuredApp);
    } catch (err) {
      omittedError = (err as Error).message;
    }
    expect(omittedError).toBe(observed.omittedAfterOptionsError);

    let mismatchError: string | null = null;
    try {
      getCrashlytics(configuredApp, { appVersion: '9.9.9' });
    } catch (err) {
      mismatchError = (err as Error).message;
    }
    expect(mismatchError).toBe(observed.mismatchedOptionsError);
  });

  test('replays crashlytics-web-otlp-endpoints-and-attributes against pyric/crashlytics', async () => {
    const observed = gate.load('crashlytics-web-otlp-endpoints-and-attributes');
    expect(observed.defaultLeavesGlobalProviderUnchanged).toBe(true);
    expect(observed.globalProviderRegistered).toBe(true);
    expect(observed.globalEndpointUrl).toBe('https://clienttelemetry.googleapis.com/v1/logs');
    expect(observed.regionalEndpointUrl).toBe(
      'https://clienttelemetry.europe-west1.rep.googleapis.com/v1/logs',
    );
    expect(observed.customEndpointNormalizedUrl).toBe('http://127.0.0.1:4318/v1/logs');

    activeSandbox = initializeSandbox();
    bindAppRegistrySandbox(activeSandbox);

    const globalApp = initializeApp(SHARED_APP_CONFIG, 'global-replay');
    const globalHandle = getCrashlytics(globalApp, {
      customAttributes: { env: 'dev', tier: 'base' },
    });
    log(globalHandle, 'global-log-entry', {
      tier: 'override-log',
      tags: ['alpha', 'beta'],
    });
    recordError(globalHandle, new Error('no-breadcrumbs-feature'));
    await flush(globalHandle);

    const broker = getCrashlyticsBroker(activeSandbox);
    const sharedKey = '1:777:web:crashlyticsreplay';
    const afterGlobal = broker.getState(sharedKey);
    expect(afterGlobal.logs[0]?.message).toBe('global-log-entry');
    expect(afterGlobal.logs[0]?.attributes).toEqual({
      env: 'dev',
      tier: 'override-log',
      tags: '["alpha","beta"]',
    });
    expect(afterGlobal.reports[0]?.breadcrumbs).toEqual([]);

    const regionalApp = initializeApp(SHARED_APP_CONFIG, 'regional-replay');
    const regionalHandle = getCrashlytics(regionalApp, {
      region: 'europe-west1',
      appVersion: '2.4.1',
      endpointUrl: 'http://127.0.0.1:4318///',
      customAttributes: { env: 'prod', shared: 'from-options' },
    });
    const noStackError = new TypeError('regional-type-failure');
    noStackError.stack = '';
    recordError(regionalHandle, noStackError, { shared: 'from-call', attempt: 3 });
    recordError(regionalHandle, 'plain-string-error');
    recordError(regionalHandle, { unexpected: true });
    recordError(regionalHandle, 404);
    await flush(regionalHandle);

    const state = broker.getState(sharedKey);
    const reports = state.reports.slice(1);
    expect(reports[0]?.name).toBe('TypeError');
    expect(reports[0]?.message).toBe('regional-type-failure');
    expect(reports[0]?.stack).toBe('No stack trace available');
    expect(reports[0]?.attributes).toEqual({
      env: 'prod',
      shared: 'from-call',
      attempt: 3,
    });
    expect(reports[1]?.message).toBe('plain-string-error');
    expect(reports[2]?.message).toBe('Unknown error type: object');
    expect(reports[3]?.message).toBe('Unknown error type: number');

    let externalEndpointCode: string | null = null;
    try {
      const blockedApp = initializeApp(SHARED_APP_CONFIG, 'blocked-endpoint');
      getCrashlytics(blockedApp, {
        endpointUrl: String(observed.globalEndpointUrl),
      });
    } catch (err) {
      externalEndpointCode = (err as { code?: string }).code ?? null;
    }
    expect(externalEndpointCode).toBe('crashlytics/invalid-endpoint');
  });

  test('replays crashlytics-web-browser-lifecycle-and-breadcrumbs against pyric/crashlytics', async () => {
    const observed = gate.load('crashlytics-web-browser-lifecycle-and-breadcrumbs');
    expect(observed.clearsBreadcrumbsAfterRecordError).toBe(true);
    expect(observed.deduplicatesAlreadyLoggedUnhandledError).toBe(true);
    expect(observed.autoFlushesOnVisibilityHidden).toBe(true);
    expect(observed.shutDownHandleNoOpsAfterDeleteApp).toBe(true);

    const winTracker = makeTrackedTarget();
    const docTracker = makeTrackedTarget();
    let visibilityState = 'visible';
    Object.defineProperty(winTracker.target, 'location', {
      configurable: true,
      value: { pathname: '/checkout', hash: '' },
    });
    Object.defineProperty(docTracker.target, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });
    (globalThis as Record<string, unknown>).window = winTracker.target;
    (globalThis as Record<string, unknown>).document = docTracker.target;

    activeSandbox = initializeSandbox();
    bindAppRegistrySandbox(activeSandbox);
    const app = initializeApp(SHARED_APP_CONFIG, 'browser-lifecycle');
    const crashlytics = getCrashlytics(app, {
      appVersion: '3.1.0',
      customAttributes: { surface: 'checkout' },
      features: [breadcrumbs()],
    });

    expect(winTracker.activeCount('error')).toBe(1);
    expect(winTracker.activeCount('unhandledrejection')).toBe(1);
    expect(winTracker.activeCount('pagehide')).toBe(1);
    expect(docTracker.activeCount('visibilitychange')).toBe(1);

    log(crashlytics, 'crumb-one', { step: 1 });
    docTracker.target.dispatchEvent(new Event('visibilitychange'));

    const rethrown = new Error('caught-and-rethrown-error');
    recordError(crashlytics, rethrown, { handled: true });
    const dupErrEvent = new Event('error') as Event & { error?: unknown; message?: string };
    dupErrEvent.error = rethrown;
    dupErrEvent.message = rethrown.message;
    winTracker.target.dispatchEvent(dupErrEvent);

    const unhandledRejEvent = new Event('unhandledrejection') as Event & { reason?: unknown };
    unhandledRejEvent.reason = new RangeError('unhandled-rejection-boom');
    winTracker.target.dispatchEvent(unhandledRejEvent);
    await flush(crashlytics);

    log(crashlytics, 'crumb-after-first-error', { step: 2 });
    recordError(crashlytics, new Error('second-distinct-error'));
    visibilityState = 'hidden';
    docTracker.target.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 10));

    const broker = getCrashlyticsBroker(activeSandbox);
    const sharedKey = '1:777:web:crashlyticsreplay';
    const state = broker.getState(sharedKey);
    expect(state.reports.map((r) => r.message)).toEqual([
      'caught-and-rethrown-error',
      'unhandled-rejection-boom',
      'second-distinct-error',
    ]);
    expect(state.reports[0]?.breadcrumbs.map((b) => b.message)).toEqual([
      'crumb-one',
      'visibility:visible',
    ]);
    expect(state.reports[1]?.fatal).toBe(true);
    expect(state.reports[1]?.breadcrumbs).toEqual([]);
    expect(state.reports[2]?.breadcrumbs.map((b) => b.message)).toEqual([
      'crumb-after-first-error',
    ]);
    expect(state.reports[2]?.flushed).toBe(true);

    await deleteApp(app);
    expect(winTracker.activeCount('error')).toBe(0);
    expect(winTracker.activeCount('unhandledrejection')).toBe(0);
    expect(winTracker.activeCount('pagehide')).toBe(0);
    expect(docTracker.activeCount('visibilitychange')).toBe(0);

    const countBeforeShutDownCalls = broker.getState(sharedKey).reports.length;
    log(crashlytics, 'ignored-after-delete');
    recordError(crashlytics, new Error('ignored-after-delete'));
    await flush(crashlytics);
    expect(broker.getState(sharedKey).reports.length).toBe(countBeforeShutDownCalls);

    const freshDeleted = initializeApp(SHARED_APP_CONFIG, 'fresh-deleted');
    await deleteApp(freshDeleted);
    let freshCode: string | null = null;
    try {
      getCrashlytics(freshDeleted);
    } catch (err) {
      freshCode = (err as { code?: string }).code ?? null;
    }
    expect(freshCode).toBe(observed.getCrashlyticsOnFreshDeletedCode);
  });

  test(
    'matches live isolated firebase@13.4.0 probe output against committed observation JSON',
    async () => {
      const liveReport = await runCrashlyticsWebOfflineProbes();
      const freshDocs = buildCrashlyticsWebObservations(liveReport);
      for (const doc of freshDocs) {
        const committed = gate.load(doc.name);
        expect(doc.behavior).toEqual(committed);
      }

      const writtenFiles = new Map<string, string>();
      const writtenDocs = await writeCrashlyticsWebObservations({
        fresh: false,
        observedAt: '2026-11-24T00:00:00.000Z',
        mkdir: () => {},
        writeFile: (path, content) => {
          writtenFiles.set(path, content);
        },
      });
      expect(writtenDocs).toHaveLength(3);
      expect(writtenFiles.size).toBe(3);

      const crashlyticsObservations = loadObservations().filter(
        (obs) => obs.surfaceDir === 'crashlytics',
      );
      expect(crashlyticsObservations).toHaveLength(3);
      expect(checkObservationVersionProblems(crashlyticsObservations)).toEqual({
        missing: [],
        mismatched: [],
      });
      const tampered = crashlyticsObservations.map((obs) => {
        if (obs.name === 'crashlytics-web-instance-and-options') {
          return { ...obs, raw: { ...obs.raw, fbSdkVersion: '12.19.0' } };
        }
        return obs;
      });
      expect(checkObservationVersionProblems(tampered).mismatched).toEqual([
        {
          file: 'crashlytics-web-instance-and-options.json [fbSdkVersion]',
          got: '12.19.0',
          want: '13.4.0',
        },
      ]);
    },
    120_000,
  );
});
