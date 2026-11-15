/**
 * Session capture snapshots must read active sandbox rules for Firestore,
 * Realtime Database, and Storage instead of boot-time payload fields, and
 * must omit unused services rather than recording built-in default rules.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  applyFullState,
  captureFullState,
  createMemoryBackend,
  initializeSandbox,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import type { HostCtx } from '../../../src/serve/worker/host.js';
import {
  syncFirestoreActiveRules,
  syncHostRulesAfterCheckpointRestore,
} from '../../../src/serve/worker/host/rules.js';
import {
  applyServeInit,
  buildWorkerCtx,
  setupWorkerHotReload,
  type EventSourceLike,
} from '../../../src/serve/worker/serve-init.js';
import type { InitPayload } from '../../../src/serve/namespace.js';
import type { PyricVerifyFixture } from '../../../src/verify/fixture.js';

const BOOT_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

const UPDATED_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /items/{id} { allow read, write: if request.auth != null; }',
  '  }',
  '}',
].join('\n');

const BOOT_RTDB_RULES = { rules: { '.read': false, '.write': false } };
const UPDATED_RTDB_RULES = {
  rules: {
    nodes: {
      '.read': 'auth != null',
      '.write': 'auth != null',
    },
  },
};

const BOOT_STORAGE_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /{allPaths=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

const UPDATED_STORAGE_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /files/{uid}/{name} { allow read, write: if request.auth != null && request.auth.uid == uid; }',
  '  }',
  '}',
].join('\n');

class FakeEventSource implements EventSourceLike {
  listeners = new Map<string, (ev: { data: string }) => void>();
  closed = false;
  constructor(public url: string) {}
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({
    key: `serve-init-capture-rules-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return { db: getFirestore(sandbox), sandbox, subs: new Map(), instanceId: 'capture-rules-test' };
}

function recordingFetch(initPayload?: InitPayload): typeof fetch & { bodies: string[] } {
  const bodies: string[] = [];
  const fn = ((input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      url = input.url;
    }
    if (initPayload !== undefined && url.includes('/__pyric/init.json')) {
      return Promise.resolve(
        new Response(JSON.stringify(initPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.includes('/__pyric/capture')) {
      if (init?.method === 'POST') {
        bodies.push(String(init.body ?? ''));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch & { bodies: string[] };
  fn.bodies = bodies;
  return fn;
}

const basePayload: InitPayload = {
  activityToken: 'activity-token',
  rules: BOOT_FIRESTORE_RULES,
  rulesHash: 'boot-fs',
  databaseRules: BOOT_RTDB_RULES,
  databaseRulesHash: 'boot-rtdb',
  storageRules: BOOT_STORAGE_RULES,
  storageRulesHash: 'boot-storage',
  bridgeUrl: null,
  seed: null,
  capture: true,
};

describe('applyServeInit capture active rules snapshot', () => {
  it('captures boot-time storageRules and updated active Firestore, RTDB, and Storage rules after hot-reload', async () => {
    const ctx = await makeCtx();
    const fetchSpy = recordingFetch();
    const init = applyServeInit(ctx, basePayload, { fetch: fetchSpy, captureDebounceMs: 10 });
    const fakeEs = new FakeEventSource('/__pyric/events');
    const stopHotReload = setupWorkerHotReload(ctx, () => fakeEs);
    try {
      await ctx.captureFlush?.();
      expect(fetchSpy.bodies.length).toBeGreaterThanOrEqual(1);
      const bootCapture = JSON.parse(fetchSpy.bodies.at(-1) ?? '{}') as PyricVerifyFixture;
      expect(bootCapture.services.firestore?.rules.source).toBe(BOOT_FIRESTORE_RULES);
      expect(bootCapture.services.rtdb?.rules.json).toEqual(BOOT_RTDB_RULES);
      expect(bootCapture.services.storage?.rules.source).toBe(BOOT_STORAGE_RULES);

      fakeEs.emit('rules-changed', { rules: UPDATED_FIRESTORE_RULES, rulesHash: 'v2-fs' });
      fakeEs.emit('rtdb-rules-update', { rules: UPDATED_RTDB_RULES, rulesHash: 'v2-rtdb' });
      fakeEs.emit('storage-rules-update', { rules: UPDATED_STORAGE_RULES, rulesHash: 'v2-storage' });
      await new Promise((resolve) => setTimeout(resolve, 25));

      await ctx.captureFlush?.();
      const updatedCapture = JSON.parse(fetchSpy.bodies.at(-1) ?? '{}') as PyricVerifyFixture;
      expect(updatedCapture.services.firestore?.rules.source).toBe(UPDATED_FIRESTORE_RULES);
      expect(updatedCapture.services.rtdb?.rules.json).toEqual(UPDATED_RTDB_RULES);
      expect(updatedCapture.services.storage?.rules.source).toBe(UPDATED_STORAGE_RULES);
    } finally {
      stopHotReload();
      init.dispose();
      ctx.sandbox.dispose();
    }
  });

  it('omits Firestore on Storage-only and RTDB-only worker boots (including permissive) and captures rules installed later', async () => {
    const storageOnlyPayload: InitPayload = {
      activityToken: 'activity-token',
      rules: null,
      rulesHash: null,
      databaseRules: null,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: 'demo-default-rtdb',
        rules: { 'demo-default-rtdb': null },
      },
      storageRules: BOOT_STORAGE_RULES,
      storageRulesHash: 'boot-storage',
      permissive: true,
      bridgeUrl: null,
      seed: null,
      capture: true,
    };
    const fetchSpy = recordingFetch(storageOnlyPayload);
    const fakeEs = new FakeEventSource('/__pyric/events');
    const ctx = await buildWorkerCtx({
      fetch: fetchSpy,
      idb: createMemoryBackend(),
      persistenceKey: `worker-storage-only-${Math.random()}`,
      captureDebounceMs: 10,
      makeEventSource: () => fakeEs,
    });
    try {
      await ctx.captureFlush?.();
      const bootCapture = JSON.parse(fetchSpy.bodies.at(-1) ?? '{}') as PyricVerifyFixture;
      expect(bootCapture.services.firestore).toBeUndefined();
      expect(bootCapture.services.rtdb).toBeUndefined();
      expect(bootCapture.services.storage?.rules.source).toBe(BOOT_STORAGE_RULES);

      // Installing Firestore and RTDB rules at runtime when boot rules were absent must be captured.
      fakeEs.emit('rules-changed', { rules: UPDATED_FIRESTORE_RULES, rulesHash: 'late-fs' });
      fakeEs.emit('rtdb-rules-update', { rules: UPDATED_RTDB_RULES, rulesHash: 'late-rtdb' });
      await new Promise((resolve) => setTimeout(resolve, 25));

      await ctx.captureFlush?.();
      const afterInstall = JSON.parse(fetchSpy.bodies.at(-1) ?? '{}') as PyricVerifyFixture;
      expect(afterInstall.services.firestore?.rules.source).toBe(UPDATED_FIRESTORE_RULES);
      expect(afterInstall.services.rtdb?.rules.json).toEqual(UPDATED_RTDB_RULES);
      expect(afterInstall.services.storage?.rules.source).toBe(BOOT_STORAGE_RULES);
    } finally {
      ctx.dispose?.();
      ctx.sandbox.dispose();
    }
  });

  it('omits RTDB and Storage on a Firestore-only worker boot (including permissive) and omits Firestore on RTDB-only boot', async () => {
    const firestoreOnlyPayload: InitPayload = {
      activityToken: 'activity-token',
      rules: BOOT_FIRESTORE_RULES,
      rulesHash: 'boot-fs',
      databaseRules: null,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: 'demo-default-rtdb',
        rules: { 'demo-default-rtdb': null },
      },
      storageRules: null,
      storageRulesHash: null,
      permissive: true,
      bridgeUrl: null,
      seed: null,
      capture: true,
    };
    const fsFetch = recordingFetch(firestoreOnlyPayload);
    const fsCtx = await buildWorkerCtx({
      fetch: fsFetch,
      idb: createMemoryBackend(),
      persistenceKey: `worker-fs-only-${Math.random()}`,
      captureDebounceMs: 10,
      makeEventSource: null,
    });
    try {
      await fsCtx.captureFlush?.();
      const fsCapture = JSON.parse(fsFetch.bodies.at(-1) ?? '{}') as PyricVerifyFixture;
      expect(fsCapture.services.firestore?.rules.source).toBe(BOOT_FIRESTORE_RULES);
      expect(fsCapture.services.rtdb).toBeUndefined();
      expect(fsCapture.services.storage).toBeUndefined();
    } finally {
      fsCtx.dispose?.();
      fsCtx.sandbox.dispose();
    }

    const rtdbOnlyPayload: InitPayload = {
      activityToken: 'activity-token',
      rules: null,
      rulesHash: null,
      databaseRules: BOOT_RTDB_RULES,
      databaseRulesHash: 'boot-rtdb',
      databaseInstances: {
        defaultInstance: 'demo-default-rtdb',
        rules: { 'demo-default-rtdb': BOOT_RTDB_RULES },
      },
      storageRules: null,
      storageRulesHash: null,
      permissive: true,
      bridgeUrl: null,
      seed: null,
      capture: true,
    };
    const rtdbFetch = recordingFetch(rtdbOnlyPayload);
    const rtdbCtx = await buildWorkerCtx({
      fetch: rtdbFetch,
      idb: createMemoryBackend(),
      persistenceKey: `worker-rtdb-only-${Math.random()}`,
      captureDebounceMs: 10,
      makeEventSource: null,
    });
    try {
      await rtdbCtx.captureFlush?.();
      const rtdbCapture = JSON.parse(rtdbFetch.bodies.at(-1) ?? '{}') as PyricVerifyFixture;
      expect(rtdbCapture.services.firestore).toBeUndefined();
      expect(rtdbCapture.services.storage).toBeUndefined();
      expect(rtdbCapture.services.rtdb?.rules.json).toEqual(BOOT_RTDB_RULES);
    } finally {
      rtdbCtx.dispose?.();
      rtdbCtx.sandbox.dispose();
    }
  });

  it('clears tracked Firestore rules and keeps capture Firestore-free after restoring an implicit checkpoint', async () => {
    const ctx = await makeCtx();
    const fetchSpy = recordingFetch();
    const init = applyServeInit(ctx, basePayload, { fetch: fetchSpy, captureDebounceMs: 10 });
    try {
      const implicitSandbox = initializeSandbox();
      const implicitState = await captureFullState(implicitSandbox);

      await applyFullState(ctx.sandbox, implicitState);
      syncHostRulesAfterCheckpointRestore(ctx, implicitState.rules);
      syncFirestoreActiveRules(ctx);
      expect(ctx.activeRules?.firestore).toBeUndefined();

      await ctx.captureFlush?.();
      const restoredCapture = JSON.parse(fetchSpy.bodies.at(-1) ?? '{}') as PyricVerifyFixture;
      expect(restoredCapture.services.firestore).toBeUndefined();
    } finally {
      init.dispose();
      ctx.sandbox.dispose();
    }
  });
});
