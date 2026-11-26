import { afterEach, describe, expect, test } from 'bun:test';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { bindAppRegistrySandbox, resetAppRegistryForTests } from '../../src/app/internal.js';
import {
  breadcrumbs,
  flush,
  getCrashlytics,
  log,
  recordError,
} from '../../src/crashlytics/index.js';
import {
  areCrashlyticsOptionsEqual,
  assertMatchingCrashlyticsOptions,
  getCrashlyticsBroker,
  isCrashlyticsSnapshot,
} from '../../src/crashlytics/internal.js';
import {
  captureCheckpoint,
  restoreCheckpoint,
} from '../../src/sandbox/checkpoints/index.js';
import { applyFullState, captureFullState, initializeSandbox } from '../../src/sandbox/index.js';
import { SandboxImpl } from '../../src/sandbox/internal/sandbox-impl.js';
import {
  persistedServiceHasData,
  validatePersistedService,
} from '../../src/sandbox/persistence/validate-services.js';

afterEach(async () => {
  const activeApps = [...getApps()];
  for (const app of activeApps) {
    await deleteApp(app).catch(() => undefined);
  }
  resetAppRegistryForTests();
});

describe('pyric/crashlytics Web SDK mirror and shared CrashlyticsBroker', () => {
  test('enforces per-app option equality, buffers and clears breadcrumbs on error, and flushes reports', async () => {
    const sharedConfig = {
      projectId: 'demo-crashlytics-web',
      appId: '1:100000000000:web:crashlyticsdemo01',
    };
    const app = initializeApp(sharedConfig);
    const feature = breadcrumbs();
    expect(Object.keys(feature)).toEqual(['name']);
    expect((feature as { name?: string }).name).toBe('breadcrumbs');

    const crashlytics = getCrashlytics(app, {
      appVersion: '2.4.1',
      region: 'us-central1',
      customAttributes: {
        env: 'staging',
        tier: 'pro',
        tags: ['checkout', 'web'],
      },
      features: [feature],
    });
    expect(crashlytics.app).toBe(app);
    expect(
      getCrashlytics(app, {
        appVersion: '2.4.1',
        region: 'us-central1',
        customAttributes: {
          tier: 'pro',
          env: 'staging',
          tags: ['checkout', 'web'],
        },
        features: [breadcrumbs()],
      }),
    ).toBe(crashlytics);
    expect(() => getCrashlytics(app)).toThrow(
      'getCrashlytics() cannot be called with different options',
    );
    expect(() => getCrashlytics(app, { appVersion: '9.9.9' })).toThrow(
      'getCrashlytics() cannot be called with different options',
    );
    expect(() => assertMatchingCrashlyticsOptions(crashlytics, { appVersion: '9.9.9' })).toThrow(
      'getCrashlytics() cannot be called with different options',
    );
    expect(areCrashlyticsOptionsEqual(undefined, {})).toBe(true);

    const defaultOptsApp = initializeApp(sharedConfig, 'default-opts-app');
    const defaultHandle = getCrashlytics(defaultOptsApp);
    expect(getCrashlytics(defaultOptsApp, {})).toBe(defaultHandle);

    log(crashlytics, 'checkout-started', { step: 1 });
    log(crashlytics, 'payment-submitted', { env: 'override-log', retry: false });

    const rootCause = new Error('card-gateway-timeout');
    const checkoutErr = Object.assign(new Error('checkout-failed', { cause: rootCause }), {
      code: 'ERR_GATEWAY_504',
    });
    recordError(crashlytics, checkoutErr, {
      tier: 'enterprise',
      attempt: 2,
    });
    log(crashlytics, 'retry-scheduled', { step: 2 });
    recordError(crashlytics, 'plain-string-failure');
    recordError(crashlytics, { status: 503 });
    recordError(crashlytics, 404);
    await flush(crashlytics);

    const secondarySandbox = initializeSandbox();
    try {
      const withCrumbsSandbox = initializeSandbox();
      try {
        const crumbsHandle = getCrashlytics(withCrumbsSandbox, {
          appVersion: '2.0.0',
          features: [breadcrumbs()],
        });
        log(crumbsHandle, 'step-a');
        log(crumbsHandle, 'step-b');
        recordError(crumbsHandle, new Error('first-error'));
        log(crumbsHandle, 'step-c');
        recordError(crumbsHandle, new Error('second-error'));
        await flush(crumbsHandle);

        const crumbsState = getCrashlyticsBroker(withCrumbsSandbox).getState('default');
        expect(crumbsState.reports).toHaveLength(2);
        expect(crumbsState.reports[0]?.breadcrumbs.map((b) => b.message)).toEqual([
          'step-a',
          'step-b',
        ]);
        expect(crumbsState.reports[1]?.breadcrumbs.map((b) => b.message)).toEqual(['step-c']);
      } finally {
        withCrumbsSandbox.dispose();
      }

      const directCrashlytics = getCrashlytics(secondarySandbox, {
        appVersion: '1.0.0',
        customAttributes: { service: 'cart', retries: 0 },
      });
      log(directCrashlytics, 'item-added', { sku: 'widget-9' });
      recordError(directCrashlytics, checkoutErr, { retries: 3 });
      recordError(directCrashlytics, { code: 'RAW_OBJ' });
      recordError(directCrashlytics, 7);

      const broker = getCrashlyticsBroker(secondarySandbox);
      const beforeFlush = broker.getState('default');
      expect(beforeFlush.logs).toHaveLength(1);
      expect(beforeFlush.reports).toHaveLength(3);
      expect(beforeFlush.reports[0]?.flushed).toBe(false);

      await flush(directCrashlytics);
      const afterFlush = broker.getState('default');
      expect(afterFlush.reports[0]?.flushed).toBe(true);
      expect(afterFlush.reports[0]?.name).toBe('Error');
      expect(afterFlush.reports[0]?.message).toBe('checkout-failed');
      expect(afterFlush.reports[0]?.code).toBe('ERR_GATEWAY_504');
      expect(afterFlush.reports[0]?.cause).toBe('Error: card-gateway-timeout');
      expect(afterFlush.reports[0]?.appVersion).toBe('1.0.0');
      expect(afterFlush.reports[0]?.sdkPlatform).toBe('web');
      expect(afterFlush.reports[0]?.attributes).toEqual({
        service: 'cart',
        retries: 3,
      });
      expect(afterFlush.reports[0]?.breadcrumbs).toEqual([]);
      expect(afterFlush.reports[1]?.message).toBe('Unknown error type: object');
      expect(afterFlush.reports[2]?.message).toBe('Unknown error type: number');
    } finally {
      secondarySandbox.dispose();
    }
  });

  test('validates endpointUrl strictly against loopback or local paths and refuses external hosts', () => {
    const sandbox = initializeSandbox();
    try {
      expect(() =>
        getCrashlytics(sandbox, { endpointUrl: 'https://crashlytics.googleapis.com/v1/traces' }),
      ).toThrow(/Refusing off-machine endpointUrl/);

      expect(() =>
        getCrashlytics(sandbox, { endpointUrl: 'https://collector.example.com/otel' }),
      ).toThrow(/crashlytics\/invalid-endpoint/);

      expect(() =>
        getCrashlytics(sandbox, { endpointUrl: '' }),
      ).toThrow(/crashlytics\/invalid-endpoint/);

      const sharedEndpointOptions = {
        projectId: 'demo-local-endpoint',
        appId: '1:100:web:local01',
      };
      const localApp = initializeApp(sharedEndpointOptions, 'local-endpoint-app');
      const localHandle = getCrashlytics(localApp, {
        endpointUrl: 'http://127.0.0.1:4318/v1/logs',
      });
      expect(localHandle.app).toBe(localApp);

      const relApp = initializeApp(sharedEndpointOptions, 'rel-endpoint-app');
      const relHandle = getCrashlytics(relApp, {
        endpointUrl: '/__pyric/crashlytics',
      });
      expect(relHandle.app).toBe(relApp);
    } finally {
      sandbox.dispose();
    }
  });

  test('deduplicates rethrown errors, auto-flushes on hidden/pagehide, and detaches cleanly on deleteApp', async () => {
    const windowListeners = new Map<string, Set<(ev: unknown) => void>>();
    const docListeners = new Map<string, Set<() => void>>();

    const fakeWindow = {
      location: { pathname: '/checkout' },
      addEventListener(type: string, fn: (ev: unknown) => void) {
        let bucket = windowListeners.get(type);
        if (bucket === undefined) {
          bucket = new Set();
          windowListeners.set(type, bucket);
        }
        bucket.add(fn);
      },
      removeEventListener(type: string, fn: (ev: unknown) => void) {
        windowListeners.get(type)?.delete(fn);
      },
    };
    const fakeDocument = {
      visibilityState: 'visible',
      addEventListener(type: string, fn: () => void) {
        let bucket = docListeners.get(type);
        if (bucket === undefined) {
          bucket = new Set();
          docListeners.set(type, bucket);
        }
        bucket.add(fn);
      },
      removeEventListener(type: string, fn: () => void) {
        docListeners.get(type)?.delete(fn);
      },
    };

    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    globals.window = fakeWindow;
    globals.document = fakeDocument;

    const appSandbox = initializeSandbox();
    bindAppRegistrySandbox(appSandbox);
    try {
      const appId = '1:200:web:win01';
      const app = initializeApp(
        { projectId: 'demo-window-events', appId },
        'win-app',
      );
      const crashlytics = getCrashlytics(app, {
        features: [breadcrumbs()],
      });

      for (const listener of windowListeners.get('popstate') ?? []) {
        listener({});
      }
      for (const listener of docListeners.get('visibilitychange') ?? []) {
        listener();
      }

      const caughtAndRethrown = new TypeError('caught-by-boundary-then-rethrown');
      recordError(crashlytics, caughtAndRethrown);
      for (const listener of windowListeners.get('error') ?? []) {
        listener({ error: caughtAndRethrown });
      }

      for (const listener of windowListeners.get('error') ?? []) {
        listener({ error: new TypeError('uncaught-render-type-error') });
      }
      for (const listener of windowListeners.get('unhandledrejection') ?? []) {
        listener({ reason: 'async-promise-rejected' });
      }

      fakeDocument.visibilityState = 'hidden';
      for (const listener of docListeners.get('visibilitychange') ?? []) {
        listener();
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));

      const broker = getCrashlyticsBroker(appSandbox);
      const stateBeforeDelete = broker.getState(appId);
      expect(stateBeforeDelete.reports).toHaveLength(3);
      expect(stateBeforeDelete.reports.every((r) => r.flushed)).toBe(true);
      expect(stateBeforeDelete.reports.map((r) => r.message)).toEqual([
        'caught-by-boundary-then-rethrown',
        'uncaught-render-type-error',
        'async-promise-rejected',
      ]);
      expect(stateBeforeDelete.reports[0]?.breadcrumbs.map((b) => b.message)).toEqual([
        'navigation:/checkout',
        'visibility:visible',
      ]);

      await deleteApp(app);
      expect(windowListeners.get('error')?.size ?? 0).toBe(0);
      expect(windowListeners.get('unhandledrejection')?.size ?? 0).toBe(0);
      expect(windowListeners.get('popstate')?.size ?? 0).toBe(0);
      expect(windowListeners.get('pagehide')?.size ?? 0).toBe(0);
      expect(docListeners.get('visibilitychange')?.size ?? 0).toBe(0);

      expect(() => getCrashlytics(app)).toThrow(/app\/app-deleted/);

      log(crashlytics, 'ignored-after-delete');
      recordError(crashlytics, new Error('ignored-after-delete'));
      await flush(crashlytics);
      expect(broker.getState(appId).reports).toHaveLength(3);
      expect(broker.getState(appId).logs).toHaveLength(0);
    } finally {
      if (prevWindow === undefined) {
        delete globals.window;
      } else {
        globals.window = prevWindow;
      }
      if (prevDocument === undefined) {
        delete globals.document;
      } else {
        globals.document = prevDocument;
      }
      appSandbox.dispose();
    }
  });

  test('executes all 10 shared CrashlyticsBroker operations including disabled collection unsent queues and full-state reset', async () => {
    const sandbox = initializeSandbox();
    try {
      const broker = getCrashlyticsBroker(sandbox);
      const appId = '1:300:android:nativeapp';

      expect(broker.setUserId(appId, 'user-77')).toBeNull();
      expect(
        broker.setCustomKeys(appId, {
          buildNumber: 42,
          betaTester: true,
          channel: 'canary',
        }),
      ).toBeNull();
      expect(broker.setCustomKeys(appId, { channel: null })).toBeNull();

      const logRes = broker.log({
        appId,
        message: 'opened-settings',
        attributes: { screen: 'settings' },
      });
      expect(logRes).toEqual({ logged: true, logCount: 1 });

      const disabled = broker.setCollectionEnabled(appId, false);
      expect(disabled).toEqual({ enabled: false });

      const deferredRec = broker.recordError({
        appId,
        name: 'java.lang.IllegalStateException',
        message: 'offline-crash-deferred',
        stack: 'at com.example.Main.run(Main.kt:12)',
        sdkPlatform: 'android',
      });
      expect(deferredRec.queued).toBe(true);
      expect(deferredRec.flushed).toBe(false);

      expect(broker.checkForUnsentReports(appId)).toEqual({
        hasUnsentReports: true,
        count: 1,
      });
      expect(broker.getState(appId).reports).toHaveLength(0);
      expect(broker.getState(appId).unsentReports).toHaveLength(1);

      expect(broker.sendUnsentReports(appId)).toEqual({ sentCount: 1 });
      expect(broker.checkForUnsentReports(appId)).toEqual({
        hasUnsentReports: false,
        count: 0,
      });
      const sentState = broker.getState(appId);
      expect(sentState.reports).toHaveLength(1);
      expect(sentState.reports[0]?.flushed).toBe(true);
      expect(sentState.reports[0]?.userId).toBe('user-77');
      expect(sentState.reports[0]?.customKeys).toEqual({
        buildNumber: 42,
        betaTester: true,
      });

      broker.recordError({
        appId,
        message: 'discarded-report',
        deferred: true,
      });
      expect(broker.deleteUnsentReports(appId)).toEqual({ deletedCount: 1 });
      expect(broker.checkForUnsentReports(appId).count).toBe(0);

      expect(broker.setCollectionEnabled(appId, null)).toEqual({ enabled: true });

      const snap = broker.snapshot();
      const restoredSandbox = initializeSandbox();
      try {
        const restoredBroker = getCrashlyticsBroker(restoredSandbox);
        restoredBroker.restore(snap);
        expect(restoredBroker.getState(appId).userId).toBe('user-77');
        expect(restoredBroker.getState(appId).reports).toHaveLength(1);

        const emptySandbox = initializeSandbox();
        let emptyFullState: Awaited<ReturnType<typeof captureFullState>>;
        try {
          emptyFullState = await captureFullState(emptySandbox);
        } finally {
          emptySandbox.dispose();
        }
        await applyFullState(restoredSandbox, emptyFullState);
        expect(restoredBroker.getState(appId).reports).toHaveLength(0);
        expect(restoredBroker.getState(appId).userId).toBeNull();
      } finally {
        restoredSandbox.dispose();
      }
    } finally {
      sandbox.dispose();
    }
  });

  test('round-trips Crashlytics state across captureFullState/applyFullState, checkpoints, pending snapshots, and service validators', async () => {
    const source = initializeSandbox();
    const target = initializeSandbox();
    const empty = initializeSandbox();
    const pendingReceiver = initializeSandbox();
    try {
      const appId = '1:400:web:checkpointapp';
      const broker = getCrashlyticsBroker(source);
      broker.setUserId(appId, 'uid-cp-1');
      broker.setCustomKeys(appId, { plan: 'pro', seats: 12, beta: true });
      broker.log({ appId, message: 'pre-cp-log', attributes: { step: 1 } });
      broker.recordError({
        appId,
        name: 'CheckoutError',
        message: 'card-declined',
        fatal: true,
        appVersion: '3.2.0',
        region: 'us-central1',
        sdkPlatform: 'web',
      });
      broker.flush(appId);
      broker.setCollectionEnabled(appId, false);
      broker.recordError({
        appId,
        name: 'OfflineError',
        message: 'queued-unsent',
        sdkPlatform: 'android',
      });

      const snap = broker.snapshot();
      expect(isCrashlyticsSnapshot(snap)).toBe(true);
      expect(() => validatePersistedService('crashlytics', snap)).not.toThrow();
      expect(persistedServiceHasData('crashlytics', snap)).toBe(true);
      expect(persistedServiceHasData('crashlytics', { version: 1, nextSequence: 1, apps: [] })).toBe(false);

      const badPayloads: unknown[] = [
        null,
        [],
        { version: 2, nextSequence: 1, apps: [] },
        { version: 1, nextSequence: 0, apps: [] },
        { version: 1, nextSequence: 1.5, apps: [] },
        { version: 1, nextSequence: 1, apps: [['', {}]] },
        {
          version: 1,
          nextSequence: 2,
          apps: [[appId, { ...snap.apps[0]?.[1], customKeys: { bad: Number.NaN } }]],
        },
        {
          version: 1,
          nextSequence: 2,
          apps: [
            [
              appId,
              {
                ...snap.apps[0]?.[1],
                reports: [{ ...snap.apps[0]?.[1].reports[0], sdkPlatform: 'desktop' }],
              },
            ],
          ],
        },
      ];
      for (const bad of badPayloads) {
        expect(isCrashlyticsSnapshot(bad)).toBe(false);
        expect(() => validatePersistedService('crashlytics', bad)).toThrow(/Invalid persisted Crashlytics state/);
      }

      const emptyState = await captureFullState(empty);
      expect(emptyState.crashlytics).toBeUndefined();
      expect((empty as SandboxImpl).getServiceRegistry().has('crashlytics')).toBe(false);

      const cp = await captureCheckpoint(source);
      expect(cp.state.crashlytics).toBeDefined();

      // Mutate source after checkpoint; restore must bring back exact checkpointed state.
      broker.setUserId(appId, 'uid-mutated');
      broker.setCollectionEnabled(appId, true);
      broker.deleteUnsentReports(appId);
      broker.recordError({ appId, message: 'post-checkpoint-error' });

      await restoreCheckpoint(source, cp);
      const restored = broker.getState(appId);
      expect(restored.userId).toBe('uid-cp-1');
      expect(restored.collectionEnabled).toBe(false);
      expect(restored.customKeys).toEqual({ plan: 'pro', seats: 12, beta: true });
      expect(restored.appVersion).toBe('3.2.0');
      expect(restored.region).toBe('us-central1');
      expect(restored.didCrashOnPreviousExecution).toBe(true);
      expect(restored.logs.map((l) => l.message)).toEqual(['pre-cp-log']);
      expect(restored.reports.map((r) => r.message)).toEqual(['card-declined']);
      expect(restored.reports[0]?.flushed).toBe(true);
      expect(restored.unsentReports.map((r) => r.message)).toEqual(['queued-unsent']);

      // Malformed checkpoint must fail closed before mutating live Crashlytics state.
      const malformedCp = {
        ...cp,
        state: {
          ...cp.state,
          crashlytics: { version: 1, nextSequence: -1, apps: [] },
        },
      };
      let malformedErr: unknown;
      try {
        await restoreCheckpoint(source, malformedCp as unknown as typeof cp);
      } catch (err) {
        malformedErr = err;
      }
      expect(malformedErr).toBeDefined();
      expect(broker.getState(appId).userId).toBe('uid-cp-1');
      expect(broker.getState(appId).reports).toHaveLength(1);

      // Pending unconsumed snapshot loaded via loadSnapshot is captured without registering broker.
      const rawBlob = source.snapshot();
      pendingReceiver.loadSnapshot(rawBlob);
      expect((pendingReceiver as SandboxImpl).getServiceRegistry().has('crashlytics')).toBe(false);
      const capturedPending = await captureFullState(pendingReceiver);
      expect(capturedPending.crashlytics).toBeDefined();
      expect((pendingReceiver as SandboxImpl).getServiceRegistry().has('crashlytics')).toBe(false);

      await applyFullState(target, capturedPending);
      expect(getCrashlyticsBroker(target).getState(appId).userId).toBe('uid-cp-1');
      expect(getCrashlyticsBroker(target).getState(appId).unsentReports).toHaveLength(1);

      // Applying an empty state clears the pending unconsumed Crashlytics snapshot cleanly.
      await applyFullState(pendingReceiver, emptyState);
      expect(getCrashlyticsBroker(pendingReceiver).getState(appId).userId).toBeNull();
      expect(getCrashlyticsBroker(pendingReceiver).getState(appId).reports).toHaveLength(0);
    } finally {
      source.dispose();
      target.dispose();
      empty.dispose();
      pendingReceiver.dispose();
    }
  });
});
