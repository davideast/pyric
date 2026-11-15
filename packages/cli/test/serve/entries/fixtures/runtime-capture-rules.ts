/**
 * Evaluates the unmodified browser-bundled `entries/runtime.ts` in a Node VM
 * module realm, delivers SSE hot-reload rule updates across Firestore, RTDB,
 * and Storage, triggers a `pagehide` capture flush, and asserts the posted
 * fixture carries the active updated rules for all three services.
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

const bundle = (await build({
  stdin: {
    contents: `export * from './runtime.ts';`,
    resolveDir: entriesDir,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
})).outputFiles[0]!.text;

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
    return new Response(
      JSON.stringify({
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
        projectKey: 'runtime-capture-test',
        sessionToken: 'tok-runtime',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
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

const firePagehide = () => {
  for (const listener of windowListeners.get('pagehide') ?? []) listener();
};

const emitSse = (type: string, data: unknown) => {
  const payload = { data: JSON.stringify(data) };
  for (const listener of sseListeners.get(type) ?? []) listener(payload);
};

// First capture: boot rules must include storageRules too.
firePagehide();
await new Promise((resolve) => setTimeout(resolve, 25));
assert.ok(capturedBodies.length >= 1, 'expected initial capture POST');
const bootFixture = JSON.parse(capturedBodies.at(-1)!) as {
  services: {
    firestore?: { rules: { source: string } };
    rtdb?: { rules: { json: unknown } };
    storage?: { rules: { source: string } };
  };
};
assert.equal(bootFixture.services.firestore?.rules.source, BOOT_FIRESTORE_RULES);
assert.deepEqual(bootFixture.services.rtdb?.rules.json, BOOT_RTDB_RULES);
assert.equal(bootFixture.services.storage?.rules.source, BOOT_STORAGE_RULES);

// Hot-reload all three services, then flush capture again.
emitSse('rules-changed', { rules: UPDATED_FIRESTORE_RULES, rulesHash: 'v2-fs' });
emitSse('rtdb-rules-update', {
  instance: 'demo-default-rtdb',
  rules: UPDATED_RTDB_RULES,
  rulesHash: 'v2-rtdb',
});
emitSse('storage-rules-update', { rules: UPDATED_STORAGE_RULES, rulesHash: 'v2-storage' });
await new Promise((resolve) => setTimeout(resolve, 50));

firePagehide();
await new Promise((resolve) => setTimeout(resolve, 25));
const updatedFixture = JSON.parse(capturedBodies.at(-1)!) as {
  services: {
    firestore?: { rules: { source: string } };
    rtdb?: { rules: { json: unknown } };
    storage?: { rules: { source: string } };
  };
};
assert.equal(updatedFixture.services.firestore?.rules.source, UPDATED_FIRESTORE_RULES);
assert.deepEqual(updatedFixture.services.rtdb?.rules.json, UPDATED_RTDB_RULES);
assert.equal(updatedFixture.services.storage?.rules.source, UPDATED_STORAGE_RULES);
