import 'fake-indexeddb/auto';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';
import type { FirebaseApp } from 'pyric/app';
import type * as inPageMessagingTypes from 'pyric/messaging';
import type { Sandbox } from 'pyric/sandbox';
import { handleMessage, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair, sleep } from '../integration-support.js';
import {
  replayMessagingClientErrorCodes,
  replayMessagingModuleBoundaryAndAccessors,
  replayMessagingObserverAndUnsubscribe,
  replayMessagingSwDeliveryMetricsToggle,
  type MessagingClientSwReplayTarget,
} from '../../../../../conformance/src/messaging-client-sw-replay.ts';
import { load, restoreSharedWorker } from './support.ts';

restoreSharedWorker();

interface BundledServedRealm {
  initializeSandbox(): Sandbox;
  initializeApp(options: Record<string, unknown>, name?: string): FirebaseApp;
  getApp(name?: string): FirebaseApp;
  deleteApp(app: FirebaseApp): Promise<void>;
  createAppForSandbox(
    sandbox: Sandbox,
    options: Record<string, unknown>,
    name: string,
  ): FirebaseApp;
  inPageMessaging: typeof inPageMessagingTypes;
  servedClient: MessagingClientSwReplayTarget['clientMod'];
  servedSw: MessagingClientSwReplayTarget['swMod'];
}

let bundledSource = '';
let appSeq = 0;

interface ActiveCleanup {
  close(): Promise<void>;
}

const cleanups: ActiveCleanup[] = [];

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: [
        "export { initializeSandbox } from 'pyric/sandbox';",
        "export { initializeApp, getApp, deleteApp } from 'pyric/app';",
        "export { createAppForSandbox } from 'pyric/app/internal';",
        "export * as inPageMessaging from 'pyric/messaging';",
        "export * as servedClient from './messaging.js';",
        "export * as servedSw from './messaging-sw.js';",
      ].join('\n'),
      resolveDir: new URL('../../../../src/serve/entries/', import.meta.url).pathname,
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'servedSdk',
    write: false,
  });
  const firstFile = result.outputFiles[0];
  if (firstFile === undefined) {
    throw new Error('Failed to bundle served messaging entries for worker replay.');
  }
  bundledSource = `${firstFile.text}\nservedSdk`;
});

afterEach(async () => {
  while (cleanups.length > 0) {
    const item = cleanups.pop();
    if (item !== undefined) {
      await item.close();
    }
  }
});

async function createServedMessagingTarget(): Promise<MessagingClientSwReplayTarget> {
  const ctx = await makeHostCtx();
  ctx.messagingEnabled = true;

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const storageMap = new Map<string, string>();

  class RealmSharedWorker {
    port: FakePort;
    addEventListener(): void {}
    constructor() {
      const { a: clientPort, b: hostPort } = portPair();
      const hostPortLike: PortLike = {
        postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
      };
      hostPort.onmessage = (event) => {
        void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
      };
      this.port = clientPort;
    }
  }

  const realmGlobals = {
    console,
    TextEncoder,
    TextDecoder,
    URL,
    AbortController,
    MessageEvent,
    Response,
    crypto,
    performance,
    queueMicrotask,
    structuredClone,
    indexedDB: new IDBFactory(),
    location: new URL('https://app.example/'),
    localStorage: {
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageMap.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageMap.delete(key);
      },
    },
    SharedWorker: RealmSharedWorker,
    fetch: async () => Response.json({ hosted: false }),
    setTimeout: (fn: () => void, ms?: number) => {
      const handle = setTimeout(fn, ms);
      timers.add(handle);
      return handle;
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle);
      clearTimeout(handle);
    },
    get Notification() {
      return (globalThis as { Notification?: unknown }).Notification;
    },
    get ServiceWorkerRegistration() {
      return (globalThis as { ServiceWorkerRegistration?: unknown }).ServiceWorkerRegistration;
    },
    get navigator() {
      return (globalThis as { navigator?: unknown }).navigator;
    },
  };

  const sdk = runInNewContext(bundledSource, realmGlobals) as BundledServedRealm;
  const realmSandbox = sdk.initializeSandbox();
  const createdApps: FirebaseApp[] = [];

  cleanups.push({
    async close(): Promise<void> {
      for (const app of createdApps) {
        await sdk.deleteApp(app).catch(() => undefined);
      }
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      realmSandbox.dispose();
      ctx.sandbox.dispose();
    },
  });

  return {
    clientMod: sdk.servedClient,
    swMod: sdk.servedSw,
    async withNoDefaultApp(run) {
      try {
        const existingDefault = sdk.getApp();
        await sdk.deleteApp(existingDefault);
      } catch {
        // No default app present.
      }
      return await run();
    },
    async withDefaultApp(run) {
      const fullDefault = sdk.initializeApp({
        projectId: 'test',
        databaseURL: 'https://test-default-rtdb.firebaseio.com',
      });
      try {
        return await run(fullDefault);
      } finally {
        await sdk.deleteApp(fullDefault).catch(() => undefined);
      }
    },
    createNamedApp(label) {
      appSeq += 1;
      const app = sdk.createAppForSandbox(
        realmSandbox,
        { projectId: 'test', databaseURL: 'https://test-default-rtdb.firebaseio.com' },
        `served-msg-${label}-${appSeq}`,
      );
      createdApps.push(app);
      return app;
    },
    async deleteApp(app) {
      await sdk.deleteApp(app as FirebaseApp);
    },
    async deliver(messaging, spec) {
      await sdk.inPageMessaging.sandbox.deliver(
        messaging as inPageMessagingTypes.Messaging,
        spec,
      );
      await sleep(25);
    },
    async settleSubscription() {
      await sleep(30);
    },
  };
}

describe('served SharedWorker messaging client + sw oracle captures', () => {
  it('replays messaging-web-module-boundary-and-accessors verbatim over SharedWorker', async () => {
    const target = await createServedMessagingTarget();
    const expected = load('messaging-web-module-boundary-and-accessors');
    const actual = await replayMessagingModuleBoundaryAndAccessors(target);
    expect(actual as unknown).toEqual(expected);
  });

  it('replays messaging-web-observer-and-unsubscribe verbatim over SharedWorker', async () => {
    const target = await createServedMessagingTarget();
    const expected = load('messaging-web-observer-and-unsubscribe');
    const actual = await replayMessagingObserverAndUnsubscribe(target);
    expect(actual as unknown).toEqual(expected);
  });

  it('replays messaging-web-sw-delivery-metrics-toggle verbatim over SharedWorker', async () => {
    const target = await createServedMessagingTarget();
    const expected = load('messaging-web-sw-delivery-metrics-toggle');
    const actual = await replayMessagingSwDeliveryMetricsToggle(target);
    expect(actual as unknown).toEqual(expected);
  });

  it('replays messaging-web-client-error-codes verbatim over SharedWorker', async () => {
    const target = await createServedMessagingTarget();
    const expected = load('messaging-web-client-error-codes');
    const actual = await replayMessagingClientErrorCodes(target);
    expect(actual as unknown).toEqual(expected);
  });
});
