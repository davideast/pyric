/** Canonical Firebase Firestore imports executed through real Vite resolution. */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';

import { bundleWorker, workerSourceHash } from '../../src/serve/bundler.js';
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

describe('canonical Firestore operation through Vite', () => {
  it('writes and reads through the package-selected sandbox mirror', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pyric-vite-firestore-'));
    expect(existsSync(join(fixtureRoot, 'node_modules/firebase'))).toBe(false);
    writeFileSync(
      join(fixtureRoot, 'firestore-smoke.ts'),
      `import { initializeApp } from 'firebase/app';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';

export async function run() {
  const app = initializeApp(
    { apiKey: 'ignored', projectId: 'vite-firestore-smoke' },
    'vite-firestore-smoke',
  );
  const db = getFirestore(app);
  const ref = doc(db, 'package-resolution/firestore');
  await setDoc(ref, { selected: 'sandbox' });
  return (await getDoc(ref)).data()?.selected;
}
`,
    );

    const originalFetch = globalThis.fetch;
    const runtimeGlobal = globalThis as typeof globalThis & {
      __PYRIC_FORCE_INPAGE__?: boolean;
    };
    const originalForceInPage = runtimeGlobal.__PYRIC_FORCE_INPAGE__;
    runtimeGlobal.__PYRIC_FORCE_INPAGE__ = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/__pyric/init.json') {
        return Response.json({
          rules: null,
          rulesHash: null,
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
      const fixture = await server.ssrLoadModule('/firestore-smoke.ts') as {
        run(): Promise<string | undefined>;
      };
      await expect(fixture.run()).resolves.toBe('sandbox');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalForceInPage === undefined) {
        delete runtimeGlobal.__PYRIC_FORCE_INPAGE__;
      } else {
        runtimeGlobal.__PYRIC_FORCE_INPAGE__ = originalForceInPage;
      }
    }
  }, 60_000);
});
