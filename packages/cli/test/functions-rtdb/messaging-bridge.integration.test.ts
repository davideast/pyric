/**
 * End-to-end integration test verifying Issue #403 resolution:
 * A token minted by the browser worker can receive an Admin Messaging send
 * initiated in a spawned Functions child process across the real bridge.
 */

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
} from '../../src/cli/dev-runner.js';
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

let fixtureDir: string;
let runtime: ServeRuntime;
let peer: { close(): Promise<void> };
let observer: RemoteSandbox;
let child: FunctionsRtdbChildHandle | undefined;

let childStderr = '';

async function waitForValue(path: string, predicate: (val: unknown) => boolean, events: unknown[]): Promise<unknown> {
  const deadline = Date.now() + 8_000;
  let lastVal: unknown;
  while (Date.now() < deadline) {
    lastVal = await observer.rtdb.get(path);
    if (predicate(lastVal)) return lastVal;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error(`timed out waiting for predicate on ${path}. Last val: ${JSON.stringify(lastVal)}. Stderr: ${childStderr}. Events: ${JSON.stringify(events)}`);
}

beforeAll(async () => {
  if (!existsSync(childModule)) {
    throw new Error(`Functions child is not built — run bun run --cwd packages/cli build (${childModule})`);
  }
  fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-functions-msg-bridge-'));
  mkdirSync(join(fixtureDir, 'public'));
  mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
  writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(
    join(fixtureDir, 'firebase.json'),
    JSON.stringify({ hosting: { public: 'public' } }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/package.json'),
    JSON.stringify({ name: 'messaging-bridge-functions', private: true, type: 'module' }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/index.js'),
    `import { onValueCreated } from 'firebase-functions/v2/database';
import { initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
initializeApp();

export const notifyOnReply = onValueCreated(
  '/replies/{id}',
  async (event) => {
    const val = event.data.val();
    if (!val || !val.token) return;
    try {
      const messageId = await getMessaging().send({
        token: val.token,
        notification: { title: val.text || 'Reply' },
      });
      await event.data.ref.parent.child(event.params.id + '_result').set('success:' + messageId);
    } catch (err) {
      await event.data.ref.parent.child(event.params.id + '_result').set('error:' + err.code);
    }
  },
);
`,
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(fixtureDir, 'functions/node_modules/firebase-functions'),
  );
  symlinkSync(
    join(repoRoot, 'packages/pyric-admin'),
    join(fixtureDir, 'functions/node_modules/pyric-admin'),
  );
  symlinkSync(
    join(repoRoot, 'packages/pyric'),
    join(fixtureDir, 'functions/node_modules/pyric'),
  );
  symlinkSync(
    join(repoRoot, 'packages/pyric-admin'),
    join(fixtureDir, 'functions/node_modules/firebase-admin'),
  );

  runtime = await startServe({
    cwd: fixtureDir,
    port: 0,
    cacheRoot: join(fixtureDir, '.cache'),
    bridge: true,
    disableAuditLog: true,
    logger: silentServeLogger(),
  });
  const wsUrl = `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`;
  const ctx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'test-msg-bridge',
    instanceId: 'demo-project-default-rtdb',
  });
  peer = await connectFunctionsWorkerPeer({
    url: wsUrl,
    ctx,
    sandboxId: 'test-msg-peer',
  });
  observer = await connectRemoteSandbox({
    url: runtime.handle.url,
    mode: 'admin',
    version: 'test-msg-client',
  });
}, 30_000);

afterAll(async () => {
  if (child) await child.stop();
  observer?.dispose();
  if (peer) await peer.close();
  await runtime?.handle.stop();
});

describe('Functions RTDB messaging bridge integration (#403)', () => {
  test('delivers Admin Messaging send from child to a worker-minted token across the bridge', async () => {
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
    childStderr = '';
    child.child.stderr?.setEncoding('utf8');
    child.child.stderr?.on('data', (c) => { childStderr += c; });

    const ready = await child.ready;
    expect(ready.triggerCount).toBe(1);

    // 1. Mint a token in the worker via remote channel
    const { token } = (await observer.channel.op({
      method: 'messaging.getToken',
      registrationId: 'browser-tab-sw',
    })) as { token: string };
    expect(token).toBeTruthy();

    // 2. Trigger RTDB function that calls admin.messaging().send({ token })
    await observer.rtdb.set('replies/msg1', { token, text: 'Hello across bridge' });

    // 3. Await successful delivery result written by the Functions child
    const res = (await waitForValue(
      'replies/msg1_result',
      (val) => typeof val === 'string' && val.startsWith('success:'),
      events,
    )) as string;
    expect(res).toMatch(/^success:projects\/.*\/messages\/.*/);

    // 4. Test error envelope preservation across bridge for unregistered token
    await observer.rtdb.set('replies/msg2', {
      token: 'aaaa:APA91bNEVERMINTED',
      text: 'Should fail',
    });
    const errRes = (await waitForValue(
      'replies/msg2_result',
      (val) => typeof val === 'string' && val.startsWith('error:'),
      events,
    )) as string;
    expect(errRes).toBe('error:messaging/registration-token-not-registered');

    expect(await child.stop()).toBe(0);
  }, 20_000);
});
