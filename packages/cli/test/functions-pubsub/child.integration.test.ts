import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { type FunctionsChildEvent } from '../../src/functions/child-protocol.js';
import {
  createFunctionsDevelopmentRuntime,
  createHttpFunctionsPeerReadiness,
  createInProcessFunctionsPeerReadiness,
  type FunctionsDevelopmentEvent,
} from '../../src/functions/development-runtime.js';
import { listExecutions } from '../../src/functions/execution-log.js';
import { MESSAGE_PUBLISHED_EVENT_TYPE } from '../../src/functions/pubsub/discovery.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';
import {
  startNodeHostedRuntime,
  type HostedNodeServer,
} from '../functions-storage/hosted-harness.js';
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

describe('isolated Functions Pub/Sub child E2E via FunctionsDevelopmentRuntime', () => {
  const tempDirs = trackTempDirs('pyric-fn-pubsub-e2e-');
  let fixtureDir = '';
  let serveRuntime: ServeRuntime | undefined;
  let peer: { close(): Promise<void> } | undefined;
  let observer: RemoteSandbox | undefined;
  let logSandbox: LocalSandbox | undefined;

  beforeAll(async () => {
    if (!existsSync(childModule)) {
      throw new Error(`Functions child is not built: ${childModule}`);
    }
    fixtureDir = tempDirs.makeTempDir();
    mkdirSync(join(fixtureDir, 'public'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
    mkdirSync(join(fixtureDir, 'functions-esm/node_modules'), { recursive: true });
    writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>pubsub</body>');
    writeFileSync(
      join(fixtureDir, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' } }),
    );

    writeFileSync(
      join(fixtureDir, 'functions/package.json'),
      JSON.stringify({ name: 'pubsub-fn-cjs', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(fixtureDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onInit } = require('firebase-functions/v2/core');",
        "const { Message, onMessagePublished } = require('firebase-functions/v2/pubsub');",
        '',
        'let initializedViaHook = false;',
        'onInit(() => {',
        '  initializedViaHook = true;',
        '});',
        '',
        'function ensureAdmin() {',
        '  if (getApps().length === 0) initializeApp();',
        '}',
        '',
        'exports.onOrderPrimary = onMessagePublished("orders", async (event) => {',
        '  ensureAdmin();',
        '  const parsed = event.data.message.json;',
        '  if (parsed.delayMs) {',
        '    await new Promise((r) => setTimeout(r, parsed.delayMs));',
        '  }',
        '  await getDatabase().ref("pubsubReceipts/primary/" + parsed.id).set({',
        '    id: event.id,',
        '    source: event.source,',
        '    specversion: event.specversion,',
        '    type: event.type,',
        '    subscription: event.data.subscription,',
        '    isMessageClass: event.data.message instanceof Message,',
        '    initializedViaHook,',
        '    messageId: event.data.message.messageId,',
        '    publishTime: event.data.message.publishTime,',
        '    orderingKey: event.data.message.orderingKey,',
        '    attributes: event.data.message.attributes,',
        '    compatResourceName: event.context ? event.context.resource.name : null,',
        '    parsed,',
        '  });',
        '  return { handledBy: "primary", orderId: parsed.id };',
        '});',
        '',
        'exports.onOrderQualifiedFanOut = onMessagePublished(',
        '  { topic: "projects/demo-project/topics/orders", region: "europe-west1", retry: true },',
        '  async (event) => {',
        '    ensureAdmin();',
        '    const parsed = event.data.message.json;',
        '    await getDatabase().ref("pubsubReceipts/fanout/" + parsed.id).set({',
        '      subscription: event.data.subscription,',
        '      orderId: parsed.id,',
        '      attributes: event.data.message.attributes,',
        '    });',
        '    return { handledBy: "fanout" };',
        '  },',
        ');',
        '',
        'exports.onBinaryPayload = onMessagePublished("binary-topic", async (event) => {',
        '  ensureAdmin();',
        '  const bytes = Array.from(Buffer.from(event.data.message.data, "base64"));',
        '  const key = event.data.message.attributes.packetId || "default";',
        '  await getDatabase().ref("pubsubReceipts/binary/" + key).set({',
        '    bytes,',
        '    attributes: event.data.message.attributes,',
        '  });',
        '});',
        '',
        'exports.onEmptyPayload = onMessagePublished("empty-topic", async (event) => {',
        '  ensureAdmin();',
        '  await getDatabase().ref("pubsubReceipts/empty/latest").set({',
        '    rawData: event.data.message.data,',
        '    byteLength: Buffer.from(event.data.message.data, "base64").byteLength,',
        '    attributes: event.data.message.attributes,',
        '  });',
        '});',
        '',
        'exports.onStrictJson = onMessagePublished("strict-json", (event) => {',
        '  return event.data.message.json;',
        '});',
        '',
        'exports.onUnrelatedTopic = onMessagePublished("other-topic", async () => {',
        '  ensureAdmin();',
        '  await getDatabase().ref("pubsubReceipts/unrelated/called").set(true);',
        '});',
        '',
        'exports.omittedSubscriber = onMessagePublished(',
        '  { topic: "orders", omit: true },',
        '  () => undefined,',
        ');',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(fixtureDir, 'functions/node_modules/firebase-functions'),
    );

    writeFileSync(
      join(fixtureDir, 'functions-esm/package.json'),
      JSON.stringify({
        name: 'pubsub-fn-esm',
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
        "import { onMessagePublished } from 'firebase-functions/v2/pubsub';",
        'await Promise.resolve();',
        'if (getApps().length === 0) initializeApp();',
        'export const onEsmTopic = onMessagePublished("esm-events", async (event) => {',
        '  const body = event.data.message.json;',
        '  await getDatabase().ref("pubsubReceipts/esm/latest").set({',
        '    greeting: body.greeting,',
        '    source: event.source,',
        '    tag: event.data.message.attributes.tag || null,',
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
    const ctx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'functions-pubsub-e2e',
      instanceId: 'functions-pubsub-e2e-instance',
    });
    peer = await connectFunctionsWorkerPeer({
      url: `ws://127.0.0.1:${serveRuntime.handle.port}/__pyric/sandbox`,
      ctx,
      sandboxId: 'functions-pubsub-e2e-sb',
    });
    observer = await connectRemoteSandbox({ url: serveRuntime.handle.url });
    logSandbox = initializeSandbox();
  }, 30_000);

  afterAll(async () => {
    observer?.close();
    if (peer) await peer.close();
    if (serveRuntime) await serveRuntime.handle.stop();
    tempDirs.cleanupTempDirs();
  });

  test('delivers JSON, Buffer, Uint8Array, empty payloads, fan-out, invalid JSON rejection, and concurrent publishes in isolated CJS child', async () => {
    if (!serveRuntime || !observer || !logSandbox) {
      throw new Error('pubsub E2E harness not initialized');
    }
    const devEvents: FunctionsDevelopmentEvent[] = [];
    const runtime = createFunctionsDevelopmentRuntime({
      sourceDir: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.js'),
      baseEnv: process.env,
      serveUrl: serveRuntime.handle.url,
      registerUrl: registerModuleUrl(),
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-project',
      childModuleUrl: pathToFileURL(childModule),
      readiness: createInProcessFunctionsPeerReadiness(() => true),
      sandbox: logSandbox,
      onEvent: (event) => devEvents.push(event),
    });

    try {
      await expect(runtime.publishPubSub('orders', { beforeStart: true })).rejects.toThrow(
        /no active child process/,
      );

      const startResult = await runtime.start();
      expect(startResult).toEqual({
        kind: 'ready',
        ready: {
          triggerCount: 6,
          unsupportedTriggers: [
            {
              exportName: 'omittedSubscriber',
              eventType: `${MESSAGE_PUBLISHED_EVENT_TYPE} (omitted from emulation)`,
            },
          ],
        },
      });

      await expect(runtime.publishPubSub('invalid/topic', { ok: false })).rejects.toThrow(
        /Invalid Pub\/Sub topic/,
      );

      // 1. Concurrent non-blocking publish + multi-subscriber fan-out + attributes + orderingKey.
      const slowPublish = runtime.publishPubSub(
        'orders',
        { id: 'ord-slow', total: 120, delayMs: 80 },
        {
          attributes: { env: 'e2e', source: 'cart' },
          orderingKey: 'cust-9',
          publishTime: '2026-11-21T19:00:00.000Z',
        },
      );
      const fastPublish = runtime.publishPubSub(
        'projects/demo-project/topics/orders',
        { id: 'ord-fast', total: 45 },
        { env: 'e2e', source: 'instant' },
      );

      const fastResult = await fastPublish;
      expect(fastResult.matchedCount).toBe(2);
      const slowResult = await slowPublish;
      expect(slowResult.matchedCount).toBe(2);

      const primarySlow = await waitForRtdbValue<Record<string, unknown>>(
        observer,
        'pubsubReceipts/primary/ord-slow',
      );
      expect(primarySlow).toMatchObject({
        source: '//pubsub.googleapis.com/projects/demo-project/topics/orders',
        specversion: '1.0',
        type: MESSAGE_PUBLISHED_EVENT_TYPE,
        subscription:
          'projects/demo-project/subscriptions/eventarc-us-central1-onOrderPrimary-orders',
        isMessageClass: true,
        initializedViaHook: true,
        messageId: slowResult.messageId,
        publishTime: '2026-11-21T19:00:00.000Z',
        orderingKey: 'cust-9',
        attributes: { env: 'e2e', source: 'cart' },
        compatResourceName: 'projects/demo-project/topics/orders',
        parsed: { id: 'ord-slow', total: 120, delayMs: 80 },
      });

      const fanoutFast = await waitForRtdbValue<Record<string, unknown>>(
        observer,
        'pubsubReceipts/fanout/ord-fast',
      );
      expect(fanoutFast).toEqual({
        subscription:
          'projects/demo-project/subscriptions/eventarc-europe-west1-onOrderQualifiedFanOut-orders',
        orderId: 'ord-fast',
        attributes: { env: 'e2e', source: 'instant' },
      });

      // 2. Binary Buffer and Uint8Array payloads across child IPC.
      await runtime.publishPubSub(
        'binary-topic',
        Buffer.from([0x00, 0xff, 0x7f, 0x80]),
        { packetId: 'buf1' },
      );
      await runtime.publishPubSub(
        'binary-topic',
        new Uint8Array([10, 20, 30, 40]),
        { packetId: 'u8' },
      );
      expect(
        await waitForRtdbValue(observer, 'pubsubReceipts/binary/buf1'),
      ).toEqual({
        bytes: [0, 255, 127, 128],
        attributes: { packetId: 'buf1' },
      });
      expect(
        await waitForRtdbValue(observer, 'pubsubReceipts/binary/u8'),
      ).toEqual({
        bytes: [10, 20, 30, 40],
        attributes: { packetId: 'u8' },
      });

      // 3. Empty payload + attributes.
      await runtime.publishPubSub('empty-topic', undefined, { ping: '1' });
      expect(
        await waitForRtdbValue(observer, 'pubsubReceipts/empty/latest'),
      ).toEqual({
        rawData: '',
        byteLength: 0,
        attributes: { ping: '1' },
      });

      // 4. Invalid JSON .json getter error parity without crashing child process.
      const invalidJsonRes = await runtime.publishPubSub(
        'strict-json',
        Buffer.from('{broken-json', 'utf8'),
      );
      expect(invalidJsonRes.matchedCount).toBe(1);
      expect(invalidJsonRes.deliveries[0]?.status).toBe('rejected');
      expect(invalidJsonRes.deliveries[0]?.error?.message).toContain(
        'Unable to parse Pub/Sub message data as JSON:',
      );

      // Verify child survives rejected handler and non-matching topic never ran.
      const postErrorRes = await runtime.publishPubSub(
        'orders',
        { id: 'ord-after-error', total: 99 },
        { env: 'recovery' },
      );
      expect(postErrorRes.deliveries.every((d) => d.status === 'fulfilled')).toBe(
        true,
      );
      expect(await observer.rtdb.get('pubsubReceipts/unrelated/called')).toBeNull();

      // Verify execution-log records both fulfilled and rejected runs + retry metadata.
      const executions = listExecutions(logSandbox);
      expect(
        executions.some(
          (rec) =>
            rec.trigger === 'onOrderPrimary' &&
            rec.status === 'fulfilled' &&
            rec.cause.params.topic === 'orders',
        ),
      ).toBe(true);
      expect(
        executions.some(
          (rec) =>
            rec.trigger === 'onOrderQualifiedFanOut' &&
            rec.retryConfig?.retry === 1,
        ),
      ).toBe(true);
      expect(
        executions.some(
          (rec) =>
            rec.trigger === 'onStrictJson' &&
            rec.status === 'rejected' &&
            Boolean(rec.error?.includes('Unable to parse Pub/Sub message data as JSON:')),
        ),
      ).toBe(true);

      const childExecEvents = devEvents
        .filter(
          (ev): ev is { type: 'child-event'; event: FunctionsChildEvent } =>
            ev.type === 'child-event',
        )
        .map((ev) => ev.event);
      expect(
        childExecEvents.some(
          (ev) =>
            ev.type === 'execution' &&
            ev.exportName === 'onStrictJson' &&
            ev.status === 'rejected',
        ),
      ).toBe(true);
    } finally {
      const closeStarted = Date.now();
      await runtime.close();
      expect(Date.now() - closeStarted).toBeLessThan(1_800);
    }

    await expect(runtime.publishPubSub('orders', { afterClose: true })).rejects.toThrow(
      /closed/,
    );
  }, 30_000);

  test('delivers Pub/Sub messages to ESM firebase-functions/v2/pubsub module and reloads cleanly', async () => {
    if (!serveRuntime || !observer) {
      throw new Error('pubsub E2E harness not initialized');
    }
    const runtime = createFunctionsDevelopmentRuntime({
      sourceDir: join(fixtureDir, 'functions-esm'),
      entry: join(fixtureDir, 'functions-esm/index.js'),
      baseEnv: process.env,
      serveUrl: serveRuntime.handle.url,
      registerUrl: registerModuleUrl(),
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-project',
      childModuleUrl: pathToFileURL(childModule),
      readiness: createInProcessFunctionsPeerReadiness(() => true),
    });

    try {
      const startResult = await runtime.start();
      expect(startResult).toEqual({
        kind: 'ready',
        ready: {
          triggerCount: 1,
          unsupportedTriggers: [],
        },
      });

      const pubRes = await runtime.publishPubSub(
        'esm-events',
        { greeting: 'hello from esm pubsub' },
        { tag: 'esm-v2' },
      );
      expect(pubRes.matchedCount).toBe(1);

      const receipt = await waitForRtdbValue<{
        greeting: string;
        source: string;
        tag: string | null;
      }>(observer, 'pubsubReceipts/esm/latest');
      expect(receipt).toEqual({
        greeting: 'hello from esm pubsub',
        source: '//pubsub.googleapis.com/projects/demo-project/topics/esm-events',
        tag: 'esm-v2',
      });

      // Hot-reload ESM module with a second subscriber and publish to it.
      writeFileSync(
        join(fixtureDir, 'functions-esm/index.js'),
        [
          "import { initializeApp, getApps } from 'firebase-admin/app';",
          "import { getDatabase } from 'firebase-admin/database';",
          "import { onMessagePublished } from 'firebase-functions/v2/pubsub';",
          'await Promise.resolve();',
          'if (getApps().length === 0) initializeApp();',
          'export const onEsmTopic = onMessagePublished("esm-events", () => undefined);',
          'export const onReloadedTopic = onMessagePublished("reloaded-topic", async (event) => {',
          '  await getDatabase().ref("pubsubReceipts/esm/reloaded").set(event.data.message.json);',
          '});',
        ].join('\n'),
      );

      const reloadResult = await runtime.reload();
      expect(reloadResult).toEqual({
        kind: 'ready',
        ready: {
          triggerCount: 2,
          unsupportedTriggers: [],
        },
      });

      await runtime.publishPubSub('reloaded-topic', { reloaded: true, version: 2 });
      expect(await waitForRtdbValue(observer, 'pubsubReceipts/esm/reloaded')).toEqual({
        reloaded: true,
        version: 2,
      });
    } finally {
      await runtime.close();
    }
  }, 25_000);

  test('executes onMessagePublished against live HostedRuntime Node process', async () => {
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
      JSON.stringify({ name: 'pubsub-hosted', private: true, type: 'commonjs' }),
    );
    writeFileSync(
      join(hostedDir, 'functions/index.js'),
      [
        "const { initializeApp, getApps } = require('firebase-admin/app');",
        "const { getDatabase } = require('firebase-admin/database');",
        "const { onMessagePublished } = require('firebase-functions/v2/pubsub');",
        'if (getApps().length === 0) initializeApp();',
        'exports.onHostedEvent = onMessagePublished("hosted-topic", async (event) => {',
        '  await getDatabase().ref("hostedPubSub/latest").set({',
        '    payload: event.data.message.json,',
        '    attrs: event.data.message.attributes,',
        '  });',
        '});',
      ].join('\n'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(hostedDir, 'functions/node_modules/firebase-functions'),
    );

    let hosted: HostedNodeServer | undefined;
    let hostedObserver: RemoteSandbox | undefined;
    try {
      hosted = await startNodeHostedRuntime(hostedDir, 'demo-project');
      hostedObserver = await connectRemoteSandbox({
        cwd: hostedDir,
        url: hosted.url,
        sessionToken: hosted.sessionToken,
      });

      const runtime = createFunctionsDevelopmentRuntime({
        sourceDir: join(hostedDir, 'functions'),
        entry: join(hostedDir, 'functions/index.js'),
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
      });

      try {
        expect((await runtime.start()).kind).toBe('ready');
        await runtime.publishPubSub(
          'hosted-topic',
          { mode: 'hosted-node', ok: true },
          { transport: 'ipc' },
        );
        expect(await waitForRtdbValue(hostedObserver, 'hostedPubSub/latest')).toEqual({
          payload: { mode: 'hosted-node', ok: true },
          attrs: { transport: 'ipc' },
        });
      } finally {
        await runtime.close();
      }
    } finally {
      hostedObserver?.close();
      if (hosted) await hosted.stop();
    }
  }, 30_000);
});
