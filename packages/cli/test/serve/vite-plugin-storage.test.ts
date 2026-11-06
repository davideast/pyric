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

beforeAll(async () => {
  await bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) });
}, 180_000);

afterAll(async () => {
  for (const server of servers) await server.close();
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

const DENY_ALL_STORAGE = `service firebase.storage {
  match /b/{bucket}/o { match /{path=**} { allow read, write: if false; } }
}`;

/** A module whose `run` uploads one object to the default bucket of an app with `options`. */
function uploadModule(options: { projectId: string; storageBucket?: string }): string {
  return `import { initializeApp } from 'firebase/app';
import { getStorage, ref, uploadBytes } from 'firebase/storage';

export async function run() {
  const app = initializeApp(${JSON.stringify(options)}, ${JSON.stringify(options.projectId)});
  const storage = getStorage(app);
  return uploadBytes(ref(storage, 'users/alice/avatar.png'), new Uint8Array([1, 2, 3]));
}
`;
}

/**
 * Load the page runtime through a new Vite server whose `/__pyric/init.json`
 * answers `payload`, then the module `source`, and start its `run`.
 */
async function runInPage(payload: Record<string, unknown>, source: string): Promise<{ outcome: Promise<unknown> }> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pyric-vite-storage-'));
  fixtureRoots.push(fixtureRoot);
  expect(existsSync(join(fixtureRoot, 'node_modules/firebase'))).toBe(false);
  writeFileSync(join(fixtureRoot, 'storage-smoke.ts'), source);

  const originalFetch = globalThis.fetch;
  const runtimeGlobal = globalThis as typeof globalThis & { __PYRIC_FORCE_INPAGE__?: boolean };
  const originalForceInPage = runtimeGlobal.__PYRIC_FORCE_INPAGE__;
  runtimeGlobal.__PYRIC_FORCE_INPAGE__ = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/__pyric/init.json') {
      return Response.json({ rules: null, rulesHash: null, bridgeUrl: null, seed: null, persist: false, ...payload });
    }
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
    const fixture = await server.ssrLoadModule('/storage-smoke.ts') as {
      run(): Promise<unknown>;
    };
    const outcome = fixture.run();
    // Settle before the fetch is restored; the caller reads the outcome.
    await outcome.catch(() => undefined);
    return { outcome };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalForceInPage === undefined) delete runtimeGlobal.__PYRIC_FORCE_INPAGE__;
    else runtimeGlobal.__PYRIC_FORCE_INPAGE__ = originalForceInPage;
  }
}

describe('canonical Storage operation through Vite', () => {
  it('installs storage rules before an in-page application operation', async () => {
    const { outcome } = await runInPage(
      { storageRules: DENY_ALL_STORAGE, storageRulesHash: 'deny-all-storage' },
      uploadModule({ projectId: 'vite-storage-smoke' }),
    );
    await expect(outcome).rejects.toMatchObject({ code: 'storage/unauthorized' });
    expect(globalThis.__pyricServe.storageRulesDeployed).toBe(true);
    expect(globalThis.__pyricServe.storageRulesHash).toBe('deny-all-storage');
  }, 60_000);

  it('reports storage rules deployed when firebase.json deploys them only by bucket name (#1313)', async () => {
    const bucket = 'vite-storage-bucket.appspot.com';
    const { outcome } = await runInPage(
      {
        storageRules: null,
        storageRulesHash: null,
        storageBucketRules: { [bucket]: { rules: DENY_ALL_STORAGE, rulesHash: 'by-name' } },
      },
      uploadModule({ projectId: 'vite-storage-bucket', storageBucket: bucket }),
    );
    await expect(outcome).rejects.toMatchObject({ code: 'storage/unauthorized' });
    // The worker plane reports the same payload as deployed (serve-init.ts).
    expect(globalThis.__pyricServe.storageRulesDeployed).toBe(true);
  }, 60_000);
});
