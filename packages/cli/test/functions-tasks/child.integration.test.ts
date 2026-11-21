import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deleteApp, getApps, initializeApp } from 'pyric-admin/app';
import { getFunctions } from 'pyric-admin/functions';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import {
  createFunctionsDevelopmentRuntime,
  createInProcessFunctionsPeerReadiness,
  type FunctionsDevelopmentEvent,
  type FunctionsDevelopmentRuntimeHandle,
} from '../../src/functions/development-runtime.js';
import { listExecutions } from '../../src/functions/execution-log.js';
import { spawnFunctionsChild } from '../../src/functions/spawn.js';
import {
  sendChildDrainTasks,
  sendChildEnqueueTask,
} from '../../src/functions/tasks/child-runtime.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';
import type { SurfaceContext } from '../../src/serve/worker/host/core.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';
import { startNodeHostedRuntime } from '../functions-storage/hosted-harness.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');

async function waitForRtdbValue<T>(sandbox: RemoteSandbox, path: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const current = (await sandbox.rtdb.get(path)) as T | null;
    if (current !== null && current !== undefined) return current;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error(`timed out waiting for RTDB receipt at ${path}`);
}

describe('isolated Functions Cloud Tasks child E2E (CJS + ESM + pyric-admin taskQueue)', () => {
  const tempDirs = trackTempDirs('pyric-fn-tasks-e2e-');
  let fixtureDir = '';
  let serveRuntime: ServeRuntime | undefined;
  let hostCtx: SurfaceContext | undefined;
  let peer: { close(): Promise<void> } | undefined;
  let observer: RemoteSandbox | undefined;
  let activeRuntime: FunctionsDevelopmentRuntimeHandle | undefined;

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    fixtureDir = tempDirs.makeTempDir();
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions-esm/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>tasks</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );

    writeFileSync(
      join(fixtureDir, 'functions/package.json'),
      JSON.stringify({ name: 'tasks-fn-cjs', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { getFunctions } = require('firebase-admin/functions');",
        "const { onInit } = require('firebase-functions/v2/core');",
        "const { onValueCreated } = require('firebase-functions/v2/database');",
        "const { onTaskDispatched } = require('firebase-functions/v2/tasks');",
        '',
        'let initStamp = "uninitialized";',
        'onInit(async () => {',
        '  if (getApps().length === 0) initializeApp();',
        '  initStamp = "initialized-by-onInit";',
        '});',
        '',
        'exports.processOrder = onTaskDispatched(',
        '  {',
        '    retryConfig: { maxAttempts: 3, minBackoffSeconds: 1 },',
        '    rateLimits: { maxConcurrentDispatches: 2 },',
        '  },',
        '  async (req) => {',
        "    await getDatabase().ref('taskReceipts/orders/' + req.id).set({",
        '      orderId: req.data.orderId,',
        '      hasUndefinedKey: Object.prototype.hasOwnProperty.call(req.data, "optionalNote"),',
        '      queueName: req.queueName,',
        '      retryCount: req.retryCount,',
        '      executionCount: req.executionCount,',
        '      scheduledTime: req.scheduledTime,',
        '      originHeader: req.headers && req.headers["x-origin"] ? req.headers["x-origin"] : null,',
        '      authUid: req.auth ? req.auth.uid : null,',
        '      initStamp,',
        '    });',
        '  },',
        ');',
        '',
        'exports.flakyWebhook = onTaskDispatched(',
        '  { retryConfig: { maxAttempts: 2 } },',
        '  async (req) => {',
        '    if (req.retryCount === 0) {',
        "      throw new Error('webhook endpoint 503');",
        '    }',
        "    await getDatabase().ref('taskReceipts/flaky/' + req.id).set({",
        '      retryCount: req.retryCount,',
        '      executionCount: req.executionCount,',
        '      previousResponse: req.previousResponse || null,',
        '    });',
        '  },',
        ');',
        '',
        "exports.onSignupCreated = onValueCreated('/signups/{uid}', async (event) => {",
        '  if (getApps().length === 0) initializeApp();',
        "  const queue = getFunctions().taskQueue('processOrder');",
        '  await queue.enqueue(',
        '    { orderId: "signup-" + event.params.uid, optionalNote: undefined },',
        '    { id: "inchild-" + event.params.uid, headers: { "x-origin": "in-child-admin" } },',
        '  );',
        '});',
        '',
        'exports.omittedTask = onTaskDispatched({ omit: true }, async () => undefined);',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions/node_modules/firebase-functions'),
    );

    writeFileSync(
      join(fixtureDir, 'functions-esm/package.json'),
      JSON.stringify({
        name: 'tasks-fn-esm',
        private: true,
        type: 'module',
        main: 'index.js',
      }),
    );
    writeFileSync(
      join(fixtureDir, 'functions-esm/index.js'),
      [
        "import { initializeApp, getApps } from 'firebase-admin/app';",
        "import { getDatabase } from 'firebase-admin/database';",
        "import { getFunctions } from 'firebase-admin/functions';",
        "import { onValueCreated } from 'firebase-functions/v2/database';",
        "import { onTaskDispatched } from 'firebase-functions/v2/tasks';",
        'await Promise.resolve();',
        'if (getApps().length === 0) initializeApp();',
        'export const esmWorker = onTaskDispatched(async (req) => {',
        "  await getDatabase().ref('taskReceipts/esm/' + req.id).set({",
        '    step: req.data.step,',
        '    queueName: req.queueName,',
        '  });',
        '});',
        "export const esmEnqueuer = onValueCreated('/esmTriggers/{id}', async (event) => {",
        "  await getFunctions().taskQueue('esmWorker').enqueue(",
        '    { step: event.data.val() },',
        '    { id: "esm-" + event.params.id },',
        '  );',
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions-esm/node_modules/firebase-functions'),
    );

    serveRuntime = await startServe({
      cwd: fixtureDir,
      port: 0,
      bridge: true,
      capture: false,
      disableAuditLog: true,
      cacheRoot: join(fixtureDir, '.cache'),
      logger: silentServeLogger(),
    });
    hostCtx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'functions-tasks-e2e',
      instanceId: 'functions-tasks-e2e-instance',
    });
    peer = await connectFunctionsWorkerPeer({
      url: `ws://127.0.0.1:${serveRuntime.handle.port}/__pyric/sandbox`,
      ctx: hostCtx,
      sandboxId: 'functions-tasks-e2e-sb',
    });
    observer = await connectRemoteSandbox({ url: serveRuntime.handle.url });
  }, 30_000);

  afterEach(async () => {
    for (const app of [...getApps()]) {
      await deleteApp(app);
    }
  });

  afterAll(async () => {
    if (activeRuntime) await activeRuntime.close();
    observer?.close();
    if (peer) await peer.close();
    if (serveRuntime) await serveRuntime.handle.stop();
    tempDirs.cleanupTempDirs();
  });

  test('dispatches CJS onTaskDispatched from both host pyric-admin taskQueue() and in-child firebase-admin/functions, retries failures, cancels deleted delayed tasks, and closes cleanly', async () => {
    if (!serveRuntime || !hostCtx || !observer) {
      throw new Error('test runtime not initialized');
    }

    const devEvents: FunctionsDevelopmentEvent[] = [];
    activeRuntime = createFunctionsDevelopmentRuntime({
      sourceDir: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      baseEnv: process.env,
      serveUrl: serveRuntime.handle.url,
      registerUrl: registerModuleUrl(),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      childModuleUrl: pathToFileURL(childModule),
      readiness: createInProcessFunctionsPeerReadiness(() => true),
      onEvent: (evt) => devEvents.push(evt),
      sandbox: hostCtx.sandbox,
    });

    const started = await activeRuntime.start();
    expect(started).toEqual({
      kind: 'ready',
      ready: {
        triggerCount: 3,
        unsupportedTriggers: [
          {
            exportName: 'omittedTask',
            eventType: 'task-queue (omitted from emulation)',
          },
        ],
      },
    });

    // 1. Enqueue from host-side `pyric-admin/functions` bound to `hostCtx.sandbox`.
    const hostAdminApp = initializeApp({
      sandbox: hostCtx.sandbox,
      projectId: 'demo-project',
    });
    const hostQueue = getFunctions(hostAdminApp).taskQueue<{
      orderId: string;
      optionalNote?: string;
    }>('locations/us-central1/functions/processOrder');

    await hostQueue.enqueue(
      { orderId: 'host-order-1', optionalNote: undefined },
      { id: 'host-task-1', headers: { 'x-origin': 'host-admin' } },
    );

    const hostReceipt = await waitForRtdbValue<{
      orderId: string;
      hasUndefinedKey: boolean;
      queueName: string;
      retryCount: number;
      executionCount: number;
      scheduledTime: string;
      originHeader: string;
      authUid: string;
      initStamp: string;
    }>(observer, 'taskReceipts/orders/host-task-1');

    expect(hostReceipt.orderId).toBe('host-order-1');
    expect(hostReceipt.hasUndefinedKey).toBe(false);
    expect(hostReceipt.queueName).toBe('processOrder');
    expect(hostReceipt.retryCount).toBe(0);
    expect(hostReceipt.executionCount).toBe(0);
    expect(hostReceipt.originHeader).toBe('host-admin');
    expect(hostReceipt.authUid).toBe('demo-project@appspot.gserviceaccount.com');
    expect(hostReceipt.initStamp).toBe('initialized-by-onInit');

    // 2. Enqueue a delayed task via hostQueue, cancel it via hostQueue.delete(id), and verify
    // duplicate ID still throws functions/task-already-exists.
    await hostQueue.enqueue({ orderId: 'never-runs' }, { id: 'cancelled-1', scheduleDelaySeconds: 300 });
    await hostQueue.delete('cancelled-1');
    let dupErrorCode: unknown;
    try {
      await hostQueue.enqueue({ orderId: 'dup' }, { id: 'cancelled-1' });
    } catch (err: unknown) {
      dupErrorCode = (err as { code?: unknown }).code;
    }
    expect(dupErrorCode).toBe('functions/task-already-exists');

    // 3. Trigger an RTDB write so `onSignupCreated` inside the isolated child calls
    // `require('firebase-admin/functions').getFunctions().taskQueue('processOrder').enqueue(...)`.
    await observer.rtdb.set('signups/u42', { plan: 'pro' });
    const inChildReceipt = await waitForRtdbValue<{
      orderId: string;
      hasUndefinedKey: boolean;
      originHeader: string;
    }>(observer, 'taskReceipts/orders/inchild-u42');
    expect(inChildReceipt).toEqual({
      orderId: 'signup-u42',
      hasUndefinedKey: false,
      originHeader: 'in-child-admin',
      queueName: 'processOrder',
      retryCount: 0,
      executionCount: 0,
      scheduledTime: expect.any(String),
      authUid: 'demo-project@appspot.gserviceaccount.com',
      initStamp: 'initialized-by-onInit',
    });

    // 4. Enqueue onto `flakyWebhook` (`maxAttempts: 2`) and verify attempt 0 fails (500) and
    // attempt 1 succeeds with `previousResponse: 500`.
    await activeRuntime.enqueueTask('flakyWebhook', { ping: true }, { id: 'webhook-1' });
    await activeRuntime.drainTasks();
    const flakyReceipt = await waitForRtdbValue<{
      retryCount: number;
      executionCount: number;
      previousResponse: number;
    }>(observer, 'taskReceipts/flaky/webhook-1');
    expect(flakyReceipt).toEqual({
      retryCount: 1,
      executionCount: 1,
      previousResponse: 500,
    });

    // 5. Verify cancelled task never executed even when flushing delayed tasks.
    await activeRuntime.drainTasks({ flushDelayed: true });
    expect(await observer.rtdb.get('taskReceipts/orders/cancelled-1')).toBeNull();

    // 6. Verify `execution-log.ts` recorded all task attempts on `hostCtx.sandbox`.
    const taskLog = listExecutions(hostCtx.sandbox).filter(
      (rec) => rec.trigger === 'processOrder' || rec.trigger === 'flakyWebhook',
    );
    expect(taskLog.map((rec) => [rec.trigger, rec.status])).toEqual([
      ['processOrder', 'fulfilled'],
      ['processOrder', 'fulfilled'],
      ['flakyWebhook', 'rejected'],
      ['flakyWebhook', 'fulfilled'],
    ]);

    const closeStart = Date.now();
    await activeRuntime.close();
    expect(Date.now() - closeStart).toBeLessThan(1_800);
    activeRuntime = undefined;
    expect(devEvents.some((evt) => evt.type === 'unexpected-exit')).toBe(false);
  }, 25_000);

  test('loads top-level-await ESM onTaskDispatched and dispatches from ESM firebase-admin/functions', async () => {
    if (!serveRuntime || !observer) {
      throw new Error('test runtime not initialized');
    }

    activeRuntime = createFunctionsDevelopmentRuntime({
      sourceDir: join(fixtureDir, 'functions-esm'),
      entry: join(fixtureDir, 'functions-esm/index.js'),
      baseEnv: process.env,
      serveUrl: serveRuntime.handle.url,
      registerUrl: registerModuleUrl(),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      childModuleUrl: pathToFileURL(childModule),
      readiness: createInProcessFunctionsPeerReadiness(() => true),
    });

    const started = await activeRuntime.start();
    expect(started).toEqual({
      kind: 'ready',
      ready: { triggerCount: 2, unsupportedTriggers: [] },
    });

    await observer.rtdb.set('esmTriggers/k1', 'transcode-video');
    const esmReceipt = await waitForRtdbValue<{ step: string; queueName: string }>(
      observer,
      'taskReceipts/esm/esm-k1',
    );
    expect(esmReceipt).toEqual({
      step: 'transcode-video',
      queueName: 'esmWorker',
    });

    await activeRuntime.close();
    activeRuntime = undefined;
  }, 20_000);

  test('re-discovers newly added onTaskDispatched exports across runtime.reload()', async () => {
    if (!serveRuntime || !observer) {
      throw new Error('test runtime not initialized');
    }

    const reloadDir = join(fixtureDir, 'functions-reload');
    mkdirSync(join(reloadDir, 'node_modules'), { recursive: true });
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(reloadDir, 'node_modules/firebase-functions'),
    );
    writeFileSync(
      join(reloadDir, 'package.json'),
      JSON.stringify({ name: 'tasks-fn-reload', private: true, type: 'commonjs' }),
    );
    const entryPath = join(reloadDir, 'index.js');
    writeFileSync(
      entryPath,
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onTaskDispatched } = require('firebase-functions/v2/tasks');",
        'if (getApps().length === 0) initializeApp();',
        'exports.initialTask = onTaskDispatched(async (req) => {',
        "  await getDatabase().ref('taskReceipts/reload/initial').set({ id: req.id });",
        '});',
      ].join('\n'),
    );

    activeRuntime = createFunctionsDevelopmentRuntime({
      sourceDir: reloadDir,
      entry: entryPath,
      baseEnv: process.env,
      serveUrl: serveRuntime.handle.url,
      registerUrl: registerModuleUrl(),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      childModuleUrl: pathToFileURL(childModule),
      readiness: createInProcessFunctionsPeerReadiness(() => true),
    });

    const initial = await activeRuntime.start();
    expect(initial).toEqual({
      kind: 'ready',
      ready: { triggerCount: 1, unsupportedTriggers: [] },
    });

    writeFileSync(
      entryPath,
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onTaskDispatched } = require('firebase-functions/v2/tasks');",
        'if (getApps().length === 0) initializeApp();',
        'exports.initialTask = onTaskDispatched(async (req) => {',
        "  await getDatabase().ref('taskReceipts/reload/initial').set({ id: req.id });",
        '});',
        'exports.hotAddedTask = onTaskDispatched(async (req) => {',
        "  await getDatabase().ref('taskReceipts/reload/hotAdded').set({",
        '    id: req.id,',
        '    payload: req.data.payload,',
        '  });',
        '});',
      ].join('\n'),
    );

    const reloaded = await activeRuntime.reload();
    expect(reloaded).toEqual({
      kind: 'ready',
      ready: { triggerCount: 2, unsupportedTriggers: [] },
    });

    await activeRuntime.enqueueTask('hotAddedTask', { payload: 'reloaded-ok' }, { id: 'hot-1' });
    await activeRuntime.drainTasks();

    const receipt = await waitForRtdbValue<{ id: string; payload: string }>(
      observer,
      'taskReceipts/reload/hotAdded',
    );
    expect(receipt).toEqual({ id: 'hot-1', payload: 'reloaded-ok' });

    await activeRuntime.close();
    activeRuntime = undefined;
  }, 20_000);

  test('executes onTaskDispatched against live Node HostedRuntime via spawnFunctionsChild + sendChildEnqueueTask', async () => {
    const hostedDir = tempDirs.makeTempDir();
    mkdirSync(join(hostedDir, 'public'), { recursive: true });
    mkdirSync(join(hostedDir, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(hostedDir, 'public/index.html'), '<!doctype html><body>hosted</body>');
    writeFileSync(
      join(hostedDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    writeFileSync(
      join(hostedDir, 'functions/package.json'),
      JSON.stringify({ name: 'tasks-hosted-fn', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(hostedDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onTaskDispatched } = require('firebase-functions/v2/tasks');",
        'if (getApps().length === 0) initializeApp();',
        'exports.hostedTask = onTaskDispatched(async (req) => {',
        "  await getDatabase().ref('hostedTasks/' + req.id).set({",
        '    queueName: req.queueName,',
        '    value: req.data.value,',
        '  });',
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(hostedDir, 'functions/node_modules/firebase-functions'),
    );

    const hosted = await startNodeHostedRuntime(hostedDir);
    let hostedObserver: RemoteSandbox | undefined;
    let childHandle: ReturnType<typeof spawnFunctionsChild> | undefined;
    try {
      hostedObserver = await connectRemoteSandbox({
        cwd: hostedDir,
        url: hosted.url,
        sessionToken: hosted.sessionToken,
      });
      childHandle = spawnFunctionsChild({
        cwd: join(hostedDir, 'functions'),
        entry: join(hostedDir, 'functions/index.js'),
        childModuleUrl: pathToFileURL(childModule),
        env: buildChildEnv(process.env, {
          serveUrl: hosted.url,
          registerUrl: registerModuleUrl(),
          instanceId: hosted.instanceId,
          sessionToken: hosted.sessionToken,
        }),
        instance: 'demo-project-default-rtdb',
        projectId: 'demo-project',
        location: 'us-central1',
      });

      const ready = await childHandle.ready;
      expect(ready).toEqual({ triggerCount: 1, unsupportedTriggers: [] });

      const receiptMeta = await sendChildEnqueueTask(
        childHandle.child,
        'hostedTask',
        { value: 99 },
        { id: 'ht-1' },
      );
      expect(receiptMeta.id).toBe('ht-1');
      await sendChildDrainTasks(childHandle.child);

      const receipt = await waitForRtdbValue<{ queueName: string; value: number }>(
        hostedObserver,
        'hostedTasks/ht-1',
      );
      expect(receipt).toEqual({ queueName: 'hostedTask', value: 99 });
    } finally {
      if (childHandle) await childHandle.stop();
      hostedObserver?.close();
      await hosted.stop();
    }
  }, 30_000);
});
