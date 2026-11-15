/**
 * Session capture snapshots must read active sandbox rules for Firestore,
 * Realtime Database, and Storage instead of boot-time payload fields.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import type { HostCtx } from '../../../src/serve/worker/host.js';
import {
  applyServeInit,
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
  setFirestoreRules(sandbox, BOOT_FIRESTORE_RULES);
  await sandbox.enablePersistence({
    key: `serve-init-capture-rules-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return { db: getFirestore(sandbox), sandbox, subs: new Map(), instanceId: 'capture-rules-test' };
}

function recordingFetch(): typeof fetch & { bodies: string[] } {
  const bodies: string[] = [];
  const fn = ((_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ''));
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
});
