import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApp, initializeApp, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as inPageMessaging from 'pyric/messaging';
import { handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
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

let activeHostCtx: HostCtx | null = null;
let appSeq = 0;

interface ActiveCleanup {
  close(): Promise<void>;
}

const cleanups: ActiveCleanup[] = [];

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
  activeHostCtx = ctx;

  const globalObj = globalThis as Record<string, unknown>;
  const hadFetch = Object.prototype.hasOwnProperty.call(globalObj, 'fetch');
  const prevFetch = globalObj.fetch;
  const hadLocation = Object.prototype.hasOwnProperty.call(globalObj, 'location');
  const prevLocation = globalObj.location;
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(globalObj, 'localStorage');
  const prevLocalStorage = globalObj.localStorage;

  const storageMap = new Map<string, string>();
  globalObj.fetch = async () => Response.json({ hosted: false });
  globalObj.location = new URL('https://app.example/');
  globalObj.localStorage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageMap.set(key, String(value));
    },
    removeItem: (key: string) => {
      storageMap.delete(key);
    },
  };

  globalObj.SharedWorker = class {
    port: FakePort;
    addEventListener(): void {}
    constructor() {
      const targetCtx = activeHostCtx ?? ctx;
      const { a: clientPort, b: hostPort } = portPair();
      const hostPortLike: PortLike = {
        postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
      };
      hostPort.onmessage = (event) => {
        void handleMessage(targetCtx, hostPortLike, event.data as InboundMessage);
      };
      this.port = clientPort;
    }
  };

  const servedClient = await import('../../../../src/serve/entries/messaging.js');
  const servedSw = await import('../../../../src/serve/entries/messaging-sw.js');
  const createdApps: FirebaseApp[] = [];

  cleanups.push({
    async close(): Promise<void> {
      for (const app of createdApps) {
        await deleteApp(app).catch(() => undefined);
      }
      if (hadFetch) {
        globalObj.fetch = prevFetch;
      } else {
        delete globalObj.fetch;
      }
      if (hadLocation) {
        globalObj.location = prevLocation;
      } else {
        delete globalObj.location;
      }
      if (hadLocalStorage) {
        globalObj.localStorage = prevLocalStorage;
      } else {
        delete globalObj.localStorage;
      }
      ctx.sandbox.dispose();
    },
  });

  return {
    clientMod: servedClient as unknown as MessagingClientSwReplayTarget['clientMod'],
    swMod: servedSw as unknown as MessagingClientSwReplayTarget['swMod'],
    async withNoDefaultApp(run) {
      try {
        const existingDefault = getApp();
        await deleteApp(existingDefault);
      } catch {
        // No default app present.
      }
      return await run();
    },
    async withDefaultApp(run) {
      const fullDefault = initializeApp({
        projectId: 'test',
        databaseURL: 'https://test-default-rtdb.firebaseio.com',
      });
      try {
        return await run(fullDefault);
      } finally {
        await deleteApp(fullDefault).catch(() => undefined);
      }
    },
    createNamedApp(label) {
      appSeq += 1;
      const app = createAppForSandbox(
        ctx.sandbox,
        { projectId: 'test', databaseURL: 'https://test-default-rtdb.firebaseio.com' },
        `served-msg-${label}-${appSeq}`,
      );
      createdApps.push(app);
      return app;
    },
    async deleteApp(app) {
      await deleteApp(app as FirebaseApp);
    },
    async deliver(messaging, spec) {
      await inPageMessaging.sandbox.deliver(messaging as inPageMessaging.Messaging, spec);
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
