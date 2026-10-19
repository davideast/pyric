import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { applyServeInit, setupWorkerHotReload, type EventSourceLike } from '../../../src/serve/worker/serve-init.js';
import { exportStateBundle } from '../../../src/serve/worker/host/state-transfer.js';
import { requiresHealthyPersistence } from '../../../src/serve/hosted/persistence-admission.js';
import type { OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';

function createPort() {
  const messages: OutboundMessage[] = [];
  const port: PortLike & { messages: OutboundMessage[]; lastRes(): ResMessage } = {
    messages,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
    },
    lastRes(): ResMessage {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.t === 'res') return m;
      }
      throw new Error('Expected at least one res message');
    },
  };
  return port;
}

describe('serve worker host dispatch & session coherence regression suite (#1124)', () => {
  it('SW-DIS-1: rejects non-cloud.firestore service blocks (including 2+modules) and preserves active Firestore rules', async () => {
    const sandbox = initializeSandbox();
    sandbox.admin.setDocument('public/doc1', { title: 'hello' });
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'test-sw-dis-1',
      subs: new Map(),
      flushPersistence: async () => {},
    };
    const port = createPort();

    const validRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /public/{docId} {
      allow read: if true;
    }
  }
}`;
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'init-rules',
      method: 'setFirestoreRules',
      source: validRules,
    });
    expect((port.lastRes() as ResMessage & { ok: true }).value).toMatchObject({ ok: true });

    const storageRules = `rules_version = '2+modules';
import { nonExistentHelper } from './missing-local-module.rules';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'bad-storage-rules',
      method: 'setFirestoreRules',
      source: storageRules,
    });
    const badRes = (port.lastRes() as ResMessage & { ok: true }).value as {
      ok: boolean;
      messages: Array<{ severity: string; text: string }>;
    };
    expect(badRes.ok).toBe(false);
    expect(badRes.messages).toEqual([
      expect.objectContaining({
        severity: 'error',
        text: "Expected 'service cloud.firestore', got 'service firebase.storage'.",
      }),
    ]);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'get-active-rules',
      method: 'getActiveRules',
    });
    const activeRules = (port.lastRes() as ResMessage & { ok: true }).value as {
      firestore?: { status: string; lastKnownGood?: string; source?: string };
    };
    expect(activeRules.firestore?.status).toBe('error');
    expect(activeRules.firestore?.lastKnownGood).toBe(validRules);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'read-public',
      method: 'getDoc',
      path: 'public/doc1',
    });
    expect(port.lastRes().ok).toBe(true);
    sandbox.dispose();
  });

  it('SW-DIS-2a/b/c & SW-HST-7a: keeps Firestore rules metadata and non-default RTDB instance rules coherent across restore and importState', async () => {
    const openFsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;
    const lockedFsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'test-sw-dis-2',
      subs: new Map(),
      sessionMode: 'LOCAL',
      sessionBackend: createMemoryBackend(),
      flushPersistence: async () => {},
    };
    const port = createPort();

    applyServeInit(ctx, {
      rules: openFsRules,
      rulesHash: 'h1',
      seed: null,
      storageRules: null,
      permissive: true,
      databaseInstances: {
        defaultInstance: 'default',
        rules: {
          default: { rules: { '.read': true, '.write': true } },
          analytics: { rules: { '.read': false, '.write': false } },
          'secondary-db': { rules: { '.read': 'auth != null', '.write': 'auth != null' } },
        },
      },
    });

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'lock-fs',
      method: 'setFirestoreRules',
      source: lockedFsRules,
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'save-cp',
      method: 'checkpoint',
      name: 'locked-checkpoint',
    });
    const fullBundle = await exportStateBundle(sandbox);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'reopen-fs',
      method: 'setFirestoreRules',
      source: openFsRules,
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'restore-cp',
      method: 'restore',
      name: 'locked-checkpoint',
    });

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'get-active-after-restore',
      method: 'getActiveRules',
    });
    expect(
      ((port.lastRes() as ResMessage & { ok: true }).value as { firestore: { source: string } }).firestore.source,
    ).toBe(lockedFsRules);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'read-analytics-after-restore',
      method: 'rtdb.get',
      instance: 'analytics',
      path: '/metrics',
    });
    expect(port.lastRes().ok).toBe(false);

    // Authenticated write on secondary-db must still succeed when rules are preserved (SW-HST-7a)
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'write-secondary-after-restore',
      method: 'rtdb.set',
      instance: 'secondary-db',
      path: '/ranked/item1',
      value: 'beta',
      actAs: { mode: 'as', uid: 'alice' },
    });
    expect(port.lastRes().ok).toBe(true);

    // Full-state importState also syncs active rules and preserves non-default RTDB rules
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'reopen-before-full-import',
      method: 'setFirestoreRules',
      source: openFsRules,
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'full-import',
      method: 'importState',
      bundle: fullBundle,
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'get-active-after-full-import',
      method: 'getActiveRules',
    });
    expect(
      ((port.lastRes() as ResMessage & { ok: true }).value as { firestore: { source: string } }).firestore.source,
    ).toBe(lockedFsRules);

    // Legacy pyric-v3-records importState preserves active Firestore and RTDB rules instead of failing open
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'legacy-import',
      method: 'importState',
      bundle: JSON.stringify({
        format: 'pyric-v3-records',
        records: {
          meta: { version: 3, savedAt: 1, services: {} },
          '00': { docs: { 'secrets/item': { classified: 1 } } },
        },
      }),
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'read-after-legacy-import',
      method: 'getDoc',
      path: 'secrets/item',
    });
    expect(port.lastRes().ok).toBe(false);
    sandbox.dispose();
  });

  it('SW-DIS-3a/b: reconciles per-port sessions across checkpoint restore and clears sessions on resetAll', async () => {
    const authFsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /private/{docId} {
      allow read, write: if request.auth != null;
    }
    match /adminOnly/{docId} {
      allow read, write: if request.auth != null && request.auth.token.role == 'admin';
    }
  }
}`;
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'test-sw-dis-3',
      subs: new Map(),
      sessionMode: 'LOCAL',
      sessionBackend: createMemoryBackend(),
      flushPersistence: async () => {},
    };
    applyServeInit(ctx, {
      rules: authFsRules,
      rulesHash: 'h1',
      seed: null,
      storageRules: null,
      databaseRules: {
        rules: { private: { '.read': 'auth != null', '.write': 'auth != null' } },
      },
    });
    const port = createPort();

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'create-user',
      method: 'auth.adminCreateUser',
      request: {
        uid: 'alice',
        email: 'alice@example.com',
        password: 'password123',
        customClaims: { role: 'viewer' },
      },
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'signin-alice',
      method: 'auth.signInEmail',
      email: 'alice@example.com',
      password: 'password123',
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'save-cp',
      method: 'checkpoint',
      name: 'before-admin',
    });

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'promote-alice',
      method: 'auth.adminUpdateUser',
      uid: 'alice',
      request: { customClaims: { role: 'admin' } },
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'refresh-token',
      method: 'auth.getIdToken',
      forceRefresh: true,
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'write-admin-before-restore',
      method: 'setDoc',
      path: 'adminOnly/doc0',
      data: { ok: true },
    });
    expect(port.lastRes().ok).toBe(true);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'restore-cp',
      method: 'restore',
      name: 'before-admin',
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'write-admin-after-restore',
      method: 'setDoc',
      path: 'adminOnly/doc1',
      data: { elevatedAfterRestore: true },
    });
    expect(port.lastRes().ok).toBe(false);

    // Alice still has her viewer session until resetAll wipes users
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'write-private-while-signed-in',
      method: 'setDoc',
      path: 'private/still-alice',
      data: { ok: true },
    });
    expect(port.lastRes().ok).toBe(true);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'reset-all',
      method: 'resetAll',
    });
    expect(port.lastRes().ok).toBe(true);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'get-current-user',
      method: 'auth.getCurrentUser',
    });
    expect((port.lastRes() as ResMessage & { ok: true }).value).toBeNull();

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'write-private-fs',
      method: 'setDoc',
      path: 'private/secret',
      data: { leaked: true },
    });
    expect(port.lastRes().ok).toBe(false);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'write-private-rtdb',
      method: 'rtdb.set',
      path: '/private/item',
      value: 'leaked',
    });
    expect(port.lastRes().ok).toBe(false);
    sandbox.dispose();
  });

  it('SW-DIS-4a/b/c: preserves boot lint messages and updates activeRules.firestore on hot-reload across resetAll', async () => {
    const openWithWarningRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{docId} {
      allow read, write: if true;
    }
  }
}`;
    const lockedRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{docId} {
      allow read, write: if false;
    }
  }
}`;
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'test-sw-dis-4',
      subs: new Map(),
      flushPersistence: async () => {},
    };
    applyServeInit(ctx, {
      rules: openWithWarningRules,
      rulesHash: 'boot-hash',
      seed: null,
      storageRules: null,
    });
    const port = createPort();

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'boot-active-rules',
      method: 'getActiveRules',
    });
    const bootRules = (port.lastRes() as ResMessage & { ok: true }).value as {
      firestore: { messages: unknown[] };
    };
    expect(bootRules.firestore.messages.length).toBeGreaterThan(0);

    let sseListener: ((ev: { data: string }) => void) | null = null;
    const fakeEs: EventSourceLike = {
      addEventListener(event, cb) {
        if (event === 'rules-changed') sseListener = cb;
      },
      close() {},
    };
    setupWorkerHotReload(ctx, () => fakeEs);
    expect(sseListener).not.toBeNull();
    sseListener!({
      data: JSON.stringify({ rules: lockedRules, rulesHash: 'hot-reload-hash' }),
    });

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'after-hot-reload',
      method: 'getActiveRules',
    });
    expect(
      ((port.lastRes() as ResMessage & { ok: true }).value as { firestore: { source: string } }).firestore.source,
    ).toBe(lockedRules);

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'reset-all',
      method: 'resetAll',
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'write-after-reset',
      method: 'setDoc',
      path: 'items/doc1',
      data: { shouldBeDenied: true },
    });
    expect(port.lastRes().ok).toBe(false);
    sandbox.dispose();
  });

  it('SW-DIS-5: clears sticky port tenant when signing in explicitly with tenantId: null', async () => {
    const tenantRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tenants/{tenantId}/docs/{docId} {
      allow read, write: if request.auth != null && request.auth.token.firebase.tenant == tenantId;
    }
  }
}`;
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'test-sw-dis-5',
      subs: new Map(),
      flushPersistence: async () => {},
    };
    applyServeInit(ctx, {
      rules: tenantRules,
      seed: null,
    });
    const port = createPort();

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'set-tenant',
      method: 'auth.setTenantId',
      tenantId: 'acme-corp',
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'signin-tenant',
      method: 'auth.signInAnonymously',
      tenantId: 'acme-corp',
    });
    expect(
      ((port.lastRes() as ResMessage & { ok: true }).value as { user: { tenantId: string | null } }).user.tenantId,
    ).toBe('acme-corp');

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'signout',
      method: 'auth.signOut',
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'signin-untenanted',
      method: 'auth.signInAnonymously',
      tenantId: null,
    });
    const untenantedUser = (
      (port.lastRes() as ResMessage & { ok: true }).value as { user: { tenantId: string | null } }
    ).user;
    expect(untenantedUser.tenantId).toBeNull();

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'write-tenant-doc',
      method: 'setDoc',
      path: 'tenants/acme-corp/docs/secret',
      data: { leakedCrossTenant: true },
    });
    expect(port.lastRes().ok).toBe(false);
    sandbox.dispose();
  });

  it('SW-DIS-6a/b: preserves authorized RTDB onValue listeners on checkpoint restore and never leaks restricted data before applying rules', async () => {
    // 6a: default deny policy, public path
    const sandboxA = initializeSandbox();
    const ctxA: HostCtx = {
      sandbox: sandboxA,
      db: getFirestore(sandboxA),
      instanceId: 'test-sw-dis-6a',
      subs: new Map(),
      sessionMode: 'LOCAL',
      sessionBackend: createMemoryBackend(),
      flushPersistence: async () => {},
    };
    applyServeInit(ctxA, {
      rules: null,
      rulesHash: null,
      seed: null,
      storageRules: null,
      databaseRules: { rules: { public: { '.read': true, '.write': true } } },
    });
    const portA = createPort();
    await handleMessage(ctxA, portA, { t: 'op', id: '1', method: 'rtdb.set', path: '/public', value: 'v1-checkpoint' });
    await handleMessage(ctxA, portA, { t: 'op', id: '2', method: 'checkpoint', name: 'cp-public' });
    await handleMessage(ctxA, portA, { t: 'op', id: '3', method: 'rtdb.set', path: '/public', value: 'v2-live' });

    const snapsA: Array<Record<string, unknown>> = [];
    const subPortA: PortLike = {
      postMessage(msg) {
        if (msg.t === 'snap' && msg.subId === 'rtdb-sub-public') {
          snapsA.push(msg.value as Record<string, unknown>);
        }
      },
    };
    await handleMessage(ctxA, subPortA, {
      t: 'sub',
      subId: 'rtdb-sub-public',
      target: { service: 'rtdb', path: '/public' },
    });
    expect(snapsA.map((s) => s.value)).toEqual(['v2-live']);
    snapsA.length = 0;

    await handleMessage(ctxA, portA, { t: 'op', id: '4', method: 'restore', name: 'cp-public' });
    expect(snapsA.filter((s) => '__error' in s)).toEqual([]);
    expect(snapsA.map((s) => s.value)).toEqual(['v1-checkpoint']);
    sandboxA.dispose();

    // 6b: permissive policy, restricted path in checkpoint
    const sandboxB = initializeSandbox();
    const ctxB: HostCtx = {
      sandbox: sandboxB,
      db: getFirestore(sandboxB),
      instanceId: 'test-sw-dis-6b',
      subs: new Map(),
      sessionMode: 'LOCAL',
      sessionBackend: createMemoryBackend(),
      flushPersistence: async () => {},
    };
    applyServeInit(ctxB, {
      rules: null,
      rulesHash: null,
      seed: null,
      storageRules: null,
      permissive: true,
      databaseRules: { rules: { secret: { '.read': false, '.write': false } } },
    });
    const portB = createPort();
    await handleMessage(ctxB, portB, {
      t: 'op',
      id: '1',
      method: 'rtdb.set',
      path: '/secret',
      value: 'CLASSIFIED_PAYLOAD_DO_NOT_LEAK',
      actAs: { mode: 'admin' },
    });
    await handleMessage(ctxB, portB, { t: 'op', id: '2', method: 'checkpoint', name: 'cp-secret' });
    await handleMessage(ctxB, portB, {
      t: 'op',
      id: '3',
      method: 'setDatabaseRules',
      source: JSON.stringify({ rules: { secret: { '.read': true, '.write': true } } }),
    });
    await handleMessage(ctxB, portB, { t: 'op', id: '4', method: 'rtdb.set', path: '/secret', value: 'public-benign' });

    const snapsB: Array<Record<string, unknown>> = [];
    const subPortB: PortLike = {
      postMessage(msg) {
        if (msg.t === 'snap' && msg.subId === 'rtdb-sub-secret') {
          snapsB.push(msg.value as Record<string, unknown>);
        }
      },
    };
    await handleMessage(ctxB, subPortB, {
      t: 'sub',
      subId: 'rtdb-sub-secret',
      target: { service: 'rtdb', path: '/secret' },
    });
    expect(snapsB.map((s) => s.value)).toEqual(['public-benign']);
    snapsB.length = 0;

    await handleMessage(ctxB, portB, { t: 'op', id: '5', method: 'restore', name: 'cp-secret' });
    expect(snapsB.filter((s) => !('__error' in s))).toEqual([]);
    expect(snapsB.filter((s) => '__error' in s)).toHaveLength(1);
    sandboxB.dispose();
  });

  it('SW-DIS-7a/b: gates and flushes auth.signInEmail and setDatabaseRules, and keeps lastLoginAt unchanged on non-authenticating uid restores', async () => {
    const sandbox = initializeSandbox();
    let flushCalls = 0;
    const ctx: HostCtx = {
      sandbox,
      db: getFirestore(sandbox),
      instanceId: 'test-sw-dis-7',
      subs: new Map(),
      flushPersistence: async () => {
        flushCalls += 1;
      },
    };
    const port = createPort();

    await handleMessage(ctx, port, {
      t: 'op',
      id: 'create',
      method: 'auth.adminCreateUser',
      request: { uid: 'u1', email: 'u1@example.com', password: 'password123' },
    });

    sandbox.clock.advance(5_000);
    const signInEmailOp = {
      t: 'op' as const,
      id: 'signin-email',
      method: 'auth.signInEmail' as const,
      email: 'u1@example.com',
      password: 'password123',
    };
    expect(requiresHealthyPersistence(signInEmailOp)).toBe(true);
    flushCalls = 0;
    await handleMessage(ctx, port, signInEmailOp);
    expect(flushCalls).toBe(1);

    await handleMessage(ctx, port, { t: 'op', id: 'list-after-signin', method: 'auth.listUsers' });
    const loginAtAfterSignIn = (
      (port.lastRes() as ResMessage & { ok: true }).value as Array<{ lastLoginAt: string | null }>
    )[0]?.lastLoginAt;
    expect(typeof loginAtAfterSignIn).toBe('string');

    // Non-authenticating session restores (reload / restorePortSession / updateCurrentUser) must not mutate lastLoginAt
    sandbox.clock.advance(10_000);
    await handleMessage(ctx, port, { t: 'op', id: 'reload-user', method: 'auth.reload' });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'restore-port',
      method: 'auth.restorePortSession',
      uid: 'u1',
      tenantId: null,
    });
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'update-current',
      method: 'auth.updateCurrentUser',
      uid: 'u1',
      tenantId: null,
    });
    await handleMessage(ctx, port, { t: 'op', id: 'list-after-reload', method: 'auth.listUsers' });
    const loginAtAfterReload = (
      (port.lastRes() as ResMessage & { ok: true }).value as Array<{ lastLoginAt: string | null }>
    )[0]?.lastLoginAt;
    expect(loginAtAfterReload).toBe(loginAtAfterSignIn);

    const setDbRulesOp = {
      t: 'op' as const,
      id: 'set-db-rules',
      method: 'setDatabaseRules' as const,
      source: JSON.stringify({ rules: { '.read': true, '.write': false } }),
    };
    expect(requiresHealthyPersistence(setDbRulesOp)).toBe(true);
    flushCalls = 0;
    await handleMessage(ctx, port, setDbRulesOp);
    expect(port.lastRes().ok).toBe(true);
    expect(flushCalls).toBe(1);
    sandbox.dispose();
  });
});
