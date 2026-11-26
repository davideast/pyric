import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { deleteApp, initializeApp } from 'pyric/app';
import { bindAppRegistrySandbox, resetAppRegistryForTests } from 'pyric/app/internal';
import { breadcrumbs, flush, getCrashlytics, log, recordError } from 'pyric/crashlytics';
import { createTransportCrashlytics } from 'pyric/crashlytics/internal';
import { createMemoryBackend, initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { createWorkerCrashlyticsTransport } from '../../src/serve/worker/client/crashlytics.js';
import { resolveNodeExecutable } from './require-node-on-path.js';
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
  const tempDirs: string[] = [];
  const savedWindow = (globalThis as Record<string, unknown>).window;
  const savedDocument = (globalThis as Record<string, unknown>).document;

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
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
        getCrashlytics(app);
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

  test('enforces loopback and local-path endpointUrl in served getCrashlytics and synchronously refuses external telemetry URLs', async () => {
    const childScript = `
      import { deleteApp, initializeApp } from 'pyric/app';
      import { bindAppRegistrySandbox } from 'pyric/app/internal';
      import { initializeSandbox } from 'pyric/sandbox';
      import { getCrashlytics as getServedCrashlytics } from './packages/cli/src/serve/entries/crashlytics.js';

      const sb = initializeSandbox();
      bindAppRegistrySandbox(sb);
      const cfg = ${JSON.stringify(SHARED_CONFIG)};

      const accepted = [
        'http://127.0.0.1:4318/v1/logs',
        'http://localhost:9000/otlp',
        'http://[::1]:8080/logs',
        '/__pyric/crashlytics',
      ].map((url, idx) => {
        const app = initializeApp(cfg, 'ok-' + idx);
        return getServedCrashlytics(app, { endpointUrl: url }).app === app;
      });

      const rejected = [
        'https://clienttelemetry.googleapis.com/v1/logs',
        'https://clienttelemetry.europe-west1.rep.googleapis.com/v1/logs',
        '',
      ].map((url, idx) => {
        const app = initializeApp(cfg, 'bad-' + idx);
        try {
          getServedCrashlytics(app, { endpointUrl: url });
          return null;
        } catch (err) {
          if (err && typeof err === 'object' && 'code' in err) {
            return err.code;
          }
          return null;
        }
      });

      const deletedApp = initializeApp(cfg, 'served-deleted');
      await deleteApp(deletedApp);
      let deletedCode = null;
      try {
        getServedCrashlytics(deletedApp);
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err) {
          deletedCode = err.code;
        }
      }

      sb.dispose();
      console.log(JSON.stringify({ accepted, rejected, deletedCode }));
    `;

    const proc = Bun.spawn([process.execPath, '-e', childScript], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const parsed = JSON.parse(stdout.trim()) as {
      accepted: boolean[];
      rejected: Array<string | null>;
      deletedCode: string | null;
    };
    expect(parsed.accepted).toEqual([true, true, true, true]);
    expect(parsed.rejected).toEqual([
      'crashlytics/invalid-endpoint',
      'crashlytics/invalid-endpoint',
      'crashlytics/invalid-endpoint',
    ]);
    expect(parsed.deletedCode).toBe('app/app-deleted');
  });

  test('persists Crashlytics state across HostedRuntime restarts and restores cleanly via sandbox.checkpoint and sandbox.restore', async () => {
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
          args: { name: 'populated-telemetry-cp' },
          projectDir: REPO_ROOT,
        },
        methodOwner,
      );
      expect(checkpointRes.ok, checkpointRes.summary).toBe(true);

      // Mutate Crashlytics state after taking the checkpoint.
      expect(
        (
          await peer2.sendOp({
            method: 'crashlytics.setUserId',
            appId: APP_ID,
            userId: 'post-checkpoint-uid',
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await peer2.sendOp({
            method: 'crashlytics.setCollectionEnabled',
            appId: APP_ID,
            enabled: true,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await peer2.sendOp({
            method: 'crashlytics.deleteUnsentReports',
            appId: APP_ID,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await peer2.sendOp({
            method: 'crashlytics.recordError',
            appId: APP_ID,
            name: 'TransientError',
            message: 'discarded-on-restore',
            sdkPlatform: 'web',
          })
        ).ok,
      ).toBe(true);

      const restoreRes = await host2.hostedRuntime.runMethod(
        {
          key: 'sandbox.restore',
          args: { name: 'populated-telemetry-cp', confirm: true },
          projectDir: REPO_ROOT,
        },
        methodOwner,
      );
      expect(restoreRes.ok, restoreRes.summary).toBe(true);

      const restoredAfterCheckpoint = (
        await peer2.sendOp({ method: 'crashlytics.getState', appId: APP_ID })
      ).value as CrashlyticsStateView;
      expect(restoredAfterCheckpoint.collectionEnabled).toBe(false);
      expect(restoredAfterCheckpoint.userId).toBe('checkpoint-uid-77');
      expect(restoredAfterCheckpoint.customKeys).toEqual({ plan: 'enterprise', seats: 25 });
      expect(restoredAfterCheckpoint.logs.map((l) => l.message)).toEqual(['before-restart-crumb']);
      expect(restoredAfterCheckpoint.reports.map((r) => r.message)).toEqual(['card-expired']);
      expect(restoredAfterCheckpoint.reports[0]?.flushed).toBe(true);
      expect(restoredAfterCheckpoint.unsentReports.map((r) => r.message)).toEqual([
        'queued-unsent-before-restart',
      ]);
      expect(restoredAfterCheckpoint.unsentReports[0]?.flushed).toBe(false);

      const resetRes = await host2.hostedRuntime.runMethod(
        {
          key: 'sandbox.reset',
          args: { confirm: true },
          projectDir: REPO_ROOT,
        },
        methodOwner,
      );
      expect(resetRes.ok, resetRes.summary).toBe(true);

      const wipedAfterReset = (
        await peer2.sendOp({ method: 'crashlytics.getState', appId: APP_ID })
      ).value as CrashlyticsStateView;
      expect(wipedAfterReset.collectionEnabled).toBe(true);
      expect(wipedAfterReset.userId).toBeNull();
      expect(wipedAfterReset.customKeys).toEqual({});
      expect(wipedAfterReset.logs).toEqual([]);
      expect(wipedAfterReset.reports).toEqual([]);
      expect(wipedAfterReset.unsentReports).toEqual([]);
    } finally {
      peer2?.close();
      await host2.close();
    }
  });

  test('persists Crashlytics state and checkpoints across real SQLite HostedPersistence restarts', () => {
    const nodeBin = resolveNodeExecutable();
    const dir = mkdtempSync(join(tmpdir(), 'pyric-crashlytics-sqlite-'));
    tempDirs.push(dir);
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');

    const persistenceDist = new URL('../../dist/serve/hosted/persistence.js', import.meta.url).href;
    const sandboxDist = new URL('../../../pyric/dist/sandbox/index.js', import.meta.url).href;
    const crashlyticsInternalDist = new URL('../../../pyric/dist/crashlytics/internal.js', import.meta.url).href;
    const checkpointsDist = new URL('../../../pyric/dist/sandbox/checkpoints/index.js', import.meta.url).href;

    const scriptPath = join(dir, 'check-sqlite-crashlytics.mjs');
    writeFileSync(
      scriptPath,
      [
        `import assert from 'node:assert/strict';`,
        `import { initializeSandbox } from '${sandboxDist}';`,
        `import { getCrashlyticsBroker } from '${crashlyticsInternalDist}';`,
        `import { saveCheckpoint, restoreNamedCheckpoint } from '${checkpointsDist}';`,
        `import { createHostedPersistence } from '${persistenceDist}';`,
        `const projectDir = process.argv[2];`,
        `const appId = ${JSON.stringify(APP_ID)};`,
        `const p1 = await createHostedPersistence(projectDir);`,
        `try {`,
        `  const sb1 = initializeSandbox();`,
        `  await sb1.enablePersistence({ injectedBackend: p1.backend, key: 'hosted', flushIntervalMs: 0 });`,
        `  const b1 = getCrashlyticsBroker(sb1);`,
        `  b1.setUserId(appId, 'sqlite-uid-1');`,
        `  b1.setCustomKeys(appId, { tier: 'enterprise' });`,
        `  b1.log({ appId, message: 'sqlite-crumb' });`,
        `  b1.recordError({ appId, name: 'SqliteErr', message: 'persisted-err' });`,
        `  b1.flush(appId);`,
        `  b1.setCollectionEnabled(appId, false);`,
        `  b1.recordError({ appId, name: 'SqliteUnsent', message: 'unsent-err' });`,
        `  await sb1.flush();`,
        `  await saveCheckpoint(p1.checkpoints, 'sqlite-cp', sb1);`,
        `  sb1.dispose();`,
        `} finally {`,
        `  p1.close();`,
        `}`,
        `const p2 = await createHostedPersistence(projectDir);`,
        `try {`,
        `  const sb2 = initializeSandbox();`,
        `  await sb2.enablePersistence({ injectedBackend: p2.backend, key: 'hosted', flushIntervalMs: 0 });`,
        `  const b2 = getCrashlyticsBroker(sb2);`,
        `  const st2 = b2.getState(appId);`,
        `  assert.equal(st2.userId, 'sqlite-uid-1');`,
        `  assert.deepEqual(st2.customKeys, { tier: 'enterprise' });`,
        `  assert.equal(st2.collectionEnabled, false);`,
        `  assert.equal(st2.logs.length, 1);`,
        `  assert.equal(st2.reports.length, 1);`,
        `  assert.equal(st2.unsentReports.length, 1);`,
        `  b2.reset();`,
        `  assert.equal(b2.getState(appId).userId, null);`,
        `  await restoreNamedCheckpoint(p2.checkpoints, 'sqlite-cp', sb2);`,
        `  const st3 = b2.getState(appId);`,
        `  assert.equal(st3.userId, 'sqlite-uid-1');`,
        `  assert.equal(st3.reports[0]?.message, 'persisted-err');`,
        `  assert.equal(st3.unsentReports[0]?.message, 'unsent-err');`,
        `  sb2.dispose();`,
        `} finally {`,
        `  p2.close();`,
        `}`,
      ].join('\n'),
    );

    const proc = spawnSync(nodeBin, [scriptPath, dir], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(proc.status, `${proc.stderr}\n${proc.stdout}`).toBe(0);
  });
});
