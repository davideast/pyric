/** Canonical Firebase Storage imports executed through real Vite resolution. */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import type { ViteDevServer } from 'vite';

import { bundleWorker, defaultSdkEntries, workerSourceHash } from '../../src/serve/bundler.js';
import { pyric } from '../../src/serve/vite-plugin.js';
import { browserEntriesInNode } from './vite-plugin-harness.js';

const servers: ViteDevServer[] = [];
const fixtureRoots: string[] = [];

const DENY_ALL = `service firebase.storage {
  match /b/{bucket}/o { match /{path=**} { allow read, write: if false; } }
}`;

beforeAll(async () => {
  await bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) });
}, 180_000);

afterAll(async () => {
  for (const server of servers) await server.close();
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * Serve `fixture` from a fresh project through the Vite plugin, with the
 * in-page runtime reading `payload` as its init payload, and return the
 * fixture module after the runtime has installed it.
 */
async function loadInPage<T>(label: string, fixture: string, payload: Record<string, unknown>): Promise<T> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), `pyric-vite-storage-${label}-`));
  fixtureRoots.push(fixtureRoot);
  expect(existsSync(join(fixtureRoot, 'node_modules/firebase'))).toBe(false);
  writeFileSync(join(fixtureRoot, 'storage-smoke.ts'), fixture);
  const originalFetch = globalThis.fetch;
  const runtimeGlobal = globalThis as typeof globalThis & { __PYRIC_FORCE_INPAGE__?: boolean };
  const originalForceInPage = runtimeGlobal.__PYRIC_FORCE_INPAGE__;
  runtimeGlobal.__PYRIC_FORCE_INPAGE__ = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/__pyric/init.json') return Response.json(payload);
    return originalFetch(input, init);
  }) as typeof fetch;
  const { createServer } = await import('vite');
  try {
    const server = await createServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'silent',
      root: fixtureRoot,
      plugins: [browserEntriesInNode(), pyric({ ui: false })],
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true },
    });
    servers.push(server);
    // Real Vite pages receive this module from transformIndexHtml. Load it
    // explicitly in SSR so project rules are installed before app code.
    const initEntry = defaultSdkEntries().init;
    await server.ssrLoadModule(`/@fs/${join(dirname(initEntry), `runtime${extname(initEntry)}`)}`);
    return await server.ssrLoadModule('/storage-smoke.ts') as T;
  } finally {
    globalThis.fetch = originalFetch;
    if (originalForceInPage === undefined) delete runtimeGlobal.__PYRIC_FORCE_INPAGE__;
    else runtimeGlobal.__PYRIC_FORCE_INPAGE__ = originalForceInPage;
  }
}

describe('canonical Storage operation through Vite', () => {
  it('installs storage rules before an in-page application operation', async () => {
    const fixture = await loadInPage<{ run(): Promise<unknown> }>(
      'rules',
      `import { initializeApp } from 'firebase/app';
import { getStorage, ref, uploadBytes } from 'firebase/storage';

export async function run() {
  const app = initializeApp({ projectId: 'vite-storage-smoke' }, 'vite-storage-smoke');
  const storage = getStorage(app);
  return uploadBytes(ref(storage, 'users/alice/avatar.png'), new Uint8Array([1, 2, 3]));
}
`,
      {
        rules: null,
        rulesHash: null,
        storageRules: DENY_ALL,
        storageRulesHash: 'deny-all-storage',
        bridgeUrl: null,
        seed: null,
        persist: false,
      },
    );
    await expect(fixture.run()).rejects.toMatchObject({ code: 'storage/unauthorized' });
    expect(globalThis.__pyricServe.storageRulesDeployed).toBe(true);
    expect(globalThis.__pyricServe.storageRulesHash).toBe('deny-all-storage');
  }, 60_000);

  it('opens a bucket with no rules deployed in permissive mode, and keeps a deployed bucket rules (#1313)', async () => {
    const fixture = await loadInPage<{ run(): Promise<Record<string, string>> }>(
      'permissive',
      `import { initializeApp } from 'firebase/app';
import { getStorage, ref, uploadBytes } from 'firebase/storage';

async function outcome(storage, path) {
  try {
    await uploadBytes(ref(storage, path), new Uint8Array([1, 2, 3]));
    return 'ok';
  } catch (error) {
    return error.code ?? String(error);
  }
}

export async function run() {
  const app = initializeApp({ projectId: 'vite-storage-permissive', storageBucket: 'vite-storage-permissive.appspot.com' }, 'vite-storage-permissive');
  return {
    defaultBucket: await outcome(getStorage(app), 'a.txt'),
    undeployed: await outcome(getStorage(app, 'gs://undeployed-bucket'), 'a.txt'),
    deployed: await outcome(getStorage(app, 'gs://locked-bucket'), 'a.txt'),
  };
}
`,
      {
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        storageBucketRules: { 'locked-bucket': { rules: DENY_ALL, rulesHash: 'deny-all-locked-bucket' } },
        permissive: true,
        bridgeUrl: null,
        seed: null,
        persist: false,
      },
    );
    expect(await fixture.run()).toEqual({ defaultBucket: 'ok', undeployed: 'ok', deployed: 'storage/unauthorized' });
  }, 60_000);

  it('reports storage rules deployed when firebase.json deploys them only by bucket name (#1313)', async () => {
    const bucket = 'vite-storage-bucket.appspot.com';
    const fixture = await loadInPage<{ run(): Promise<unknown> }>(
      'by-name',
      `import { initializeApp } from 'firebase/app';
import { getStorage, ref, uploadBytes } from 'firebase/storage';

export async function run() {
  const app = initializeApp({ projectId: 'vite-storage-bucket', storageBucket: '${bucket}' }, 'vite-storage-bucket');
  return uploadBytes(ref(getStorage(app), 'users/alice/avatar.png'), new Uint8Array([1, 2, 3]));
}
`,
      {
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        storageBucketRules: { [bucket]: { rules: DENY_ALL, rulesHash: 'by-name' } },
        bridgeUrl: null,
        seed: null,
        persist: false,
      },
    );
    await expect(fixture.run()).rejects.toMatchObject({ code: 'storage/unauthorized' });
    // The worker plane reports the same payload as deployed (serve-init.ts).
    expect(globalThis.__pyricServe.storageRulesDeployed).toBe(true);
  }, 60_000);
});
