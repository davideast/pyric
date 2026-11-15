/**
 * Evaluates the unmodified browser-bundled `entries/runtime.ts` in isolated Node
 * VM module realms to verify:
 * 1. Boot rules and SSE hot-reload replacements across Firestore, RTDB, and Storage.
 * 2. Single-service boots (Storage-only and Firestore-only, including permissive)
 *    omit unused services, while late SSE rule installs on absent services are captured.
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createContext, SourceTextModule } from 'node:vm';
import { build } from 'esbuild';

const entriesDir = new URL('../../../../src/serve/entries/', import.meta.url).pathname;

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
const UPDATED_RTDB_RULES = { rules: { nodes: { '.read': 'auth != null', '.write': 'auth != null' } } };

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

interface CapturedFixture {
  services: {
    firestore?: { rules: { source: string } };
    rtdb?: { rules: { json: unknown } };
    storage?: { rules: { source: string } };
  };
}

const buildResult = await build({
  stdin: {
    contents: `export * from './runtime.ts';`,
    resolveDir: entriesDir,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const bundle = buildResult.outputFiles[0]?.text;
assert.ok(bundle !== undefined, 'expected esbuild output file for runtime bundle');

async function bootInPageRuntime(initPayload: Record<string, unknown>) {
  const capturedBodies: string[] = [];
  const windowListeners = new Map<string, Array<() => void>>();
  const sseListeners = new Map<string, Array<(event: { data: string }) => void>>();

  class FakeEventSource {
    constructor(_url: string) {}
    addEventListener(type: string, listener: (event: { data: string }) => void): void {
      const existing = sseListeners.get(type) ?? [];
      existing.push(listener);
      sseListeners.set(type, existing);
    }
    close(): void {}
  }

  const fakeWindow = {
    location: new URL('https://app.example/'),
    addEventListener(type: string, listener: () => void): void {
      const existing = windowListeners.get(type) ?? [];
      existing.push(listener);
      windowListeners.set(type, existing);
    },
  };

  const fakeFetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), 'https://app.example/');
    if (url.pathname === '/__pyric/init.json') {
      return new Response(JSON.stringify(initPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/__pyric/capture') {
      capturedBodies.push(String(init.body ?? ''));
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  };

  const context = createContext({
    console: { ...console, info: () => {}, warn: () => {} },
    TextEncoder,
    TextDecoder,
    URL,
    Response,
    Blob,
    AbortController,
    MessageEvent,
    EventSource: FakeEventSource,
    crypto,
    performance,
    queueMicrotask,
    structuredClone,
    indexedDB: globalThis.indexedDB,
    IDBKeyRange: globalThis.IDBKeyRange,
    window: fakeWindow,
    location: fakeWindow.location,
    fetch: fakeFetch,
    __PYRIC_FORCE_INPAGE__: true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });

  const mod = new SourceTextModule(bundle, { context });
  await mod.link(() => {
    throw new Error('unexpected external import in browser runtime bundle');
  });
  await mod.evaluate();

  return {
    capturedBodies,
    async capture(): Promise<CapturedFixture> {
      const before = capturedBodies.length;
      for (const listener of windowListeners.get('pagehide') ?? []) listener();
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(capturedBodies.length > before, 'expected capture POST');
      const body = capturedBodies.at(-1);
      assert.ok(body !== undefined, 'expected capture body');
      return JSON.parse(body) as CapturedFixture;
    },
    emitSse(type: string, data: unknown): void {
      const payload = { data: JSON.stringify(data) };
      for (const listener of sseListeners.get(type) ?? []) listener(payload);
    },
  };
}

// Case 1: All three services configured at boot, then hot-reloaded.
{
  const runtime = await bootInPageRuntime({
    rules: BOOT_FIRESTORE_RULES,
    rulesHash: 'boot-fs',
    databaseRules: BOOT_RTDB_RULES,
    databaseRulesHash: 'boot-rtdb',
    databaseInstances: {
      defaultInstance: 'demo-default-rtdb',
      rules: { 'demo-default-rtdb': BOOT_RTDB_RULES },
    },
    storageRules: BOOT_STORAGE_RULES,
    storageRulesHash: 'boot-storage',
    bridgeUrl: null,
    seed: null,
    capture: true,
    projectKey: 'runtime-capture-all',
    sessionToken: 'tok-runtime-all',
  });

  const bootFixture = await runtime.capture();
  assert.equal(bootFixture.services.firestore?.rules.source, BOOT_FIRESTORE_RULES);
  assert.deepEqual(bootFixture.services.rtdb?.rules.json, BOOT_RTDB_RULES);
  assert.equal(bootFixture.services.storage?.rules.source, BOOT_STORAGE_RULES);

  runtime.emitSse('rules-changed', { rules: UPDATED_FIRESTORE_RULES, rulesHash: 'v2-fs' });
  runtime.emitSse('rtdb-rules-update', {
    instance: 'demo-default-rtdb',
    rules: UPDATED_RTDB_RULES,
    rulesHash: 'v2-rtdb',
  });
  runtime.emitSse('storage-rules-update', { rules: UPDATED_STORAGE_RULES, rulesHash: 'v2-storage' });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const updatedFixture = await runtime.capture();
  assert.equal(updatedFixture.services.firestore?.rules.source, UPDATED_FIRESTORE_RULES);
  assert.deepEqual(updatedFixture.services.rtdb?.rules.json, UPDATED_RTDB_RULES);
  assert.equal(updatedFixture.services.storage?.rules.source, UPDATED_STORAGE_RULES);
}

// Case 2: Storage-only permissive boot omits Firestore and RTDB, then captures late installs.
{
  const runtime = await bootInPageRuntime({
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
    projectKey: 'runtime-capture-storage-only',
    sessionToken: 'tok-runtime-storage',
  });

  const bootFixture = await runtime.capture();
  assert.equal(bootFixture.services.firestore, undefined);
  assert.equal(bootFixture.services.rtdb, undefined);
  assert.equal(bootFixture.services.storage?.rules.source, BOOT_STORAGE_RULES);

  runtime.emitSse('rules-changed', { rules: UPDATED_FIRESTORE_RULES, rulesHash: 'late-fs' });
  runtime.emitSse('rtdb-rules-update', {
    instance: 'demo-default-rtdb',
    rules: UPDATED_RTDB_RULES,
    rulesHash: 'late-rtdb',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const afterInstall = await runtime.capture();
  assert.equal(afterInstall.services.firestore?.rules.source, UPDATED_FIRESTORE_RULES);
  assert.deepEqual(afterInstall.services.rtdb?.rules.json, UPDATED_RTDB_RULES);
  assert.equal(afterInstall.services.storage?.rules.source, BOOT_STORAGE_RULES);
}

// Case 3: Firestore-only permissive boot omits RTDB and Storage.
{
  const runtime = await bootInPageRuntime({
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
    projectKey: 'runtime-capture-fs-only',
    sessionToken: 'tok-runtime-fs',
  });

  const bootFixture = await runtime.capture();
  assert.equal(bootFixture.services.firestore?.rules.source, BOOT_FIRESTORE_RULES);
  assert.equal(bootFixture.services.rtdb, undefined);
  assert.equal(bootFixture.services.storage, undefined);
}
