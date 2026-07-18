/** Canonical Firebase Firestore imports executed through real Vite resolution. */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ViteDevServer } from 'vite';

import {
  bundleWorker,
  defaultSdkEntries,
  workerSourceHash,
} from '../../src/serve/bundler.js';
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
  let selected;
  for (let index = 0; index < 5; index += 1) {
    selected = (await getDoc(ref)).data()?.selected;
  }
  return selected;
}
`,
    );

    const originalFetch = globalThis.fetch;
    const activityRequests: RequestInit[] = [];
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
          activityToken: 'vite-activity-token',
        });
      }
      if (String(input) === '/__pyric/activity') {
        activityRequests.push(init ?? {});
        return new Response(null, { status: 204 });
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
      const initEntry = defaultSdkEntries().init;
      const runtimeEntry = join(
        dirname(initEntry),
        initEntry.endsWith('.js') ? 'runtime.js' : 'runtime.ts',
      );
      await server.ssrLoadModule(runtimeEntry);
      const fixture = await server.ssrLoadModule('/firestore-smoke.ts') as {
        run(): Promise<string | undefined>;
      };
      await expect(fixture.run()).resolves.toBe('sandbox');
      expect(activityRequests).toHaveLength(1);
      expect(new Headers(activityRequests[0]?.headers).get('x-pyric-activity-token'))
        .toBe('vite-activity-token');
      expect(JSON.parse(String(activityRequests[0]?.body))).toMatchObject({
        pattern: 'repeated-read',
        method: 'get',
        count: 5,
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
