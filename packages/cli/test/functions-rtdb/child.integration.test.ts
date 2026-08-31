import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  spawnFunctionsRtdbChild,
  type FunctionsRtdbChildEvent,
  type FunctionsRtdbChildHandle,
} from '../../src/functions-rtdb/child.js';
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
const childModule = join(cliRoot, 'dist/functions-rtdb/child.js');
const firebaseFunctionsPkg = existsSync(join(repoRoot, 'packages/conformance/node_modules/firebase-functions'))
  ? join(repoRoot, 'packages/conformance/node_modules/firebase-functions')
  : join(repoRoot, 'node_modules/firebase-functions');

let fixtureDir: string;
let runtime: ServeRuntime;
let peer: { close(): Promise<void> };
let observer: RemoteSandbox;
let child: FunctionsRtdbChildHandle | undefined;

async function waitForValue(path: string, expected: unknown): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await observer.rtdb.get(path)) === expected) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error(`timed out waiting for ${path}=${JSON.stringify(expected)}`);
}

beforeAll(async () => {
  if (!existsSync(childModule)) {
    throw new Error(`Functions child is not built — run bun run --cwd packages/cli build (${childModule})`);
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
    `const { onValueCreated, onValueUpdated } = require('firebase-functions/v2/database');
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
exports.unsupportedUpdate = onValueUpdated(
  '/messages/{pushId}/original',
  () => undefined,
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
    firebaseFunctionsPkg,
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
    firebaseFunctionsPkg,
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
    const events: FunctionsRtdbChildEvent[] = [];
    child = spawnFunctionsRtdbChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
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
        exportName: 'unsupportedUpdate',
        eventType: 'google.firebase.database.ref.v1.updated',
      }],
    });
    await observer.rtdb.set('messages/id/original', 'hello');
    await waitForValue('messages/id/uppercase', 'HELLO');
    await waitForValue('messages/id/processed', 'id:HELLO');

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
    const events: FunctionsRtdbChildEvent[] = [];
    child = spawnFunctionsRtdbChild({
      cwd: join(fixtureDir, 'functions-esm'),
      entry: join(fixtureDir, 'functions-esm/index.js'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
      onEvent: (event) => events.push(event),
    });

    expect(await child.ready).toEqual({
      triggerCount: 1,
      unsupportedTriggers: [],
    });
    await observer.rtdb.set('esm-messages/id/original', 'hello');
    const eventDeadline = Date.now() + 5_000;
    while (events.length === 0 && Date.now() < eventDeadline) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
    }
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
    child = spawnFunctionsRtdbChild({
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

  test('rejects exports spanning more than one effective database instance', async () => {
    const entry = join(fixtureDir, 'functions/multi-instance.cjs');
    writeFileSync(entry, `const { onValueCreated } = require('firebase-functions/v2/database');
exports.first = onValueCreated({ ref: '/first/{id}', instance: 'first-rtdb' }, () => undefined);
exports.second = onValueCreated({ ref: '/second/{id}', instance: 'second-rtdb' }, () => undefined);
`);
    child = spawnFunctionsRtdbChild({
      cwd: join(fixtureDir, 'functions'),
      entry,
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
    });

    await expect(child.ready).rejects.toThrow(
      'Functions RTDB first slice supports one database instance; found first-rtdb, second-rtdb',
    );
    expect(await child.exited).toBe(1);
  });
});
