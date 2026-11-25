import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  spawnFunctionsChild,
  type FunctionsChildHandle,
} from '../../src/functions/spawn.js';
import { type FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  buildChildEnv,
  registerModuleUrl,
} from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from './worker-peer.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions/child.js');

let fixtureDir: string;
let runtime: ServeRuntime;
let peer: { close(): Promise<void> };
let observer: RemoteSandbox;
let child: FunctionsChildHandle | undefined;

async function waitForValue(path: string, expected: unknown): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await observer.rtdb.get(path)) === expected) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error(`timed out waiting for ${path}=${JSON.stringify(expected)}`);
}

/**
 * Wait for `count` events. The child reports an execution after the function
 * returns, so its writes can land before its event does.
 */
async function waitForEvents(events: readonly FunctionsChildEvent[], count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (events.length < count && Date.now() < deadline) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
}

beforeAll(async () => {
  if (!existsSync(childModule)) {
    throw new Error(`Functions child is not built -- run bun run --cwd packages/cli build (${childModule})`);
  }
  fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-functions-child-'));
  mkdirSync(join(fixtureDir, 'public'));
  mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
  writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(
    join(fixtureDir, 'firebase.json'),
    JSON.stringify({ hosting: { public: 'public' } }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/package.json'),
    JSON.stringify({ name: 'unchanged-functions', private: true, type: 'commonjs' }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/index.js'),
    `const { onValueCreated } = require('firebase-functions/v2/database');
const functionsV1 = require('firebase-functions/v1');
exports.makeUppercase = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent.child('uppercase').set(event.data.val().toUpperCase()),
);
exports.messages = {
  markProcessed: onValueCreated(
    '/messages/{pushId}/uppercase',
    event => event.data.ref.parent.child('processed').set(
      event.params.pushId + ':' + event.data.val()
    ),
  ),
};
exports.omitted = onValueCreated(
  { ref: '/omitted/{id}', omit: true },
  () => undefined,
);
exports.unsupportedLegacyV1 = functionsV1.database.ref('/messages/{pushId}').onUpdate(
  () => null,
);
exports.unsupportedPattern = onValueCreated(
  '/messages/{pushId=prefix/*}',
  () => undefined,
);
exports.unsupportedInstance = onValueCreated(
  { ref: '/messages/{pushId}', instance: 'db-*' },
  () => undefined,
);
`,
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(fixtureDir, 'functions/node_modules/firebase-functions'),
  );
  mkdirSync(join(fixtureDir, 'functions-esm/node_modules'), { recursive: true });
  writeFileSync(
    join(fixtureDir, 'functions-esm/package.json'),
    JSON.stringify({
      name: 'unchanged-functions-esm',
      private: true,
      type: 'module',
      main: 'index.js',
    }),
  );
  writeFileSync(
    join(fixtureDir, 'functions-esm/index.js'),
    `import { onValueCreated } from 'firebase-functions/v2/database';
await Promise.resolve();
export const makeUppercase = onValueCreated(
  '/esm-messages/{pushId}/original',
  event => event.data.ref.parent.child('uppercase').set(event.data.val().toUpperCase()),
);
`,
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(fixtureDir, 'functions-esm/node_modules/firebase-functions'),
  );

  runtime = await startServe({
    cwd: fixtureDir,
    port: 0,
    cacheRoot: join(fixtureDir, '.cache'),
    logger: silentServeLogger(),
    bridge: true,
    disableAuditLog: true,
  });
  const ctx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'functions-child',
    instanceId: 'functions-child-test',
  });
  peer = await connectFunctionsWorkerPeer({
    url: `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
    ctx,
    sandboxId: 'functions-child-peer',
  });
  observer = await connectRemoteSandbox({ url: runtime.handle.url });
});

afterAll(async () => {
  if (child) await child.stop();
  observer?.close();
  if (peer) await peer.close();
  if (runtime) await runtime.handle.stop();
});

describe('isolated Functions RTDB child', () => {
  test('loads unchanged CommonJS source and writes back into the same remote sandbox', async () => {
    const events: FunctionsChildEvent[] = [];
    child = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      onEvent: (event) => events.push(event),
    });

    expect(await child.ready).toEqual({
      triggerCount: 2,
      unsupportedTriggers: [{
        exportName: 'omitted',
        eventType: 'google.firebase.database.ref.v1.created (omitted from emulation)',
      }, {
        exportName: 'unsupportedPattern',
        eventType: 'google.firebase.database.ref.v1.created (unsupported ref pattern: messages/{pushId=prefix/*})',
      }, {
        exportName: 'unsupportedInstance',
        eventType: 'google.firebase.database.ref.v1.created (unsupported instance pattern: db-*)',
      }, {
        exportName: 'unsupportedLegacyV1',
        eventType: 'providers/google.firebase.database/eventTypes/ref.update',
      }],
    });
    await observer.rtdb.set('messages/id/original', 'hello');
    await waitForValue('messages/id/uppercase', 'HELLO');
    await waitForValue('messages/id/processed', 'id:HELLO');
    await waitForEvents(events, 2);

    expect(events).toContainEqual({
      type: 'execution',
      exportName: 'makeUppercase',
      ref: 'messages/id/original',
      params: { pushId: 'id' },
      status: 'fulfilled',
    });
    expect(events).toContainEqual({
      type: 'execution',
      exportName: 'messages-markProcessed',
      ref: 'messages/id/uppercase',
      params: { pushId: 'id' },
      status: 'fulfilled',
    });
    expect(await child.stop()).toBe(0);
  }, 15_000);

  test('loads unchanged ESM source and writes back into the same remote sandbox', async () => {
    const events: FunctionsChildEvent[] = [];
    child = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions-esm'),
      entry: join(fixtureDir, 'functions-esm/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      onEvent: (event) => events.push(event),
    });

    expect(await child.ready).toEqual({
      triggerCount: 1,
      unsupportedTriggers: [],
    });
    await observer.rtdb.set('esm-messages/id/original', 'hello');
    await waitForEvents(events, 1);
    expect(events).toContainEqual({
      type: 'execution',
      exportName: 'makeUppercase',
      ref: 'esm-messages/id/original',
      params: { pushId: 'id' },
      status: 'fulfilled',
    });
    await waitForValue('esm-messages/id/uppercase', 'HELLO');
    expect(await child.stop()).toBe(0);
  }, 15_000);

  test('injects synthetic GCLOUD_PROJECT and FIREBASE_CONFIG without warning in stderr', async () => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.GCLOUD_PROJECT;
    delete cleanEnv.FIREBASE_CONFIG;
    let stderr = '';
    child = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(cleanEnv, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
      projectId: 'my-custom-proj',
    });
    child.child.stderr?.setEncoding('utf8');
    child.child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const ready = await child.ready;
    expect(ready.triggerCount).toBe(2);
    expect(stderr).not.toContain('FIREBASE_CONFIG and GCLOUD_PROJECT environment variables are missing');
    expect(await child.stop()).toBe(0);
  }, 15_000);

  test('a trigger on a named instance fires on that instance and writes back to it', async () => {
    const entry = join(fixtureDir, 'functions/shard.cjs');
    writeFileSync(entry, `const { onValueCreated } = require('firebase-functions/v2/database');
exports.makeUppercase = onValueCreated(
  { ref: '/shard-messages/{id}/original', instance: 'demo-project-shard-1' },
  event => event.data.ref.parent.child('uppercase').set(event.data.val().toUpperCase()),
);
`);
    child = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry,
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
    });
    expect((await child.ready).triggerCount).toBe(1);
    const shard = observer.rtdb.forInstance('demo-project-shard-1');

    // A write to the default instance at the trigger's path does not fire it.
    await observer.rtdb.set('shard-messages/other/original', 'default');
    await shard.set('shard-messages/id/original', 'hello');
    const deadline = Date.now() + 5_000;
    while ((await shard.get('shard-messages/id/uppercase')) !== 'HELLO' && Date.now() < deadline) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
    }

    expect(await shard.get('shard-messages/id/uppercase')).toBe('HELLO');
    expect(await observer.rtdb.get('shard-messages/id')).toBeNull();
    expect(await observer.rtdb.get('shard-messages/other/uppercase')).toBeNull();
    expect(await child.stop()).toBe(0);
  }, 15_000);

  test('rejects exports spanning more than one effective database instance', async () => {
    const entry = join(fixtureDir, 'functions/multi-instance.cjs');
    writeFileSync(entry, `const { onValueCreated } = require('firebase-functions/v2/database');
exports.first = onValueCreated({ ref: '/first/{id}', instance: 'first-rtdb' }, () => undefined);
exports.second = onValueCreated({ ref: '/second/{id}', instance: 'second-rtdb' }, () => undefined);
`);
    child = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry,
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
    });

    await expect(child.ready).rejects.toThrow(
      'Functions RTDB first slice supports one database instance; found first-rtdb, second-rtdb',
    );
    expect(await child.exited).toBe(1);
  });

  test('loads module with zero pre-initialized apps so top-level initializeApp(options) configures [DEFAULT]', async () => {
    const entry = join(fixtureDir, 'functions/custom-init.cjs');
    writeFileSync(
      entry,
      [
        "const { applicationDefault, getApp, getApps, initializeApp } = require('firebase-admin/app');",
        "const { getStorage } = require('firebase-admin/storage');",
        "const { onValueCreated } = require('firebase-functions/v2/database');",
        "const initialAppsCount = getApps().length;",
        "initializeApp({ credential: applicationDefault(), storageBucket: 'custom-child.appspot.com' });",
        "exports.recordAppState = onValueCreated('/app-init/{id}', async (event) => {",
        "  await event.data.ref.parent.child('state').set({",
        "    initialAppsCount,",
        "    bucketOption: getApp().options.storageBucket || null,",
        "    bucketName: getStorage().bucket().name,",
        "  });",
        "});",
      ].join('\n'),
    );
    child = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry,
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
    });
    expect((await child.ready).triggerCount).toBe(1);
    await observer.rtdb.set('app-init/run1', 'go');
    const deadline = Date.now() + 5_000;
    while ((await observer.rtdb.get('app-init/state')) === null && Date.now() < deadline) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
    }
    expect(await observer.rtdb.get('app-init/state')).toEqual({
      initialAppsCount: 0,
      bucketOption: 'custom-child.appspot.com',
      bucketName: 'custom-child.appspot.com',
    });
    expect(await child.stop()).toBe(0);
  }, 15_000);

  test('reports a delivery-error instead of an uncaught exception when the peer disconnects during sandbox.clock and keeps serving after reconnect', async () => {
    const localProjectDir = join(fixtureDir, 'peer-drop-project');
    mkdirSync(join(localProjectDir, 'public'), { recursive: true });
    writeFileSync(join(localProjectDir, 'public/index.html'), '<!doctype html><body>peer-drop</body>');
    writeFileSync(
      join(localProjectDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );
    const localRuntime = await startServe({
      cwd: localProjectDir,
      port: 0,
      cacheRoot: join(localProjectDir, '.cache'),
      logger: silentServeLogger(),
      bridge: true,
      disableAuditLog: true,
    });
    const ctx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'functions-child-peer-drop',
      instanceId: 'functions-child-peer-drop-test',
    });
    let droppedOnce = false;
    let localPeer: { close(): Promise<void> } | undefined = await connectFunctionsWorkerPeer({
      url: `ws://127.0.0.1:${localRuntime.handle.port}/__pyric/sandbox`,
      ctx,
      sandboxId: 'functions-child-peer-drop-1',
      cwd: localProjectDir,
      sessionToken: localRuntime.sessionToken,
      onWorkerOp(op, controls) {
        if (op.method === 'sandbox.clock' && !droppedOnce) {
          droppedOnce = true;
          void controls.close();
          return 'drop';
        }
        return undefined;
      },
    });
    let localObserver: RemoteSandbox | undefined = await connectRemoteSandbox({
      url: localRuntime.handle.url,
      cwd: localProjectDir,
      sessionToken: localRuntime.sessionToken,
    });
    const events: FunctionsChildEvent[] = [];
    const localChild = spawnFunctionsChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: localRuntime.handle.url,
        registerUrl: registerModuleUrl(),
        instanceId: localRuntime.instanceId,
        sessionToken: localRuntime.sessionToken,
      }),
      instance: 'demo-project-default-rtdb',
      projectId: 'demo-project',
      location: 'us-central1',
      onEvent: (event) => events.push(event),
    });

    try {
      expect((await localChild.ready).triggerCount).toBe(2);

      // Write triggers makeUppercase -> child requests sandbox.clock -> peer closes mid-flight.
      await localObserver.rtdb.set('messages/dropped/original', 'before-close');
      const deliveryDeadline = Date.now() + 5_000;
      while (
        !events.some((event) => event.type === 'delivery-error' || event.type === 'uncaught-error') &&
        Date.now() < deliveryDeadline
      ) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
      }

      expect(events.filter((event) => event.type === 'uncaught-error')).toEqual([]);
      const deliveryErrors = events.filter((event) => event.type === 'delivery-error');
      expect(deliveryErrors.length).toBeGreaterThanOrEqual(1);
      expect(deliveryErrors[0]?.error.message).toContain('no browser tab is connected to the sandbox');

      // Reconnect a fresh peer on the same sandbox and confirm subsequent RTDB triggers still run.
      localObserver.close();
      localObserver = undefined;
      ctx.subs.clear();
      localPeer = await connectFunctionsWorkerPeer({
        url: `ws://127.0.0.1:${localRuntime.handle.port}/__pyric/sandbox`,
        ctx,
        sandboxId: 'functions-child-peer-drop-2',
        cwd: localProjectDir,
        sessionToken: localRuntime.sessionToken,
      });
      localObserver = await connectRemoteSandbox({
        url: localRuntime.handle.url,
        cwd: localProjectDir,
        sessionToken: localRuntime.sessionToken,
      });

      await localObserver.rtdb.set('messages/recovered/original', 'after-reconnect');
      const recoverDeadline = Date.now() + 5_000;
      while (
        (await localObserver.rtdb.get('messages/recovered/uppercase')) !== 'AFTER-RECONNECT' &&
        Date.now() < recoverDeadline
      ) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
      }
      expect(await localObserver.rtdb.get('messages/recovered/uppercase')).toBe('AFTER-RECONNECT');
      expect(events.filter((event) => event.type === 'uncaught-error')).toEqual([]);
      expect(await localChild.stop()).toBe(0);
    } finally {
      await localChild.stop().catch(() => undefined);
      localObserver?.close();
      await localPeer?.close().catch(() => undefined);
      await localRuntime.handle.stop();
    }
  }, 20_000);
});
