import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage, SnapMessage } from '../../../src/serve/worker/protocol.js';
import { createBridge } from '../../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../src/bridge/server/peer.js';

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({ backend: createMemoryBackend() });
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'host-test',
    subs: new Map(),
  };
}

function makePort(): { port: PortLike; messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return {
    port: { postMessage: (msg) => messages.push(msg) },
    messages,
  };
}

describe('worker host appConfig lock and pre-restart tab supersede', () => {
  it('names differing top-level keys when two fresh tabs send conflicting Firebase configs', async () => {
    const ctx = await makeCtx();
    const tabA = makePort();
    const tabB = makePort();

    await handleMessage(ctx, tabA.port, {
      t: 'appConfig',
      options: { apiKey: 'demo', projectId: 'spaces', recaptchaEnterpriseSiteKey: 'site-key-1' },
    });
    await handleMessage(ctx, tabB.port, {
      t: 'appConfig',
      options: { apiKey: 'demo', projectId: 'spaces' },
    });
    await handleMessage(ctx, tabB.port, {
      t: 'op',
      id: 'op-1',
      method: 'getDoc',
      path: 'spaces/one',
    });

    const reply = tabB.messages[0] as ResMessage;
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.code).toBe('app/multiple-configs-not-supported');
      expect(reply.error.message).toContain('differs on: recaptchaEnterpriseSiteKey');
    }
  });

  it('lets a fresh client supersede a stale tab that auto-reconnected from a prior host instance', async () => {
    const ctx = await makeCtx();
    const staleTab = makePort();
    const freshTab = makePort();
    const serviceWorker = makePort();

    const oct15Config = {
      apiKey: 'AIzaSyTest',
      authDomain: 'digchatapp.firebaseapp.com',
      databaseURL: 'https://digchatapp-default-rtdb.firebaseio.com',
      projectId: 'digchatapp',
      storageBucket: 'digchatapp.firebasestorage.app',
      messagingSenderId: '647740033774',
      appId: '1:647740033774:web:c5120f83178bc2644b41ff',
    };
    const currentConfig = {
      ...oct15Config,
      recaptchaEnterpriseSiteKey: '6Ld2QOItAAAAALupvnroD0n_rIqtE_LWxLVu9zUR',
    };

    // 1. Background Chrome tab from an earlier server session reconnects first.
    await handleMessage(ctx, staleTab.port, {
      t: 'appConfig',
      options: oct15Config,
      fromPriorHost: true,
    });
    await handleMessage(ctx, staleTab.port, {
      t: 'sub',
      subId: 'stale-sub',
      target: { __ref: 'doc', path: 'spaces/s1' },
    });
    staleTab.messages.length = 0;

    // 2. Fresh browser tab + Service Worker load current code with updated config.
    await handleMessage(ctx, freshTab.port, { t: 'appConfig', options: currentConfig });
    await handleMessage(ctx, serviceWorker.port, { t: 'appConfig', options: currentConfig });

    // Fresh tab and Service Worker succeed with zero errors.
    await handleMessage(ctx, freshTab.port, {
      t: 'op',
      id: 'fresh-set',
      method: 'setDoc',
      path: 'spaces/s1',
      data: { name: 'Launch Room' },
    });
    await handleMessage(ctx, serviceWorker.port, {
      t: 'op',
      id: 'sw-read',
      method: 'getDoc',
      path: 'spaces/s1',
    });

    expect((freshTab.messages[0] as ResMessage).ok).toBe(true);
    expect((serviceWorker.messages[0] as ResMessage).ok).toBe(true);

    // Stale pre-restart tab's open subscription and subsequent ops report the conflict cleanly,
    // while explicit disconnect still completes cleanly.
    const staleSnap = staleTab.messages[0] as SnapMessage;
    expect(staleSnap).toEqual({
      t: 'snap',
      subId: 'stale-sub',
      value: {
        __error: {
          code: 'app/multiple-configs-not-supported',
          message: 'Pyric currently supports one Firebase configuration per runtime (differs on: recaptchaEnterpriseSiteKey)',
        },
      },
    });

    staleTab.messages.length = 0;
    await handleMessage(ctx, staleTab.port, {
      t: 'op',
      id: 'stale-op',
      method: 'getDoc',
      path: 'spaces/s1',
    });
    expect(staleTab.messages[0]).toMatchObject({
      t: 'res',
      id: 'stale-op',
      ok: false,
      error: {
        code: 'app/multiple-configs-not-supported',
        message: 'Pyric currently supports one Firebase configuration per runtime (differs on: recaptchaEnterpriseSiteKey)',
      },
    });

    staleTab.messages.length = 0;
    await handleMessage(ctx, staleTab.port, { t: 'disconnect', id: 'bye' });
    expect(staleTab.messages[0]).toEqual({ t: 'res', id: 'bye', ok: true, value: undefined });
  });

  it('stamps fromPriorHost automatically on bridge peer attach when hostInstanceId comes from an older host', () => {
    const forwarded: Array<{ sessionId: string; message: InboundMessage }> = [];
    const bridge = createBridge({ projectKey: 'spaces-test' });
    bridge.registerSandboxPeer(
      (frame) => {
        if (frame.type === 'worker-message' && frame.clientSessionId) {
          forwarded.push({ sessionId: frame.clientSessionId, message: frame.message });
        }
      },
      [],
      'sandbox-2',
      ['worker-port'],
    );

    const stalePeer = createConsumerSession(bridge, () => {});
    stalePeer.handleMessage({
      type: 'attach',
      protocol: 1,
      transport: 'worker-port',
      hostInstanceId: 'old-oct-15-host-id',
      clientInfo: { platform: 'browser' },
    });
    // Even an older client bundle that omits `fromPriorHost` on `appConfig` gets marked by `peer.ts`.
    stalePeer.handleMessage({
      type: 'worker-message',
      message: { t: 'appConfig', options: { projectId: 'digchatapp' } },
    });

    const freshPeer = createConsumerSession(bridge, () => {});
    freshPeer.handleMessage({
      type: 'attach',
      protocol: 1,
      transport: 'worker-port',
      clientInfo: { platform: 'browser' },
    });
    freshPeer.handleMessage({
      type: 'worker-message',
      message: { t: 'appConfig', options: { projectId: 'digchatapp', recaptchaEnterpriseSiteKey: 'k' } },
    });

    expect(forwarded).toHaveLength(2);
    expect(forwarded[0]!.message).toEqual({
      t: 'appConfig',
      options: { projectId: 'digchatapp' },
      fromPriorHost: true,
    });
    expect(forwarded[1]!.message).toEqual({
      t: 'appConfig',
      options: { projectId: 'digchatapp', recaptchaEnterpriseSiteKey: 'k' },
    });
  });

  it('lets a host-verified page and updated SW supersede an unverified cached Service Worker that woke first', async () => {
    const ctx = await makeCtx();
    const ports = new Map<string, ReturnType<typeof makePort>>();
    const bridge = createBridge({ projectKey: 'spaces-live' });
    bridge.registerSandboxPeer(
      (frame) => {
        if (frame.type === 'worker-message' && frame.clientSessionId) {
          let entry = ports.get(frame.clientSessionId);
          if (!entry) {
            entry = makePort();
            ports.set(frame.clientSessionId, entry);
          }
          void handleMessage(ctx, entry.port, frame.message);
        }
      },
      [],
      'sandbox-live',
      ['worker-port'],
    );

    const oldConfigWithoutRecaptcha = {
      apiKey: 'AIzaSyDMNpNUevipcCuUurfcn8zLQuHA3Y04_nQ',
      authDomain: 'digchatapp.firebaseapp.com',
      databaseURL: 'https://digchatapp-default-rtdb.firebaseio.com',
      projectId: 'digchatapp',
      storageBucket: 'digchatapp.firebasestorage.app',
      messagingSenderId: '647740033774',
      appId: '1:647740033774:web:c5120f83178bc2644b41ff',
    };
    const currentConfig = {
      ...oldConfigWithoutRecaptcha,
      recaptchaEnterpriseSiteKey: '6Ld2QOItAAAAALupvnroD0n_rIqtE_LWxLVu9zUR',
    };

    // T+0ms: Cached pre-upgrade Service Worker wakes from Chrome SW cache in a fresh JS isolate (no hostInstanceId).
    const cachedOldSw = createConsumerSession(bridge, () => {});
    cachedOldSw.handleMessage({
      type: 'attach',
      protocol: 1,
      transport: 'worker-port',
      clientInfo: { platform: 'browser' },
    });
    cachedOldSw.handleMessage({
      type: 'worker-message',
      message: { t: 'appConfig', options: oldConfigWithoutRecaptcha },
    });

    // T+1ms: Fresh HTML page stamped by THIS running server attaches with bridge.instanceId.
    const freshPage = createConsumerSession(bridge, () => {});
    freshPage.handleMessage({
      type: 'attach',
      protocol: 1,
      transport: 'worker-port',
      hostInstanceId: bridge.instanceId,
      clientInfo: { platform: 'browser' },
    });
    freshPage.handleMessage({
      type: 'worker-message',
      message: { t: 'appConfig', options: currentConfig },
    });

    // T+817ms: Freshly recompiled Service Worker activates via skipWaiting() and attaches with bridge.instanceId.
    const freshSw = createConsumerSession(bridge, () => {});
    freshSw.handleMessage({
      type: 'attach',
      protocol: 1,
      transport: 'worker-port',
      hostInstanceId: bridge.instanceId,
      clientInfo: { platform: 'browser' },
    });
    freshSw.handleMessage({
      type: 'worker-message',
      message: { t: 'appConfig', options: currentConfig },
    });

    const [, pagePort, swPort] = [...ports.values()];
    await handleMessage(ctx, pagePort!.port, {
      t: 'op',
      id: 'page-write',
      method: 'setDoc',
      path: 'spaces/s1',
      data: { ok: true },
    });
    await handleMessage(ctx, swPort!.port, {
      t: 'op',
      id: 'sw-read',
      method: 'getDoc',
      path: 'spaces/s1',
    });

    expect((pagePort!.messages[0] as ResMessage).ok).toBe(true);
    expect((swPort!.messages[0] as ResMessage).ok).toBe(true);

    // Once locked by a host-verified client, a second host-verified client with a different config is rejected.
    const conflictingVerifiedPage = makePort();
    await handleMessage(ctx, conflictingVerifiedPage.port, {
      t: 'appConfig',
      options: { ...currentConfig, projectId: 'other-project' },
      hostVerified: true,
    });
    await handleMessage(ctx, conflictingVerifiedPage.port, {
      t: 'op',
      id: 'conflict-read',
      method: 'getDoc',
      path: 'spaces/s1',
    });
    const conflictReply = conflictingVerifiedPage.messages[0] as ResMessage;
    expect(conflictReply.ok).toBe(false);
    if (!conflictReply.ok) {
      expect(conflictReply.error.code).toBe('app/multiple-configs-not-supported');
    }
  });
});
