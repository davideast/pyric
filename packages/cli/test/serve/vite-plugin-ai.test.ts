/** Canonical Firebase AI imports executed through the real Vite resolution seam. */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('canonical AI operation through Vite', () => {
  it('shares the default app handle and completes generateContent()', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'pyric-vite-ai-'));
    writeFileSync(
      join(fixtureRoot, 'ai-smoke.ts'),
      `import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel } from 'firebase/ai';

export async function run() {
  const app = initializeApp({ apiKey: 'ignored', projectId: 'vite-ai-smoke' });
  const explicit = getAI(app);
  const bare = getAI();
  const result = await getGenerativeModel(explicit, {
    model: 'gemini-flash-lite-latest',
  }).generateContent('hello');
  return {
    sameHandle: explicit === bare,
    location: explicit.location,
    candidates: result.response.candidates.length,
  };
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
      const fixture = await server.ssrLoadModule('/ai-smoke.ts') as {
        run(): Promise<{ sameHandle: boolean; location: string; candidates: number }>;
      };
      await expect(fixture.run()).resolves.toEqual({
        sameHandle: true,
        location: '',
        candidates: 1,
      });
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
