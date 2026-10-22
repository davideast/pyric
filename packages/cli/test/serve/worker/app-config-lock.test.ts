import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
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
      options: { apiKey: 'demo', projectId: 'spaces', storageBucket: 'spaces-next.appspot.com' },
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
      expect(reply.error.message).toContain('differs on: storageBucket');
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
      storageBucket: 'digchatapp-next.firebasestorage.app',
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
          message: 'Pyric currently supports one Firebase configuration per runtime (differs on: storageBucket)',
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
        message: 'Pyric currently supports one Firebase configuration per runtime (differs on: storageBucket)',
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
      storageBucket: 'digchatapp-next.firebasestorage.app',
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

describe('worker host appConfig lock between verified pages and Node processes', () => {
  const ssrConfig = {
    apiKey: 'demo-key',
    appId: '1:1:web:1',
    authDomain: 'demo-app.firebaseapp.com',
    projectId: 'demo-app',
    databaseURL: 'https://demo-app-default-rtdb.firebaseio.com',
    storageBucket: 'demo-app.appspot.com',
  };
  const pageConfig = { ...ssrConfig, storageBucket: 'other-bucket.appspot.com' };
  const analyticsConfig = { ...ssrConfig, measurementId: 'G-TEST123', recaptchaEnterpriseSiteKey: 'site-key', apiKey: 'other-key', appId: '1:1:web:2', authDomain: 'other.example.com', messagingSenderId: '42' };
  const warnings: string[] = [];
  let warn: ReturnType<typeof spyOn> | undefined;
  beforeEach(() => {
    warnings.length = 0;
    warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  });
  afterEach(() => { warn?.mockRestore(); });

  async function op(ctx: HostCtx, port: ReturnType<typeof makePort>, id: string): Promise<ResMessage> {
    port.messages.length = 0;
    await handleMessage(ctx, port.port, { t: 'op', id, method: 'getDoc', path: 'spaces/s1' });
    return port.messages.find((message): message is ResMessage => message.t === 'res' && message.id === id)!;
  }

  it('refuses a verified page whose config names another storage bucket while a verified Node process holds the config', async () => {
    const ctx = await makeCtx();
    const ports = new Map<string, ReturnType<typeof makePort>>();
    const bridge = createBridge({ projectKey: 'ssr-and-page' });
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
      'sandbox-ssr',
      ['worker-port'],
    );
    // A Node process attaches with the instance id from this host's init.json.
    const nodeProcess = createConsumerSession(bridge, () => {});
    nodeProcess.handleMessage({
      type: 'attach', protocol: 1, transport: 'worker-port', hostInstanceId: bridge.instanceId, clientInfo: { platform: 'node' },
    });
    nodeProcess.handleMessage({ type: 'worker-message', message: { t: 'appConfig', options: ssrConfig } });
    // The page the host served attaches with the same boot, and a config that names another bucket.
    const page = createConsumerSession(bridge, () => {});
    page.handleMessage({
      type: 'attach', protocol: 1, transport: 'worker-port', hostInstanceId: bridge.instanceId, clientInfo: { platform: 'browser' },
    });
    page.handleMessage({ type: 'worker-message', message: { t: 'appConfig', options: pageConfig } });

    const [nodePort, pagePort] = [...ports.values()];
    expect((await op(ctx, nodePort!, 'node-read')).ok).toBe(true);
    const refused = await op(ctx, pagePort!, 'page-read');
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('app/multiple-configs-not-supported');
      expect(refused.error.message).toContain('differs on: storageBucket');
    }
    expect((await op(ctx, nodePort!, 'node-read-after')).ok).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[pyric] Refused a client's Firebase config (differs on: storageBucket).");
    expect(warnings[0]).toContain('that client keeps working');
  });

  it('logs the eviction when a verified client replaces a provisional config', async () => {
    const ctx = await makeCtx();
    const cachedServiceWorker = makePort();
    const page = makePort();
    await handleMessage(ctx, cachedServiceWorker.port, { t: 'appConfig', options: ssrConfig });
    await handleMessage(ctx, page.port, { t: 'appConfig', options: pageConfig, hostVerified: true });

    expect((await op(ctx, page, 'page-read')).ok).toBe(true);
    expect((await op(ctx, cachedServiceWorker, 'sw-read')).ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      '[pyric] Replaced the provisional Firebase config with the one a client verified against this host sent (differs on: storageBucket).',
    );
    expect(warnings[0]).toContain('1 client on the earlier config');
  });

  it('accepts a client a provisional lock refused once a verified client with its config takes over', async () => {
    const ctx = await makeCtx();
    const cachedServiceWorker = makePort();
    const nodeFromPriorHost = makePort();
    const page = makePort();
    await handleMessage(ctx, cachedServiceWorker.port, { t: 'appConfig', options: pageConfig });
    // Neither is verified, so the Node process, which came second, is refused.
    await handleMessage(ctx, nodeFromPriorHost.port, { t: 'appConfig', options: ssrConfig, fromPriorHost: true });
    expect((await op(ctx, nodeFromPriorHost, 'node-refused')).ok).toBe(false);

    await handleMessage(ctx, page.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });

    expect((await op(ctx, page, 'page-read')).ok).toBe(true);
    expect((await op(ctx, nodeFromPriorHost, 'node-read')).ok).toBe(true);
    expect((await op(ctx, cachedServiceWorker, 'sw-read')).ok).toBe(false);
  });

  it('forgets a refused client that disconnects, so a later lock does not accept it', async () => {
    const ctx = await makeCtx();
    const cachedServiceWorker = makePort();
    const refusedTab = makePort();
    const page = makePort();
    await handleMessage(ctx, cachedServiceWorker.port, { t: 'appConfig', options: pageConfig });
    await handleMessage(ctx, refusedTab.port, { t: 'appConfig', options: ssrConfig });
    await handleMessage(ctx, refusedTab.port, { t: 'disconnect', id: 'bye' });
    await handleMessage(ctx, page.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });
    const read = await op(ctx, refusedTab, 'gone-read');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).not.toBe('app/multiple-configs-not-supported');
  });

  it('accepts a verified page whose config differs only on keys that pick no backend data', async () => {
    const ctx = await makeCtx();
    const nodeProcess = makePort();
    const page = makePort();
    await handleMessage(ctx, nodeProcess.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });
    // measurementId, the App Check site key, apiKey, appId, authDomain and messagingSenderId.
    await handleMessage(ctx, page.port, { t: 'appConfig', options: analyticsConfig, hostVerified: true });

    expect((await op(ctx, page, 'page-read')).ok).toBe(true);
    expect((await op(ctx, nodeProcess, 'node-read')).ok).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('refuses a config that differs on projectId, databaseURL or storageBucket, naming only those keys', async () => {
    for (const [key, value] of [
      ['projectId', 'other-project'],
      ['databaseURL', 'https://other-rtdb.firebaseio.com'],
      ['storageBucket', 'other-bucket.appspot.com'],
    ] as const) {
      const ctx = await makeCtx();
      const holder = makePort();
      const other = makePort();
      await handleMessage(ctx, holder.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });
      await handleMessage(ctx, other.port, { t: 'appConfig', options: { ...analyticsConfig, [key]: value }, hostVerified: true });
      const refused = await op(ctx, other, `${key}-read`);
      expect(refused.ok, key).toBe(false);
      if (!refused.ok) expect(refused.error.message, key).toContain(`(differs on: ${key})`);
    }
  });

  /** A host whose config release waits `graceMs` after the last client goes. */
  async function makeReleasingCtx(graceMs = 20): Promise<HostCtx> {
    const ctx = await makeCtx();
    ctx.configReleaseGraceMs = graceMs;
    return ctx;
  }
  const pastGrace = () => new Promise(resolve => setTimeout(resolve, 60));

  it('releases the config a short while after its last client disconnects, so a later client may send another', async () => {
    const ctx = await makeReleasingCtx();
    const script = makePort();
    const page = makePort();
    await handleMessage(ctx, script.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });
    await handleMessage(ctx, script.port, { t: 'disconnect', id: 'script-bye' });
    await pastGrace();
    await handleMessage(ctx, page.port, { t: 'appConfig', options: pageConfig, hostVerified: true });

    expect((await op(ctx, page, 'page-read')).ok).toBe(true);
    expect(ctx.appOptions).toEqual(pageConfig);
  });

  it('keeps the config while another client that shares it is connected', async () => {
    const ctx = await makeReleasingCtx();
    const script = makePort();
    const sharedPage = makePort();
    const otherPage = makePort();
    await handleMessage(ctx, script.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });
    await handleMessage(ctx, sharedPage.port, { t: 'appConfig', options: analyticsConfig, hostVerified: true });
    await handleMessage(ctx, script.port, { t: 'disconnect', id: 'script-bye' });
    await pastGrace();
    await handleMessage(ctx, otherPage.port, { t: 'appConfig', options: pageConfig, hostVerified: true });

    expect((await op(ctx, sharedPage, 'shared-read')).ok).toBe(true);
    expect((await op(ctx, otherPage, 'other-read')).ok).toBe(false);
  });

  it('accepts a client refused while the config was held once the grace after its last holder ends', async () => {
    const ctx = await makeReleasingCtx();
    const script = makePort();
    const page = makePort();
    await handleMessage(ctx, script.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });
    await handleMessage(ctx, page.port, { t: 'appConfig', options: pageConfig, hostVerified: true });
    expect((await op(ctx, page, 'page-refused')).ok).toBe(false);

    await handleMessage(ctx, script.port, { t: 'disconnect', id: 'script-bye' });
    expect((await op(ctx, page, 'page-still-refused')).ok).toBe(false);
    await pastGrace();

    expect((await op(ctx, page, 'page-read')).ok).toBe(true);
    expect(ctx.appOptions).toEqual(pageConfig);
  });

  it('keeps the config for a reloaded tab that reattaches within the grace, and the refused client stays refused', async () => {
    const ctx = await makeReleasingCtx(40);
    const tab = makePort();
    const refusedTab = makePort();
    const reloadedTab = makePort();
    await handleMessage(ctx, tab.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });
    await handleMessage(ctx, refusedTab.port, { t: 'appConfig', options: pageConfig, hostVerified: true });
    await handleMessage(ctx, tab.port, { t: 'disconnect', id: 'reload' });
    await handleMessage(ctx, reloadedTab.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });
    await new Promise(resolve => setTimeout(resolve, 100));

    expect((await op(ctx, reloadedTab, 'reloaded-read')).ok).toBe(true);
    expect((await op(ctx, refusedTab, 'refused-read')).ok).toBe(false);
    expect(ctx.appOptions).toEqual(ssrConfig);
  });

  it('never releases to another projectId: that client is refused, naming projectId and a host restart', async () => {
    const ctx = await makeReleasingCtx();
    const projectA = makePort();
    const projectB = makePort();
    const otherProject = { ...ssrConfig, projectId: 'other-project' };
    await handleMessage(ctx, projectA.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });
    await handleMessage(ctx, projectA.port, {
      t: 'op', id: 'a-write', method: 'setDoc', path: 'notes/x', data: { from: 'a' },
    } as never);
    await handleMessage(ctx, projectA.port, { t: 'disconnect', id: 'a-bye' });
    await pastGrace();
    await handleMessage(ctx, projectB.port, { t: 'appConfig', options: otherProject, hostVerified: true });

    const refused = await op(ctx, projectB, 'b-read');
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('app/multiple-configs-not-supported');
      expect(refused.error.message).toContain('differs on: projectId');
    }
    expect(warnings.some(warning => warning.includes('(differs on: projectId)') && warning.includes('Restart the host'))).toBe(true);
  });

  it('compares databaseURL by instance and storageBucket without gs://', async () => {
    const equivalent = [
      { databaseURL: 'https://demo-app-default-rtdb.firebaseio.com/' },
      { databaseURL: 'https://DEMO-APP-DEFAULT-RTDB.firebaseio.com' },
      { databaseURL: 'http://127.0.0.1:9000/?ns=demo-app-default-rtdb' },
      { databaseURL: undefined },
      { storageBucket: 'gs://demo-app.appspot.com' },
    ];
    for (const change of equivalent) {
      const ctx = await makeCtx();
      const holder = makePort();
      const other = makePort();
      await handleMessage(ctx, holder.port, { t: 'appConfig', options: ssrConfig, hostVerified: true });
      await handleMessage(ctx, other.port, { t: 'appConfig', options: { ...ssrConfig, ...change }, hostVerified: true });
      expect((await op(ctx, other, 'other-read')).ok, JSON.stringify(change)).toBe(true);
    }
  });
});
