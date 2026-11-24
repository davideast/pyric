import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { deleteApp, initializeApp } from 'pyric/app';
import { bindAppRegistrySandbox, resetAppRegistryForTests } from 'pyric/app/internal';
import { breadcrumbs, flush, log, recordError } from 'pyric/crashlytics';
import { createTransportCrashlytics } from 'pyric/crashlytics/internal';
import { createMemoryBackend, initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { getCrashlytics as getServedCrashlytics } from '../../src/serve/entries/crashlytics.js';
import { createWorkerCrashlyticsTransport } from '../../src/serve/worker/client/crashlytics.js';
import {
  APP_ID,
  openAttachedSocket,
  REPO_ROOT,
  SHARED_CONFIG,
  startLiveCrashlyticsHost,
  type CrashlyticsStateView,
} from './crashlytics-web-host-harness.js';

describe('Crashlytics web live HostedRuntime and DOM conformance', () => {
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

  test('streams unhandled window error and unhandledrejection events over HostedRuntime, deduplicates rethrown errors, and detaches on deleteApp', async () => {
    const host = await startLiveCrashlyticsHost();
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'http://127.0.0.1:5000/orders',
    });
    (globalThis as Record<string, unknown>).window = dom.window;
    (globalThis as Record<string, unknown>).document = dom.window.document;

    let peer: Awaited<ReturnType<typeof openAttachedSocket>> | undefined;
    try {
      peer = await openAttachedSocket(host.wsUrl, 'crashlytics-dom-errors');
      activeSandbox = initializeSandbox();
      bindAppRegistrySandbox(activeSandbox);
      const app = initializeApp(SHARED_CONFIG, 'dom-errors-app');
      let cleanupHandle = (): void => {};
      const transport = createWorkerCrashlyticsTransport(peer.clientDb, APP_ID);
      const crashlytics = createTransportCrashlytics(
        app,
        transport,
        {
          appVersion: '4.0.0',
          features: [breadcrumbs()],
        },
        (cleanup) => {
          cleanupHandle = cleanup;
        },
      );

      const caughtAndRethrown = new TypeError('boundary-caught-error');
      recordError(crashlytics, caughtAndRethrown, { boundary: 'orders' });
      const rethrownEvent = new dom.window.ErrorEvent('error', {
        error: caughtAndRethrown,
        message: caughtAndRethrown.message,
      });
      dom.window.dispatchEvent(rethrownEvent);

      const fatalWindowErr = new ReferenceError('unhandled-window-crash');
      dom.window.dispatchEvent(
        new dom.window.ErrorEvent('error', {
          error: fatalWindowErr,
          message: fatalWindowErr.message,
        }),
      );

      const rejectionEvent = Object.assign(new dom.window.Event('unhandledrejection'), {
        reason: new RangeError('unhandled-promise-crash'),
      });
      dom.window.dispatchEvent(rejectionEvent);
      await flush(crashlytics);

      const stateRes = await peer.sendOp({ method: 'crashlytics.getState', appId: APP_ID });
      expect(stateRes.ok).toBe(true);
      const state = stateRes.value as CrashlyticsStateView;
      expect(state.reports.map((r) => r.message)).toEqual([
        'boundary-caught-error',
        'unhandled-window-crash',
        'unhandled-promise-crash',
      ]);
      expect(state.reports[0]?.fatal).toBe(false);
      expect(state.reports[1]?.fatal).toBe(true);
      expect(state.reports[2]?.fatal).toBe(true);
      expect(state.reports.every((r) => r.flushed)).toBe(true);

      cleanupHandle();
      await deleteApp(app);

      dom.window.dispatchEvent(
        new dom.window.ErrorEvent('error', {
          error: new Error('post-delete-window-error'),
          message: 'post-delete-window-error',
        }),
      );
      log(crashlytics, 'post-delete-log');
      recordError(crashlytics, new Error('post-delete-explicit'));
      await flush(crashlytics);

      const afterDeleteRes = await peer.sendOp({
        method: 'crashlytics.getState',
        appId: APP_ID,
      });
      const afterDelete = afterDeleteRes.value as CrashlyticsStateView;
      expect(afterDelete.reports).toHaveLength(3);

      let freshDeletedCode: string | null = null;
      try {
        getServedCrashlytics(app);
      } catch (err) {
        freshDeletedCode = (err as { code?: string }).code ?? null;
      }
      expect(freshDeletedCode).toBe('app/app-deleted');
    } finally {
      peer?.close();
      dom.window.close();
      await host.close();
    }
  });

  test('records popstate, hashchange, and visibilitychange breadcrumbs in real DOM and auto-flushes on hidden over HostedRuntime', async () => {
    const host = await startLiveCrashlyticsHost();
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'http://127.0.0.1:5000/catalog',
    });
    let visibilityState = 'visible';
    Object.defineProperty(dom.window.document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });
    (globalThis as Record<string, unknown>).window = dom.window;
    (globalThis as Record<string, unknown>).document = dom.window.document;

    let peer: Awaited<ReturnType<typeof openAttachedSocket>> | undefined;
    try {
      peer = await openAttachedSocket(host.wsUrl, 'crashlytics-dom-breadcrumbs');
      activeSandbox = initializeSandbox();
      bindAppRegistrySandbox(activeSandbox);
      const app = initializeApp(SHARED_CONFIG, 'dom-breadcrumbs-app');
      let cleanupHandle = (): void => {};
      const transport = createWorkerCrashlyticsTransport(peer.clientDb, APP_ID);
      const crashlytics = createTransportCrashlytics(
        app,
        transport,
        {
          appVersion: '4.1.0',
          features: [breadcrumbs()],
        },
        (cleanup) => {
          cleanupHandle = cleanup;
        },
      );

      dom.window.history.pushState({}, '', '/checkout');
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
      dom.window.history.pushState({}, '', '/payment');
      dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));

      recordError(crashlytics, new Error('payment-declined'));

      visibilityState = 'hidden';
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));

      const deadline = Date.now() + 2_000;
      let flushedReport = false;
      while (Date.now() < deadline && !flushedReport) {
        const res = await peer.sendOp({ method: 'crashlytics.getState', appId: APP_ID });
        const cur = res.value as CrashlyticsStateView;
        if (cur.reports[0]?.flushed === true) {
          flushedReport = true;
          expect(cur.reports[0]?.breadcrumbs.map((b) => b.message)).toEqual([
            'navigation:/checkout',
            'navigation:/payment',
            'visibility:visible',
          ]);
        } else {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      expect(flushedReport).toBe(true);

      cleanupHandle();
      await deleteApp(app);
      const logsBeforePostDeleteNav = (
        (await peer.sendOp({ method: 'crashlytics.getState', appId: APP_ID }))
          .value as CrashlyticsStateView
      ).logs.length;
      dom.window.history.pushState({}, '', '/ignored-after-delete');
      dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
      await new Promise((r) => setTimeout(r, 30));
      const logsAfterPostDeleteNav = (
        (await peer.sendOp({ method: 'crashlytics.getState', appId: APP_ID }))
          .value as CrashlyticsStateView
      ).logs.length;
      expect(logsAfterPostDeleteNav).toBe(logsBeforePostDeleteNav);
    } finally {
      peer?.close();
      dom.window.close();
      await host.close();
    }
  });

  test('enforces loopback and local-path endpointUrl in served getCrashlytics and synchronously refuses external telemetry URLs', () => {
    activeSandbox = initializeSandbox();
    bindAppRegistrySandbox(activeSandbox);

    const loopbackIpv4 = initializeApp(SHARED_CONFIG, 'loopback-v4');
    expect(
      getServedCrashlytics(loopbackIpv4, {
        endpointUrl: 'http://127.0.0.1:4318/v1/logs',
      }).app,
    ).toBe(loopbackIpv4);

    const loopbackHost = initializeApp(SHARED_CONFIG, 'loopback-localhost');
    expect(
      getServedCrashlytics(loopbackHost, {
        endpointUrl: 'http://localhost:9000/otlp',
      }).app,
    ).toBe(loopbackHost);

    const loopbackIpv6 = initializeApp(SHARED_CONFIG, 'loopback-v6');
    expect(
      getServedCrashlytics(loopbackIpv6, {
        endpointUrl: 'http://[::1]:8080/logs',
      }).app,
    ).toBe(loopbackIpv6);

    const relativeLocal = initializeApp(SHARED_CONFIG, 'relative-local');
    expect(
      getServedCrashlytics(relativeLocal, {
        endpointUrl: '/__pyric/crashlytics',
      }).app,
    ).toBe(relativeLocal);

    for (const rejectedUrl of [
      'https://clienttelemetry.googleapis.com/v1/logs',
      'https://clienttelemetry.europe-west1.rep.googleapis.com/v1/logs',
      '',
    ]) {
      const rejectedApp = initializeApp(SHARED_CONFIG, `rejected-${rejectedUrl.length}`);
      let code: string | null = null;
      try {
        getServedCrashlytics(rejectedApp, { endpointUrl: rejectedUrl });
      } catch (err) {
        code = (err as { code?: string }).code ?? null;
      }
      expect(code).toBe('crashlytics/invalid-endpoint');
    }
  });

  test('persists Crashlytics state across HostedRuntime restarts and resets cleanly on sandbox.restore and sandbox.reset', async () => {
    const sharedBackend = createMemoryBackend();
    const host1 = await startLiveCrashlyticsHost(sharedBackend);
    let peer1: Awaited<ReturnType<typeof openAttachedSocket>> | undefined;

    try {
      peer1 = await openAttachedSocket(host1.wsUrl, 'crashlytics-persist-peer-1');
      expect(
        (
          await peer1.sendOp({
            method: 'crashlytics.setUserId',
            appId: APP_ID,
            userId: 'checkpoint-uid-77',
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await peer1.sendOp({
            method: 'crashlytics.setCustomKeys',
            appId: APP_ID,
            keys: { plan: 'enterprise', seats: 25 },
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await peer1.sendOp({
            method: 'crashlytics.log',
            appId: APP_ID,
            message: 'before-restart-crumb',
            attributes: { step: 'billing' },
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await peer1.sendOp({
            method: 'crashlytics.recordError',
            appId: APP_ID,
            name: 'BillingError',
            message: 'card-expired',
            sdkPlatform: 'web',
          })
        ).ok,
      ).toBe(true);
      expect(
        (await peer1.sendOp({ method: 'crashlytics.flush', appId: APP_ID })).ok,
      ).toBe(true);

      expect(
        (
          await peer1.sendOp({
            method: 'crashlytics.setCollectionEnabled',
            appId: APP_ID,
            enabled: false,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await peer1.sendOp({
            method: 'crashlytics.recordError',
            appId: APP_ID,
            name: 'OfflineError',
            message: 'queued-unsent-before-restart',
            sdkPlatform: 'web',
          })
        ).ok,
      ).toBe(true);
    } finally {
      peer1?.close();
      await host1.close();
    }

    const host2 = await startLiveCrashlyticsHost(sharedBackend);
    const methodOwner = {};
    let peer2: Awaited<ReturnType<typeof openAttachedSocket>> | undefined;

    try {
      peer2 = await openAttachedSocket(host2.wsUrl, 'crashlytics-persist-peer-2');
      const restoredState = (
        await peer2.sendOp({ method: 'crashlytics.getState', appId: APP_ID })
      ).value as CrashlyticsStateView;
      expect(restoredState.collectionEnabled).toBe(false);
      expect(restoredState.userId).toBe('checkpoint-uid-77');
      expect(restoredState.customKeys).toEqual({ plan: 'enterprise', seats: 25 });
      expect(restoredState.logs.map((l) => l.message)).toEqual(['before-restart-crumb']);
      expect(restoredState.reports.map((r) => r.message)).toEqual(['card-expired']);
      expect(restoredState.reports[0]?.flushed).toBe(true);
      expect(restoredState.unsentReports.map((r) => r.message)).toEqual([
        'queued-unsent-before-restart',
      ]);
      expect(restoredState.unsentReports[0]?.flushed).toBe(false);

      const checkpointRes = await host2.hostedRuntime.runMethod(
        {
          key: 'sandbox.checkpoint',
          args: { name: 'empty-telemetry-cp' },
          projectDir: REPO_ROOT,
        },
        methodOwner,
      );
      expect(checkpointRes.ok, checkpointRes.summary).toBe(true);

      const restoreRes = await host2.hostedRuntime.runMethod(
        {
          key: 'sandbox.restore',
          args: { name: 'empty-telemetry-cp', confirm: true },
          projectDir: REPO_ROOT,
        },
        methodOwner,
      );
      expect(restoreRes.ok, restoreRes.summary).toBe(true);

      const wipedAfterRestore = (
        await peer2.sendOp({ method: 'crashlytics.getState', appId: APP_ID })
      ).value as CrashlyticsStateView;
      expect(wipedAfterRestore.collectionEnabled).toBe(true);
      expect(wipedAfterRestore.userId).toBeNull();
      expect(wipedAfterRestore.customKeys).toEqual({});
      expect(wipedAfterRestore.logs).toEqual([]);
      expect(wipedAfterRestore.reports).toEqual([]);
      expect(wipedAfterRestore.unsentReports).toEqual([]);
    } finally {
      peer2?.close();
      await host2.close();
    }
  });
});
