/** Canonical Firebase Storage imports executed through real Vite resolution. */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import type { ViteDevServer } from 'vite';

import { bundleWorker, defaultSdkEntries, workerSourceHash } from '../../src/serve/bundler.js';
import { pyricSandbox } from '../../src/serve/vite-plugin.js';

let server: ViteDevServer | undefined;
let fixtureRoot: string | undefined;

beforeAll(async () => {
  await bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) });
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('canonical Storage operation through Vite', () => {
  it('installs storage rules before an in-page application operation', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pyric-vite-storage-'));
    expect(existsSync(join(fixtureRoot, 'node_modules/firebase'))).toBe(false);
    writeFileSync(
      join(fixtureRoot, 'storage-smoke.ts'),
      `import { initializeApp } from 'firebase/app';
import { getStorage, ref, uploadBytes } from 'firebase/storage';

export async function run() {
  const app = initializeApp({ projectId: 'vite-storage-smoke' }, 'vite-storage-smoke');
  const storage = getStorage(app);
  return uploadBytes(ref(storage, 'users/alice/avatar.png'), new Uint8Array([1, 2, 3]));
}
`,
    );

    const originalFetch = globalThis.fetch;
    const runtimeGlobal = globalThis as typeof globalThis & { __PYRIC_FORCE_INPAGE__?: boolean };
    const originalForceInPage = runtimeGlobal.__PYRIC_FORCE_INPAGE__;
    runtimeGlobal.__PYRIC_FORCE_INPAGE__ = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/__pyric/init.json') {
        return Response.json({
          rules: null,
          rulesHash: null,
          storageRules: `service firebase.storage {
            match /b/{bucket}/o { match /{path=**} { allow read, write: if false; } }
          }`,
          storageRulesHash: 'deny-all-storage',
          bridgeUrl: null,
          seed: null,
          persist: false,
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const { createServer } = await import('vite');
    try {
      server = await createServer({
        appType: 'custom',
        configFile: false,
        logLevel: 'silent',
        root: fixtureRoot,
        plugins: [pyricSandbox({ ui: false })],
        server: { middlewareMode: true },
        optimizeDeps: { noDiscovery: true },
      });
      // Real Vite pages receive this module from transformIndexHtml. Load it
      // explicitly in SSR so project rules are installed before app code.
      const initEntry = defaultSdkEntries().init;
      await server.ssrLoadModule(`/@fs/${join(dirname(initEntry), `runtime${extname(initEntry)}`)}`);
      const fixture = await server.ssrLoadModule('/storage-smoke.ts') as {
        run(): Promise<unknown>;
      };
      await expect(fixture.run()).rejects.toMatchObject({ code: 'storage/unauthorized' });
      expect(globalThis.__pyricServe.storageRulesDeployed).toBe(true);
      expect(globalThis.__pyricServe.storageRulesHash).toBe('deny-all-storage');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalForceInPage === undefined) delete runtimeGlobal.__PYRIC_FORCE_INPAGE__;
      else runtimeGlobal.__PYRIC_FORCE_INPAGE__ = originalForceInPage;
    }
  }, 60_000);
});
