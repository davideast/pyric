import { afterEach, describe, expect, test } from 'bun:test';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/internal.js';
import {
  breadcrumbs,
  flush,
  getCrashlytics,
  log,
  recordError,
} from '../../src/crashlytics/index.js';
import { getCrashlyticsBroker } from '../../src/crashlytics/internal.js';
import { applyFullState, captureFullState, initializeSandbox } from '../../src/sandbox/index.js';

afterEach(async () => {
  const activeApps = [...getApps()];
  for (const app of activeApps) {
    await deleteApp(app).catch(() => undefined);
  }
  resetAppRegistryForTests();
});

describe('pyric/crashlytics Web SDK mirror and shared CrashlyticsBroker', () => {
  test('returns per-app singleton, merges customAttributes, records logs/breadcrumbs, and flushes reports', async () => {
    const app = initializeApp({
      projectId: 'demo-crashlytics-web',
      appId: '1:100000000000:web:crashlyticsdemo01',
    });
    const crashlytics = getCrashlytics(app, {
      appVersion: '2.4.1',
      region: 'us-central1',
      customAttributes: {
        env: 'staging',
        tier: 'pro',
        tags: ['checkout', 'web'],
      },
      features: [breadcrumbs()],
    });
    expect(crashlytics.app).toBe(app);
    expect(getCrashlytics(app)).toBe(crashlytics);

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

    await flush(crashlytics);

    const secondarySandbox = initializeSandbox();
    try {
      const directCrashlytics = getCrashlytics(secondarySandbox, {
        appVersion: '1.0.0',
        customAttributes: { service: 'cart', retries: 0 },
      });
      log(directCrashlytics, 'item-added', { sku: 'widget-9' });
      recordError(directCrashlytics, checkoutErr, { retries: 3 });

      const broker = getCrashlyticsBroker(secondarySandbox);
      const beforeFlush = broker.getState('default');
      expect(beforeFlush.logs).toHaveLength(1);
      expect(beforeFlush.reports).toHaveLength(1);
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
      expect(afterFlush.reports[0]?.breadcrumbs).toHaveLength(1);
      expect(afterFlush.reports[0]?.breadcrumbs[0]?.message).toBe('item-added');
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

  test('captures browser unhandled errors and navigation/visibility breadcrumbs, detaching on deleteApp', async () => {
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
      visibilityState: 'hidden',
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

    const sandbox = initializeSandbox();
    try {
      const app = initializeApp(
        { projectId: 'demo-window-events', appId: '1:200:web:win01' },
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
      for (const listener of windowListeners.get('error') ?? []) {
        listener({ error: new TypeError('uncaught-render-type-error') });
      }
      for (const listener of windowListeners.get('unhandledrejection') ?? []) {
        listener({ reason: 'async-promise-rejected' });
      }
      await flush(crashlytics);

      await deleteApp(app);
      expect(windowListeners.get('error')?.size ?? 0).toBe(0);
      expect(windowListeners.get('unhandledrejection')?.size ?? 0).toBe(0);
      expect(windowListeners.get('popstate')?.size ?? 0).toBe(0);
      expect(docListeners.get('visibilitychange')?.size ?? 0).toBe(0);

      expect(() => recordError(crashlytics, new Error('after-delete'))).toThrow(/app\/app-deleted/);
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
      sandbox.dispose();
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
});
