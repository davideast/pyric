import { describe, expect, it } from 'bun:test';
import { getFirestore, doc, setDoc, getDoc } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authOps } from 'pyric/auth';
import type { HostCtx } from '../../../src/serve/worker/host.js';
import {
  setupFallbackWorkerSync,
  FIRESTORE_TAB_SYNC_CHANNEL,
  AUTH_TAB_SYNC_CHANNEL,
} from '../../../src/serve/worker/fallback-worker-sync.js';

describe('fallback-worker-sync', () => {
  it('defines the expected channel constants', () => {
    expect(FIRESTORE_TAB_SYNC_CHANNEL).toBe('pyric:serve:tabsync');
    expect(AUTH_TAB_SYNC_CHANNEL).toBe('pyric:serve:auth-sync');
  });

  it('wires Firestore and Auth tab sync on the worker host', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    const ctx: HostCtx = {
      db,
      sandbox,
      instanceId: 'test-worker-instance',
      subs: new Map(),
    };

    const teardown = setupFallbackWorkerSync(ctx);
    expect(teardown).toBeDefined();
    expect(typeof teardown).toBe('function');
    expect(ctx.fallbackWorkerSyncTeardown).toBe(teardown);

    // Teardown cleans up
    teardown?.();
  });

  it('syncs Firestore documents bidirectionally over pyric:serve:tabsync', async () => {
    const workerSandbox = initializeSandbox();
    const workerDb = getFirestore(workerSandbox);
    const workerCtx: HostCtx = {
      db: workerDb,
      sandbox: workerSandbox,
      instanceId: 'worker-instance-1',
      subs: new Map(),
    };

    const teardownWorker = setupFallbackWorkerSync(workerCtx);

    // Create a fallback tab sandbox that syncs over the same channel
    const fallbackSandbox = initializeSandbox();
    const fallbackDb = getFirestore(fallbackSandbox);
    const teardownFallback = fallbackSandbox.enableTabSync({
      channel: new BroadcastChannel(FIRESTORE_TAB_SYNC_CHANNEL),
    });

    // Write on worker host -> observable on fallback tab
    await setDoc(doc(workerDb, 'users/alice'), { name: 'Alice', role: 'admin' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const fallbackDoc = await getDoc(doc(fallbackDb, 'users/alice'));
    expect(fallbackDoc.exists()).toBe(true);
    expect(fallbackDoc.data()).toEqual({ name: 'Alice', role: 'admin' });

    // Write on fallback tab -> observable on worker host
    await setDoc(doc(fallbackDb, 'users/bob'), { name: 'Bob', role: 'member' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const workerDoc = await getDoc(doc(workerDb, 'users/bob'));
    expect(workerDoc.exists()).toBe(true);
    expect(workerDoc.data()).toEqual({ name: 'Bob', role: 'member' });

    teardownFallback();
    teardownWorker?.();
  });

  it('syncs auth user state over pyric:serve:auth-sync', async () => {
    const workerSandbox = initializeSandbox();
    const workerCtx: HostCtx = {
      db: getFirestore(workerSandbox),
      sandbox: workerSandbox,
      instanceId: 'worker-instance-2',
      subs: new Map(),
    };

    const teardownWorker = setupFallbackWorkerSync(workerCtx);
    const authChannel = new BroadcastChannel(AUTH_TAB_SYNC_CHANNEL);

    // When fallback tab sends a state message, worker imports users
    authChannel.postMessage({
      kind: 'state',
      origin: 'tab-123',
      users: [
        { uid: 'u1', email: 'u1@example.com' },
      ],
      currentUid: 'u1',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const auth = getAuth(workerSandbox);
    const users = authOps.exportUsers(auth);
    expect(users.some((u) => u.uid === 'u1')).toBe(true);

    authChannel.close();
    teardownWorker?.();
  });
});
