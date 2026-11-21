import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { buildChildEnv } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import {
  createFunctionsDevelopmentRuntime,
  createInProcessFunctionsPeerReadiness,
  type FunctionsDevelopmentEvent,
  type FunctionsDevelopmentRuntimeHandle,
} from '../../src/functions/development-runtime.js';
import { listExecutions } from '../../src/functions/execution-log.js';
import { sendChildTriggerScheduled } from '../../src/functions/scheduler/child-runtime.js';
import { spawnFunctionsChild } from '../../src/functions/spawn.js';
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

async function waitForRtdbValue<T>(
  sandbox: RemoteSandbox,
  path: string,
): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const current = (await sandbox.rtdb.get(path)) as T | null;
    if (current !== null && current !== undefined) return current;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error(`timed out waiting for RTDB receipt at ${path}`);
}

describe('isolated Functions Scheduler child E2E (CJS + ESM + sibling RTDB resilience)', () => {
  const tempDirs = trackTempDirs('pyric-fn-scheduler-e2e-');
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
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>scheduler</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );

    writeFileSync(
      join(fixtureDir, 'functions/package.json'),
      JSON.stringify({ name: 'scheduler-fn-cjs', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onInit } = require('firebase-functions/v2/core');",
        "const { onValueCreated } = require('firebase-functions/v2/database');",
        "const { onSchedule } = require('firebase-functions/v2/scheduler');",
        '',
        'let initStamp = "uninitialized";',
        'onInit(async () => {',
        '  if (getApps().length === 0) initializeApp();',
        '  initStamp = "initialized-by-onInit";',
        '});',
        '',
        'exports.hourlyRollup = onSchedule(',
        '  {',
        "    schedule: '0 * * * *',",
        "    timeZone: 'America/New_York',",
        '    retryCount: 3,',
        '    maxRetrySeconds: 120,',
        "    region: 'europe-west1',",
        '    timeoutSeconds: 60,',
        '  },',
        '  async (event) => {',
        "    await getDatabase().ref('scheduledReceipts/hourlyRollup').set({",
        '      jobName: event.jobName || null,',
        '      scheduleTime: event.scheduleTime,',
        '      initStamp,',
        '      contextEventId: event.context ? event.context.eventId : null,',
        '    });',
        '  },',
        ');',
        '',
        'exports.flakyBilling = onSchedule(',
        "  { schedule: 'every 15 minutes', retryCount: 2 },",
        '  async (event) => {',
        "    await getDatabase().ref('scheduledReceipts/flakyAttempt').set({",
        '      scheduleTime: event.scheduleTime,',
        '    });',
        "    throw new Error('billing gateway unavailable');",
        '  },',
        ');',
        '',
        'exports.digest = {',
        "  nightly: onSchedule('every 24 hours', async (event) => {",
        "    await getDatabase().ref('scheduledReceipts/digestNightly').set({",
        '      jobName: event.jobName || null,',
        '      scheduleTime: event.scheduleTime,',
        '    });',
        '  }),',
        '};',
        '',
        'exports.omittedCron = onSchedule(',
        "  { schedule: '0 0 * * *', omit: true },",
        '  async () => undefined,',
        ');',
        '',
        "exports.onPingCreated = onValueCreated('/pings/{pingId}', async (event) => {",
        '  if (getApps().length === 0) initializeApp();',
        "  await getDatabase().ref('scheduledReceipts/pingEcho/' + event.params.pingId).set({",
        '    value: event.data.val(),',
        '  });',
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions/node_modules/firebase-functions'),
    );

    writeFileSync(
      join(fixtureDir, 'functions-esm/package.json'),
      JSON.stringify({
        name: 'scheduler-fn-esm',
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
        "import { onSchedule } from 'firebase-functions/v2/scheduler';",
        'await Promise.resolve();',
        'if (getApps().length === 0) initializeApp();',
        "export const esmPulse = onSchedule('*/5 * * * *', async (event) => {",
        "  await getDatabase().ref('scheduledReceipts/esmPulse').set({",
        '    jobName: event.jobName || null,',
        '    scheduleTime: event.scheduleTime,',
        '  });',
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
      persistenceKeyPrefix: 'functions-scheduler-e2e',
      instanceId: 'functions-scheduler-e2e-instance',
    });
    peer = await connectFunctionsWorkerPeer({
      url: `ws://127.0.0.1:${serveRuntime.handle.port}/__pyric/sandbox`,
      ctx: hostCtx,
      sandboxId: 'functions-scheduler-e2e-sb',
    });
    observer = await connectRemoteSandbox({ url: serveRuntime.handle.url });
  }, 30_000);

  afterAll(async () => {
    if (activeRuntime) await activeRuntime.close();
    observer?.close();
    if (peer) await peer.close();
    if (serveRuntime) await serveRuntime.handle.stop();
    tempDirs.cleanupTempDirs();
  });

  test('invokes CJS onSchedule exports via runtime.triggerScheduled, survives throws, and stops cleanly', async () => {
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
        triggerCount: 4,
        unsupportedTriggers: [
          {
            exportName: 'omittedCron',
            eventType: 'schedule (omitted from emulation)',
          },
        ],
      },
    });

    // 1. Fire `hourlyRollup` with an explicit ISO-8601 UTC `scheduleTime`.
    const rollupRun = await activeRuntime.triggerScheduled('hourlyRollup', {
      scheduleTime: '2026-11-21T16:00:00.000Z',
    });
    expect(rollupRun.status).toBe('fulfilled');
    expect(rollupRun.jobName).toBe('firebase-schedule-hourlyRollup-europe-west1');
    expect(rollupRun.scheduleTime).toBe('2026-11-21T16:00:00.000Z');
    expect(rollupRun.retryConfig).toEqual({ retryCount: 3, maxRetrySeconds: 120 });

    const rollupReceipt = await waitForRtdbValue<{
      jobName: string;
      scheduleTime: string;
      initStamp: string;
      contextEventId: string;
    }>(observer, 'scheduledReceipts/hourlyRollup');
    expect(rollupReceipt).toEqual({
      jobName: 'firebase-schedule-hourlyRollup-europe-west1',
      scheduleTime: '2026-11-21T16:00:00.000Z',
      initStamp: 'initialized-by-onInit',
      contextEventId: 'firebase-schedule-hourlyRollup-europe-west1',
    });

    // 2. Fire throwing `flakyBilling` and verify sibling scheduler + RTDB triggers stay alive.
    const failedRun = await activeRuntime.triggerScheduled('flakyBilling', {
      scheduleTime: '2026-11-21T16:15:00.000Z',
    });
    expect(failedRun.status).toBe('rejected');
    expect(failedRun.retryConfig).toEqual({ retryCount: 2 });

    const flakyReceipt = await waitForRtdbValue<{ scheduleTime: string }>(
      observer,
      'scheduledReceipts/flakyAttempt',
    );
    expect(flakyReceipt).toEqual({ scheduleTime: '2026-11-21T16:15:00.000Z' });

    // 3. Fire nested `digest-nightly` without passing `scheduleTime` (uses sandbox clock).
    const digestRun = await activeRuntime.triggerScheduled('digest-nightly');
    expect(digestRun.status).toBe('fulfilled');
    expect(digestRun.jobName).toBe('firebase-schedule-digest-nightly-us-central1');
    expect(digestRun.scheduleTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const digestReceipt = await waitForRtdbValue<{
      jobName: string;
      scheduleTime: string;
    }>(observer, 'scheduledReceipts/digestNightly');
    expect(digestReceipt).toEqual({
      jobName: 'firebase-schedule-digest-nightly-us-central1',
      scheduleTime: digestRun.scheduleTime,
    });

    // 4. Verify sibling RTDB `onValueCreated` trigger still fires in the same child process.
    await observer.rtdb.set('pings/p1', 'alive-after-scheduler-throw');
    const pingReceipt = await waitForRtdbValue<{ value: string }>(
      observer,
      'scheduledReceipts/pingEcho/p1',
    );
    expect(pingReceipt).toEqual({ value: 'alive-after-scheduler-throw' });

    // 5. Verify `execution-log.ts` recorded all three scheduled runs accurately.
    const records = listExecutions(hostCtx.sandbox);
    expect(records.map((rec) => [rec.id, rec.trigger, rec.status])).toEqual([
      ['1', 'hourlyRollup', 'fulfilled'],
      ['2', 'flakyBilling', 'rejected'],
      ['3', 'digest-nightly', 'fulfilled'],
    ]);
    expect(records[0]?.retryConfig).toEqual({ retryCount: 3, maxRetrySeconds: 120 });
    expect(records[1]?.retryConfig).toEqual({ retryCount: 2 });

    // Ensure child stops promptly (proving `process.on('message', ...)` did not lose `'stop'`).
    const stopStart = Date.now();
    await activeRuntime.close();
    expect(Date.now() - stopStart).toBeLessThan(1_800);
    activeRuntime = undefined;

    expect(devEvents.some((evt) => evt.type === 'unexpected-exit')).toBe(false);
  }, 20_000);

  test('loads and triggers top-level-await ESM onSchedule exports in isolated child', async () => {
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
      ready: { triggerCount: 1, unsupportedTriggers: [] },
    });

    const pulse = await activeRuntime.triggerScheduled('esmPulse', {
      scheduleTime: '2026-11-21T20:05:00.000Z',
    });
    expect(pulse.status).toBe('fulfilled');

    const receipt = await waitForRtdbValue<{
      jobName: string;
      scheduleTime: string;
    }>(observer, 'scheduledReceipts/esmPulse');
    expect(receipt).toEqual({
      jobName: 'firebase-schedule-esmPulse-us-central1',
      scheduleTime: '2026-11-21T20:05:00.000Z',
    });

    await activeRuntime.close();
    activeRuntime = undefined;
  }, 20_000);

  test('re-discovers newly added onSchedule exports across runtime.reload()', async () => {
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
      JSON.stringify({ name: 'scheduler-fn-reload', private: true, type: 'commonjs' }),
    );
    const entryPath = join(reloadDir, 'index.js');
    writeFileSync(
      entryPath,
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onSchedule } = require('firebase-functions/v2/scheduler');",
        'if (getApps().length === 0) initializeApp();',
        "exports.v1Job = onSchedule('0 * * * *', async (event) => {",
        "  await getDatabase().ref('scheduledReceipts/reloadV1').set({ at: event.scheduleTime });",
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
        "const { onSchedule } = require('firebase-functions/v2/scheduler');",
        'if (getApps().length === 0) initializeApp();',
        "exports.v1Job = onSchedule('0 * * * *', async (event) => {",
        "  await getDatabase().ref('scheduledReceipts/reloadV1').set({ at: event.scheduleTime });",
        '});',
        "exports.v2AddedJob = onSchedule('every 10 minutes', async (event) => {",
        "  await getDatabase().ref('scheduledReceipts/reloadV2').set({",
        '    jobName: event.jobName,',
        '    at: event.scheduleTime,',
        '  });',
        '});',
      ].join('\n'),
    );

    const reloaded = await activeRuntime.reload();
    expect(reloaded).toEqual({
      kind: 'ready',
      ready: { triggerCount: 2, unsupportedTriggers: [] },
    });

    const addedRun = await activeRuntime.triggerScheduled('v2AddedJob', {
      scheduleTime: '2026-11-21T21:10:00.000Z',
    });
    expect(addedRun.status).toBe('fulfilled');

    const receipt = await waitForRtdbValue<{ jobName: string; at: string }>(
      observer,
      'scheduledReceipts/reloadV2',
    );
    expect(receipt).toEqual({
      jobName: 'firebase-schedule-v2AddedJob-us-central1',
      at: '2026-11-21T21:10:00.000Z',
    });

    await activeRuntime.close();
    activeRuntime = undefined;
  }, 20_000);

  test('executes onSchedule against live Node HostedRuntime via spawnFunctionsChild + sendChildTriggerScheduled', async () => {
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
      JSON.stringify({ name: 'scheduler-hosted-fn', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(hostedDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onSchedule } = require('firebase-functions/v2/scheduler');",
        'if (getApps().length === 0) initializeApp();',
        "exports.hostedAudit = onSchedule('*/15 * * * *', async (event) => {",
        "  await getDatabase().ref('hostedAudit/latest').set({",
        '    jobName: event.jobName,',
        '    scheduleTime: event.scheduleTime,',
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

      const fired = await sendChildTriggerScheduled(childHandle.child, 'hostedAudit', {
        scheduleTime: '2026-11-21T22:15:00.000Z',
      });
      expect(fired.status).toBe('fulfilled');

      const receipt = await waitForRtdbValue<{ jobName: string; scheduleTime: string }>(
        hostedObserver,
        'hostedAudit/latest',
      );
      expect(receipt).toEqual({
        jobName: 'firebase-schedule-hostedAudit-us-central1',
        scheduleTime: '2026-11-21T22:15:00.000Z',
      });
    } finally {
      if (childHandle) await childHandle.stop();
      hostedObserver?.close();
      await hosted.stop();
    }
  }, 30_000);
});
