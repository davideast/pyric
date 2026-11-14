/**
 * Mirrored unit tests for `src/bridge/surface/functions-child-runner.ts`:
 * verifies the isolated Swap-or-Stop child runner executes discovery and
 * synthetic RTDB `onValueCreated` triggers with `GOOGLE_APPLICATION_CREDENTIALS`
 * stripped and `pyric-admin` bridged back to the caller's sandbox.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { get as getRtdb, ref as rtdbRef } from 'pyric/database';
import { doc as firestoreDoc, getDoc, getFirestore } from 'pyric/firestore';
import { createSurfaceContext } from '../../../src/bridge/surface/index.js';
import {
  discoverFunctionsTriggers,
  fireFunctionsTriggerIsolated,
} from '../../../src/bridge/surface/functions-runtime.js';
import { FUNCTIONS_RUNNER_CHILD_ENV } from '../../../src/bridge/surface/functions-child-runner.js';
import { databaseFor } from '../../../src/bridge/surface/service-handles.js';

describe('functions-child-runner isolated execution', () => {
  it('discovers and executes RTDB triggers in a Swap-or-Stop child bridged over IPC', async () => {
    expect(FUNCTIONS_RUNNER_CHILD_ENV).toBe('PYRIC_FUNCTIONS_RUNNER_CHILD');

    const dir = mkdtempSync(join(tmpdir(), 'pyric-fn-runner-test-'));
    const fnDir = join(dir, 'functions');
    mkdirSync(fnDir, { recursive: true });
    symlinkSync(
      resolve(import.meta.dir, '../../../../conformance/node_modules'),
      join(fnDir, 'node_modules'),
      'dir',
    );
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'demo-runner-fn', type: 'module', main: 'index.mjs' }),
    );
    writeFileSync(
      join(fnDir, 'index.mjs'),
      [
        "import { onValueCreated } from 'firebase-functions/v2/database';",
        "import { getApps, initializeApp } from 'firebase-admin/app';",
        "export const onNoteCreated = onValueCreated('/notes/{noteId}', async (event) => {",
        "  const app = getApps()[0] ?? initializeApp();",
        "  await event.data.ref.parent.child('summary').set(String(event.data.val()?.body ?? ''));",
        "  return { swapped: 'sandbox' in app, adc: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null };",
        "});",
      ].join('\n'),
    );

    const prevAdc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'synthetic-runner-adc.json';
    const sandbox = initializeSandbox();
    try {
      const discovered = await discoverFunctionsTriggers(dir);
      expect(discovered.triggers.map((t) => t.exportName)).toEqual(['onNoteCreated']);

      const ctx = createSurfaceContext(sandbox, dir);
      const firedParams: Record<string, string>[] = [];
      const outcome = await fireFunctionsTriggerIsolated(ctx, {
        triggerName: 'onNoteCreated',
        path: 'notes/n1',
        ref: 'notes/n1',
        value: { body: 'isolated-ok' },
        timeoutMs: 10_000,
        onFiring(_trigger, params) {
          firedParams.push(params);
        },
      });
      expect(outcome.kind).toBe('executed');
      if (outcome.kind === 'executed') {
        expect(outcome.status).toBe('fulfilled');
        expect(outcome.result).toEqual({ swapped: true, adc: null });
      }
      expect(firedParams).toEqual([{ noteId: 'n1' }]);

      const summarySnap = await getRtdb(rtdbRef(databaseFor(ctx), 'notes/summary'));
      expect(summarySnap.val()).toBe('isolated-ok');
    } finally {
      if (prevAdc === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = prevAdc;
      sandbox.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('executes queued RTDB onDisconnect ops, resolves default instance URLs on secondary apps, and cleans up listeners on exit and timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-fn-runner-disconnect-'));
    const fnDir = join(dir, 'functions');
    mkdirSync(fnDir, { recursive: true });
    symlinkSync(
      resolve(import.meta.dir, '../../../../conformance/node_modules'),
      join(fnDir, 'node_modules'),
      'dir',
    );
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'demo-disconnect-fn', type: 'module', main: 'index.mjs' }),
    );
    writeFileSync(
      join(fnDir, 'index.mjs'),
      [
        "import { onValueCreated } from 'firebase-functions/v2/database';",
        "import { getApps, initializeApp } from 'firebase-admin/app';",
        "import { getDatabaseWithUrl } from 'firebase-admin/database';",
        "export const onSessionOpened = onValueCreated('/sessions/{sessionId}', async (event) => {",
        "  const primary = getApps()[0] ?? initializeApp();",
        "  const aux = initializeApp({}, 'aux-worker');",
        "  const auxDb = getDatabaseWithUrl('https://demo-proj-default-rtdb.firebaseio.com', aux);",
        "  auxDb.ref('/watched/aux').on('value', () => {});",
        "  await auxDb.ref('/status/' + event.params.sessionId).set('active');",
        "  await primary.sandbox.channel.op({",
        "    method: 'rtdb.onDisconnectSet',",
        "    path: '/presence/' + event.params.sessionId,",
        "    value: 'disconnected',",
        "    actAs: { mode: 'admin' },",
        "  });",
        "  return { ok: true };",
        "});",
        "export const onSlowSession = onValueCreated('/slow/{sessionId}', async (event) => {",
        "  const primary = getApps()[0] ?? initializeApp();",
        "  const aux = initializeApp({}, 'aux-slow');",
        "  const auxDb = getDatabaseWithUrl('https://demo-proj-default-rtdb.firebaseio.com', aux);",
        "  auxDb.ref('/watched/slow').on('value', () => {});",
        "  await primary.sandbox.channel.op({",
        "    method: 'rtdb.onDisconnectSet',",
        "    path: '/presence/' + event.params.sessionId,",
        "    value: 'timed-out-disconnected',",
        "    actAs: { mode: 'admin' },",
        "  });",
        "  await new Promise(() => {});",
        "});",
      ].join('\n'),
    );

    const sandbox = initializeSandbox();
    try {
      const ctx = createSurfaceContext(sandbox, dir);
      const outcome = await fireFunctionsTriggerIsolated(ctx, {
        triggerName: 'onSessionOpened',
        path: 'sessions/s1',
        ref: 'sessions/s1',
        value: { active: true },
        timeoutMs: 10_000,
        onFiring() {},
      });
      expect(outcome.kind).toBe('executed');

      const db = databaseFor(ctx);
      const statusSnap = await getRtdb(rtdbRef(db, 'status/s1'));
      expect(statusSnap.val()).toBe('active');
      const presenceSnap = await getRtdb(rtdbRef(db, 'presence/s1'));
      expect(presenceSnap.val()).toBe('disconnected');

      const slowOutcome = await fireFunctionsTriggerIsolated(ctx, {
        triggerName: 'onSlowSession',
        path: 'slow/s2',
        ref: 'slow/s2',
        value: { active: true },
        timeoutMs: 200,
        onFiring() {},
      });
      expect(slowOutcome.kind).toBe('timed-out');

      const slowPresenceSnap = await getRtdb(rtdbRef(db, 'presence/s2'));
      expect(slowPresenceSnap.val()).toBe('timed-out-disconnected');
    } finally {
      sandbox.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the default app uninitialized at module load so top-level initializeApp(options) configures [DEFAULT]', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-fn-runner-default-app-'));
    const fnDir = join(dir, 'functions');
    mkdirSync(fnDir, { recursive: true });
    symlinkSync(
      resolve(import.meta.dir, '../../../../conformance/node_modules'),
      join(fnDir, 'node_modules'),
      'dir',
    );
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'org-alpha' } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'demo-default-app-fn', type: 'module', main: 'index.mjs' }),
    );
    writeFileSync(
      join(fnDir, 'index.mjs'),
      [
        "import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';",
        "import { getStorage } from 'firebase-admin/storage';",
        "import { onValueCreated } from 'firebase-functions/v2/database';",
        "const initialAppsCount = getApps().length;",
        "if (getApps().length === 0) {",
        "  initializeApp({ credential: applicationDefault(), storageBucket: 'custom-media.appspot.com' });",
        "}",
        "export const onItemCreated = onValueCreated('/items/{itemId}', async (event) => {",
        "  await event.data.ref.parent.child('copied').set(event.data.val());",
        "  return {",
        "    initialAppsCount,",
        "    configuredBucketOption: getApp().options.storageBucket ?? null,",
        "    defaultBucket: getStorage().bucket().name,",
        "  };",
        "});",
      ].join('\n'),
    );

    const sandbox = initializeSandbox();
    try {
      const discovered = await discoverFunctionsTriggers(dir);
      expect(discovered.triggers.map((t) => t.exportName)).toEqual(['onItemCreated']);

      const ctx = createSurfaceContext(sandbox, dir);
      const outcome = await fireFunctionsTriggerIsolated(ctx, {
        triggerName: 'onItemCreated',
        path: 'items/i1',
        ref: 'items/i1',
        value: 'hello',
        timeoutMs: 10_000,
        onFiring() {},
      });
      expect(outcome.kind).toBe('executed');
      if (outcome.kind === 'executed') {
        expect(outcome.status).toBe('fulfilled');
        expect(outcome.result).toEqual({
          initialAppsCount: 0,
          configuredBucketOption: 'custom-media.appspot.com',
          defaultBucket: 'custom-media.appspot.com',
        });
      }
      const copiedSnap = await getRtdb(rtdbRef(databaseFor(ctx), 'items/copied'));
      expect(copiedSnap.val()).toBe('hello');
    } finally {
      sandbox.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports try/catch getApp(), onInit(initializeApp(options)), cold-start handler initializeApp(options), and no-arg getDatabase() without pre-claiming [DEFAULT]', async () => {
    const runVariant = async (
      label: string,
      moduleLines: string[],
    ): Promise<Record<string, unknown>> => {
      const dir = mkdtempSync(join(tmpdir(), `pyric-fn-init-${label}-`));
      const fnDir = join(dir, 'functions');
      mkdirSync(fnDir, { recursive: true });
      symlinkSync(
        resolve(import.meta.dir, '../../../../conformance/node_modules'),
        join(fnDir, 'node_modules'),
        'dir',
      );
      writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'org-alpha' } }));
      writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
      writeFileSync(
        join(fnDir, 'package.json'),
        JSON.stringify({ name: `fn-${label}`, type: 'module', main: 'index.mjs' }),
      );
      writeFileSync(join(fnDir, 'index.mjs'), moduleLines.join('\n'));
      const sandbox = initializeSandbox();
      try {
        const ctx = createSurfaceContext(sandbox, dir);
        const outcome = await fireFunctionsTriggerIsolated(ctx, {
          triggerName: 'onItemCreated',
          path: 'items/i1',
          ref: 'items/i1',
          value: 'payload',
          timeoutMs: 10_000,
          onFiring() {},
        });
        expect(outcome.kind).toBe('executed');
        if (outcome.kind !== 'executed' || outcome.status !== 'fulfilled') {
          throw new Error(`unexpected ${label} outcome: ${JSON.stringify(outcome)}`);
        }
        return outcome.result as Record<string, unknown>;
      } finally {
        sandbox.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    };

    const tryCatchResult = await runVariant('try-catch', [
      "import { getApp, initializeApp } from 'firebase-admin/app';",
      "import { getStorage } from 'firebase-admin/storage';",
      "import { onValueCreated } from 'firebase-functions/v2/database';",
      'let getAppThrew = false;',
      'try { getApp(); } catch { getAppThrew = true; initializeApp({ storageBucket: "archive-bucket" }); }',
      "export const onItemCreated = onValueCreated('/items/{itemId}', async () => ({",
      '  getAppThrew,',
      '  bucketOption: getApp().options.storageBucket ?? null,',
      '  bucketName: getStorage().bucket().name,',
      '}));',
    ]);
    expect(tryCatchResult).toEqual({
      getAppThrew: true,
      bucketOption: 'archive-bucket',
      bucketName: 'archive-bucket',
    });

    const onInitResult = await runVariant('on-init', [
      "import { getApp, initializeApp } from 'firebase-admin/app';",
      "import { getStorage } from 'firebase-admin/storage';",
      "import { onInit } from 'firebase-functions/v2/core';",
      "import { onValueCreated } from 'firebase-functions/v2/database';",
      'onInit(() => { initializeApp({ storageBucket: "oninit-bucket" }); });',
      "export const onItemCreated = onValueCreated('/items/{itemId}', async () => ({",
      '  bucketOption: getApp().options.storageBucket ?? null,',
      '  bucketName: getStorage().bucket().name,',
      '}));',
    ]);
    expect(onInitResult).toEqual({
      bucketOption: 'oninit-bucket',
      bucketName: 'oninit-bucket',
    });

    const handlerInitResult = await runVariant('handler-init', [
      "import { getApp, initializeApp } from 'firebase-admin/app';",
      "import { getStorage } from 'firebase-admin/storage';",
      "import { onValueCreated } from 'firebase-functions/v2/database';",
      "export const onItemCreated = onValueCreated('/items/{itemId}', async () => {",
      '  initializeApp({ storageBucket: "handler-bucket" });',
      '  return {',
      '    bucketOption: getApp().options.storageBucket ?? null,',
      '    bucketName: getStorage().bucket().name,',
      '  };',
      '});',
    ]);
    expect(handlerInitResult).toEqual({
      bucketOption: 'handler-bucket',
      bucketName: 'handler-bucket',
    });

    const noInitResult = await runVariant('no-init-service', [
      "import { getDatabase } from 'firebase-admin/database';",
      "import { getFirestore } from 'firebase-admin/firestore';",
      "import { onValueCreated } from 'firebase-functions/v2/database';",
      "export const onItemCreated = onValueCreated('/items/{itemId}', async (event) => {",
      "  await getDatabase().ref('/echo/' + event.params.itemId).set(event.data.val());",
      "  await getFirestore().doc('echo/' + event.params.itemId).set({ ok: true });",
      "  const snap = await getDatabase().ref('/echo/' + event.params.itemId).get();",
      '  return { echoed: snap.val() };',
      '});',
    ]);
    expect(noInitResult).toEqual({ echoed: 'payload' });
  });

  it('bridges Worker threads spawned inside in-process functions.fire back to ctx.sandbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-fn-runner-worker-'));
    const fnDir = join(dir, 'functions');
    mkdirSync(fnDir, { recursive: true });
    symlinkSync(
      resolve(import.meta.dir, '../../../../conformance/node_modules'),
      join(fnDir, 'node_modules'),
      'dir',
    );
    writeFileSync(join(dir, 'pyric.json'), JSON.stringify({ project: 'org-alpha' }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'demo-worker-fn', type: 'module', main: 'index.mjs' }),
    );
    writeFileSync(
      join(fnDir, 'worker-task.mjs'),
      [
        "import { parentPort, workerData } from 'node:worker_threads';",
        "import { getApps, initializeApp } from 'firebase-admin/app';",
        "import { getFirestore } from 'firebase-admin/firestore';",
        "if (getApps().length === 0) initializeApp();",
        "await getFirestore().doc('jobs/' + workerData.jobId).set({ stage: 'file-worker-done' });",
        "parentPort.postMessage('file-ok');",
      ].join('\n'),
    );
    writeFileSync(
      join(fnDir, 'index.mjs'),
      [
        "import { Worker } from 'node:worker_threads';",
        "import { fileURLToPath } from 'node:url';",
        "import { onValueCreated } from 'firebase-functions/v2/database';",
        "export const onJobCreated = onValueCreated('/jobs/{jobId}', async (event) => {",
        "  const jobId = event.params.jobId;",
        "  const evalCode = [",
        "    \"const { parentPort } = require('node:worker_threads');\",",
        "    \"const { getApps, initializeApp } = require('firebase-admin/app');\",",
        "    \"const { getDatabase } = require('firebase-admin/database');\",",
        "    \"(async () => {\",",
        "    \"  const app = getApps()[0] || initializeApp();\",",
        "    \"  await getDatabase(app).ref('/workerResults/' + \" + JSON.stringify(jobId) + \").set('eval-ok');\",",
        "    \"  parentPort.postMessage('eval-ok');\",",
        "    \"})().catch((err) => { throw err; });\",",
        "  ].join('\\n');",
        "  const runWorker = (target, options) => new Promise((resolveWorker, rejectWorker) => {",
        "    const worker = new Worker(target, options);",
        "    worker.once('message', (msg) => resolveWorker(msg));",
        "    worker.once('error', rejectWorker);",
        "    worker.once('exit', (code) => {",
        "      if (code !== 0) rejectWorker(new Error('worker exited ' + code));",
        "    });",
        "  });",
        "  const evalReply = await runWorker(evalCode, { eval: true });",
        "  const fileUrl = fileURLToPath(new URL('./worker-task.mjs', import.meta.url));",
        "  const fileReply = await runWorker(fileUrl, { workerData: { jobId } });",
        "  return { evalReply, fileReply };",
        "});",
      ].join('\n'),
    );

    const sandbox = initializeSandbox();
    try {
      const ctx = createSurfaceContext(sandbox, dir);
      const outcome = await fireFunctionsTriggerIsolated(ctx, {
        triggerName: 'onJobCreated',
        path: 'jobs/j1',
        ref: 'jobs/j1',
        value: { queued: true },
        timeoutMs: 10_000,
        onFiring() {},
      });
      expect(outcome.kind).toBe('executed');
      if (outcome.kind === 'executed') {
        expect(outcome.status).toBe('fulfilled');
        expect(outcome.result).toEqual({ evalReply: 'eval-ok', fileReply: 'file-ok' });
      }
      const rtdbSnap = await getRtdb(rtdbRef(databaseFor(ctx), 'workerResults/j1'));
      expect(rtdbSnap.val()).toBe('eval-ok');
      const docSnap = await getDoc(firestoreDoc(getFirestore(sandbox), 'jobs/j1'));
      expect(docSnap.data()).toEqual({ stage: 'file-worker-done' });
    } finally {
      sandbox.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
