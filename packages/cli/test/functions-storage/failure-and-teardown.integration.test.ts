import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import type { FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  createFunctionsDevelopmentRuntime,
  createHttpFunctionsPeerReadiness,
  type FunctionsDevelopmentEvent,
} from '../../src/functions/development-runtime.js';
import {
  spawnFunctionsChild,
  type FunctionsChildHandle,
} from '../../src/functions/spawn.js';
import {
  connectRemoteSandbox,
  type RemoteSandbox,
} from '../../src/remote/index.js';
import {
  deleteObject as clientDeleteObject,
  getStorage as getClientStorage,
  ref as clientRef,
} from '../../src/serve/worker/client/storage.js';
import { trackTempDirs } from '../use-temp-dirs.js';
import {
  childModule,
  createChannelClientPort,
  repoRoot,
  startNodeHostedRuntime,
  waitForRtdbValue,
  type HostedNodeServer,
} from './hosted-harness.js';

function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH indicates the process has exited cleanly.
    return false;
  }
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

describe('v2 Storage trigger failure isolation and zero-leak child teardown on HostedRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-storage-hardening-');
  let hosted: HostedNodeServer | undefined;
  let observer: RemoteSandbox | undefined;
  let rootDir = '';

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    rootDir = tempDirs.makeTempDir();
    mkdirSync(join(rootDir, 'public'), { recursive: true });
    writeFileSync(join(rootDir, 'public/index.html'), '<!doctype html><body>hardening</body>');
    writeFileSync(
      join(rootDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );

    hosted = await startNodeHostedRuntime(rootDir, 'demo-project');
    observer = await connectRemoteSandbox({
      cwd: rootDir,
      url: hosted.url,
      sessionToken: hosted.sessionToken,
    });
  }, 30_000);

  afterAll(async () => {
    observer?.close();
    if (hosted) await hosted.stop();
    tempDirs.cleanupTempDirs();
  });

  test('reports rejected sync and async Storage handlers over IPC without blocking sibling triggers on the same or later mutations', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    const fnDir = join(tempDirs.makeTempDir(), 'functions');
    mkdirSync(join(fnDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'storage-fn-failures', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fnDir, 'index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { getStorage } = require('firebase-admin/storage');",
        "const { onObjectFinalized, onObjectDeleted } = require('firebase-functions/v2/storage');",
        'if (getApps().length === 0) initializeApp();',
        '',
        'exports.onBrokenSyncFinalized = onObjectFinalized((event) => {',
        "  if (!event.data.name.startsWith('failures/')) return;",
        "  throw new Error('SYNC_FINALIZED_BOOM:' + event.data.name);",
        '});',
        '',
        'exports.onBrokenAsyncFinalized = onObjectFinalized(async (event) => {',
        "  if (!event.data.name.startsWith('failures/')) return;",
        '  await Promise.resolve();',
        "  throw new Error('ASYNC_FINALIZED_BOOM:' + event.data.name);",
        '});',
        '',
        'exports.onHealthySiblingFinalized = onObjectFinalized(async (event) => {',
        "  if (!event.data.name.startsWith('failures/')) return;",
        '  const [bytes] = await getStorage()',
        '    .bucket(event.data.bucket)',
        '    .file(event.data.name)',
        '    .download();',
        "  const safe = event.data.name.replace(/[^a-zA-Z0-9_-]/g, '_');",
        "  await getDatabase().ref('healthyFinalized/' + safe).set(bytes.toString('utf8'));",
        '});',
        '',
        'exports.onBrokenDeleted = onObjectDeleted(async (event) => {',
        "  if (!event.data.name.startsWith('failures/')) return;",
        "  throw new Error('ASYNC_DELETED_BOOM:' + event.data.name);",
        '});',
        '',
        'exports.onHealthySiblingDeleted = onObjectDeleted(async (event) => {',
        "  if (!event.data.name.startsWith('failures/')) return;",
        "  const safe = event.data.name.replace(/[^a-zA-Z0-9_-]/g, '_');",
        "  await getDatabase().ref('healthyDeleted/' + safe).set(event.data.timeDeleted || 'missing');",
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fnDir, 'node_modules/firebase-functions'),
    );

    const events: FunctionsChildEvent[] = [];
    let handle: FunctionsChildHandle | undefined;
    try {
      handle = spawnFunctionsChild({
        cwd: fnDir,
        entry: join(fnDir, 'index.js'),
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
        onEvent: (event) => events.push(event),
      });

      const ready = await handle.ready;
      expect(ready.triggerCount).toBe(5);
      const pid = handle.child.pid;
      expect(isProcessAlive(pid)).toBe(true);

      await observer.storage.putBytes(
        'failures/first.txt',
        Buffer.from('first-payload', 'utf8'),
        { contentType: 'text/plain' },
      );
      expect(
        await waitForRtdbValue<string>(observer, 'healthyFinalized/failures_first_txt'),
      ).toBe('first-payload');

      const clientPort = createChannelClientPort(observer, {
        baseUrl: hosted.url,
        sessionToken: hosted.sessionToken,
      });
      const clientStorage = getClientStorage({
        __kind: 'client-db',
        type: 'firestore',
        port: clientPort,
      });
      await clientDeleteObject(clientRef(clientStorage, 'failures/first.txt'));
      const deletedAt = await waitForRtdbValue<string>(
        observer,
        'healthyDeleted/failures_first_txt',
      );
      expect(Number.isNaN(Date.parse(deletedAt))).toBe(false);

      // A subsequent upload still runs cleanly through the serialized execution queue.
      await observer.storage.putBytes(
        'failures/second.txt',
        Buffer.from('second-payload', 'utf8'),
        { contentType: 'text/plain' },
      );
      expect(
        await waitForRtdbValue<string>(observer, 'healthyFinalized/failures_second_txt'),
      ).toBe('second-payload');

      const rejected = events.filter(
        (item): item is Extract<FunctionsChildEvent, { type: 'execution'; status: 'rejected' }> =>
          item.type === 'execution' && item.status === 'rejected',
      );
      expect(
        rejected.map((item) => ({
          exportName: item.exportName,
          ref: item.ref,
          message: item.error.message,
        })),
      ).toEqual([
        {
          exportName: 'onBrokenSyncFinalized',
          ref: 'demo-project.appspot.com/failures/first.txt',
          message: 'SYNC_FINALIZED_BOOM:failures/first.txt',
        },
        {
          exportName: 'onBrokenAsyncFinalized',
          ref: 'demo-project.appspot.com/failures/first.txt',
          message: 'ASYNC_FINALIZED_BOOM:failures/first.txt',
        },
        {
          exportName: 'onBrokenDeleted',
          ref: 'demo-project.appspot.com/failures/first.txt',
          message: 'ASYNC_DELETED_BOOM:failures/first.txt',
        },
        {
          exportName: 'onBrokenSyncFinalized',
          ref: 'demo-project.appspot.com/failures/second.txt',
          message: 'SYNC_FINALIZED_BOOM:failures/second.txt',
        },
        {
          exportName: 'onBrokenAsyncFinalized',
          ref: 'demo-project.appspot.com/failures/second.txt',
          message: 'ASYNC_FINALIZED_BOOM:failures/second.txt',
        },
      ]);

      expect(await handle.stop()).toBe(0);
      expect(isProcessAlive(pid)).toBe(false);
      handle = undefined;
    } finally {
      if (handle) await handle.stop();
    }
  }, 25_000);

  test('survives out-of-band uncaughtException and unhandledRejection inside Storage triggers and keeps serving all lifecycle events', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    const fnDir = join(tempDirs.makeTempDir(), 'functions');
    mkdirSync(join(fnDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'storage-fn-uncaught', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fnDir, 'index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { getStorage } = require('firebase-admin/storage');",
        'const {',
        '  onObjectFinalized,',
        '  onObjectMetadataUpdated,',
        '  onObjectArchived,',
        '  onObjectDeleted,',
        "} = require('firebase-functions/v2/storage');",
        'if (getApps().length === 0) initializeApp();',
        '',
        'let seq = 0;',
        'async function logHealthy(kind, event) {',
        "  if (!event.data.name.startsWith('uncaught-suite/after/')) return;",
        '  seq += 1;',
        "  await getDatabase().ref('uncaughtSuite/e' + String(seq).padStart(3, '0')).set({",
        '    seq,',
        '    kind,',
        '    generation: event.data.generation,',
        '  });',
        '}',
        '',
        'exports.onEscapingFaults = onObjectFinalized((event) => {',
        "  if (event.data.name !== 'uncaught-suite/trigger-fault.txt') return;",
        '  setImmediate(() => {',
        "    throw new Error('ESCAPED_UNCAUGHT_EXCEPTION');",
        '  });',
        '  setImmediate(() => {',
        "    void Promise.reject(new Error('ESCAPED_UNHANDLED_REJECTION'));",
        '  });',
        '});',
        '',
        'exports.onAfterFinalized = onObjectFinalized(async (event) => {',
        "  if (!event.data.name.startsWith('uncaught-suite/after/')) return;",
        '  const [bytes] = await getStorage().bucket(event.data.bucket).file(event.data.name).download();',
        "  await getDatabase().ref('uncaughtSuite/latestBody').set(bytes.toString('utf8'));",
        "  await logHealthy('finalized', event);",
        '});',
        "exports.onAfterMeta = onObjectMetadataUpdated((event) => logHealthy('metadataUpdated', event));",
        "exports.onAfterArchived = onObjectArchived((event) => logHealthy('archived', event));",
        "exports.onAfterDeleted = onObjectDeleted((event) => logHealthy('deleted', event));",
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fnDir, 'node_modules/firebase-functions'),
    );

    const events: FunctionsChildEvent[] = [];
    let handle: FunctionsChildHandle | undefined;
    try {
      handle = spawnFunctionsChild({
        cwd: fnDir,
        entry: join(fnDir, 'index.js'),
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
        onEvent: (event) => events.push(event),
      });

      await handle.ready;
      const pid = handle.child.pid;

      await observer.storage.putBytes(
        'uncaught-suite/trigger-fault.txt',
        Buffer.from('fault', 'utf8'),
        { contentType: 'text/plain' },
      );

      await waitForCondition(
        () =>
          events.filter((item) => item.type === 'uncaught-error').length >= 2,
        'two uncaught-error child events',
      );
      const uncaughtMessages = events
        .filter(
          (item): item is Extract<FunctionsChildEvent, { type: 'uncaught-error' }> =>
            item.type === 'uncaught-error',
        )
        .map((item) => item.error.message)
        .sort();
      expect(uncaughtMessages).toEqual([
        'ESCAPED_UNCAUGHT_EXCEPTION',
        'ESCAPED_UNHANDLED_REJECTION',
      ]);
      expect(handle.child.exitCode).toBeNull();
      expect(isProcessAlive(pid)).toBe(true);

      // Verify all 4 lifecycle triggers still execute cleanly in the same surviving child process.
      const targetPath = 'uncaught-suite/after/doc.txt';
      await observer.storage.putBytes(targetPath, Buffer.from('alive-v1', 'utf8'), {
        contentType: 'text/plain',
      });
      await observer.channel.op({
        method: 'storage.setMetadata',
        path: targetPath,
        patch: { customMetadata: { survived: 'true' } },
        actAs: { mode: 'admin' },
      });
      await observer.storage.putBytes(targetPath, Buffer.from('alive-v2', 'utf8'), {
        contentType: 'text/plain',
      });
      await waitForCondition(async () => {
        const raw = (await observer?.rtdb.get('uncaughtSuite')) as Record<string, unknown> | null;
        if (raw === null) return false;
        return 'e004' in raw;
      }, 'first four post-uncaught lifecycle events before delete');

      await observer.storage.deleteObject(targetPath);

      await waitForCondition(async () => {
        const raw = (await observer?.rtdb.get('uncaughtSuite')) as Record<string, unknown> | null;
        if (raw === null) return false;
        return 'e005' in raw;
      }, 'all five post-uncaught lifecycle events');

      const logMap = (await observer.rtdb.get('uncaughtSuite')) as Record<
        string,
        { seq?: number; kind?: string } | string
      >;
      const orderedKinds = [logMap.e001, logMap.e002, logMap.e003, logMap.e004, logMap.e005].map(
        (entry) => (typeof entry === 'object' && entry !== null ? entry.kind : undefined),
      );
      expect(orderedKinds).toEqual([
        'finalized',
        'metadataUpdated',
        'archived',
        'finalized',
        'deleted',
      ]);
      expect(logMap.latestBody).toBe('alive-v2');

      expect(await handle.stop()).toBe(0);
      expect(isProcessAlive(pid)).toBe(false);
      handle = undefined;
    } finally {
      if (handle) await handle.stop();
    }
  }, 25_000);

  test('reloads and closes via createFunctionsDevelopmentRuntime without duplicate deliveries, unexpected exits, or leaked PIDs', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    const fnDir = join(tempDirs.makeTempDir(), 'functions');
    mkdirSync(join(fnDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'storage-fn-reload', private: true, type: 'commonjs' }),
    );
    const writeSource = (versionTag: string): void => {
      writeFileSync(
        join(fnDir, 'index.js'),
        [
          "const { initializeApp, getApps } = require('firebase-admin/app');",
          "const { getDatabase } = require('firebase-admin/database');",
          "const { onObjectFinalized } = require('firebase-functions/v2/storage');",
          'if (getApps().length === 0) initializeApp();',
          'exports.onReloadWatch = onObjectFinalized(async (event) => {',
          "  if (!event.data.name.startsWith('reload-suite/')) return;",
          "  const safe = event.data.name.replace(/[^a-zA-Z0-9_-]/g, '_');",
          `  await getDatabase().ref('reloadSuite/' + safe + '/' + ${JSON.stringify(versionTag)} + '_' + process.pid).set(true);`,
          '});',
        ].join('\n'),
      );
    };
    writeSource('v1');
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fnDir, 'node_modules/firebase-functions'),
    );

    const spawnedPids: number[] = [];
    const devEvents: FunctionsDevelopmentEvent[] = [];
    const runtime = createFunctionsDevelopmentRuntime({
      sourceDir: fnDir,
      entry: join(fnDir, 'index.js'),
      baseEnv: process.env,
      serveUrl: hosted.url,
      registerUrl: registerModuleUrl(),
      hostInstanceId: hosted.instanceId,
      sessionToken: hosted.sessionToken,
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-project',
      childModuleUrl: pathToFileURL(childModule),
      readiness: createHttpFunctionsPeerReadiness(hosted.url),
      onEvent: (event) => devEvents.push(event),
      spawn(spawnOpts) {
        const handle = spawnFunctionsChild(spawnOpts);
        if (typeof handle.child.pid === 'number') {
          spawnedPids.push(handle.child.pid);
        }
        return handle;
      },
    });

    try {
      const firstStart = await runtime.start();
      expect(firstStart).toEqual({
        kind: 'ready',
        ready: { triggerCount: 1, unsupportedTriggers: [] },
      });
      expect(spawnedPids).toHaveLength(1);
      const firstPid = spawnedPids[0];
      expect(isProcessAlive(firstPid)).toBe(true);

      await observer.storage.putBytes(
        'reload-suite/item-one.txt',
        Buffer.from('one', 'utf8'),
        { contentType: 'text/plain' },
      );
      const firstMap = await waitForRtdbValue<Record<string, boolean>>(
        observer,
        'reloadSuite/reload-suite_item-one_txt',
      );
      expect(Object.keys(firstMap)).toEqual([`v1_${firstPid}`]);

      // Swap source to v2 and reload; old child must exit cleanly and unsubscribe from host.
      writeSource('v2');
      const reloaded = await runtime.reload();
      expect(reloaded).toEqual({
        kind: 'ready',
        ready: { triggerCount: 1, unsupportedTriggers: [] },
      });
      expect(spawnedPids).toHaveLength(2);
      const secondPid = spawnedPids[1];
      expect(secondPid).not.toBe(firstPid);
      expect(isProcessAlive(firstPid)).toBe(false);
      expect(isProcessAlive(secondPid)).toBe(true);

      await observer.storage.putBytes(
        'reload-suite/item-two.txt',
        Buffer.from('two', 'utf8'),
        { contentType: 'text/plain' },
      );
      const secondMap = await waitForRtdbValue<Record<string, boolean>>(
        observer,
        'reloadSuite/reload-suite_item-two_txt',
      );
      expect(Object.keys(secondMap)).toEqual([`v2_${secondPid}`]);

      await runtime.close();
      expect(isProcessAlive(secondPid)).toBe(false);

      // Mutation after close produces zero deliveries and zero unexpected-exit events.
      await observer.storage.putBytes(
        'reload-suite/item-after-close.txt',
        Buffer.from('three', 'utf8'),
        { contentType: 'text/plain' },
      );
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
      expect(await observer.rtdb.get('reloadSuite/reload-suite_item-after-close_txt')).toBeNull();
      expect(devEvents.filter((item) => item.type === 'unexpected-exit')).toEqual([]);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  test('drains an in-flight async Storage handler cleanly on stop() with exit code 0 and zero leftover child processes', async () => {
    if (!hosted || !observer) throw new Error('hosted runtime not initialized');
    const fnDir = join(tempDirs.makeTempDir(), 'functions');
    mkdirSync(join(fnDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'storage-fn-drain', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fnDir, 'index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { getStorage } = require('firebase-admin/storage');",
        "const { onObjectFinalized } = require('firebase-functions/v2/storage');",
        'if (getApps().length === 0) initializeApp();',
        'exports.onInFlightDrain = onObjectFinalized(async (event) => {',
        "  if (event.data.name !== 'drain-suite/slow.txt') return;",
        "  await getDatabase().ref('drainSuite/started').set(true);",
        '  await new Promise((resolve) => setTimeout(resolve, 150));',
        '  const [bytes] = await getStorage().bucket(event.data.bucket).file(event.data.name).download();',
        "  await getDatabase().ref('drainSuite/completed').set(bytes.toString('utf8'));",
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fnDir, 'node_modules/firebase-functions'),
    );

    let handle: FunctionsChildHandle | undefined;
    try {
      handle = spawnFunctionsChild({
        cwd: fnDir,
        entry: join(fnDir, 'index.js'),
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
      await handle.ready;
      const pid = handle.child.pid;

      await observer.storage.putBytes(
        'drain-suite/slow.txt',
        Buffer.from('drained-cleanly', 'utf8'),
        { contentType: 'text/plain' },
      );
      await waitForRtdbValue<boolean>(observer, 'drainSuite/started');

      // Stop while the 150ms sleep + download() is still in flight; child.ts awaits storageHost.idle().
      const exitCode = await handle.stop();
      expect(exitCode).toBe(0);
      expect(isProcessAlive(pid)).toBe(false);
      expect(await observer.rtdb.get('drainSuite/completed')).toBe('drained-cleanly');
      handle = undefined;
    } finally {
      if (handle) await handle.stop();
    }
  }, 25_000);
});
