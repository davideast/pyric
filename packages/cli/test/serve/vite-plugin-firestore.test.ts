/**
 * Server-rendered `firebase/*` imports through real Vite resolution, with the
 * Firebase SDK installed in the app (#1123).
 *
 * An installed `firebase` is what Vite externalizes for SSR before any plugin
 * resolves it. This test used to run in a fixture without one, so the plugin
 * always saw the import and the externalized path went untested.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';

import { resetAppRegistryForTests } from 'pyric/app/internal';
import { bundleWorker, defaultSdkEntries, workerSourceHash } from '../../src/serve/bundler.js';
import { pyric } from '../../src/serve/vite-plugin.js';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceRoot = resolve(cliRoot, '../..');

let server: ViteDevServer | undefined;
let fixtureRoot: string | undefined;

/** An app with `firebase` and `@pyric/cli` installed, as a user's project has them. */
function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pyric-vite-firestore-'));
  mkdirSync(join(root, 'node_modules', '@pyric'), { recursive: true });
  symlinkSync(realpathSync(join(workspaceRoot, 'node_modules', 'firebase')), join(root, 'node_modules', 'firebase'), 'dir');
  symlinkSync(cliRoot, join(root, 'node_modules', '@pyric', 'cli'), 'dir');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  writeFileSync(
    join(root, 'firestore-smoke.ts'),
    `import { initializeApp, getApps } from 'firebase/app';
import { doc, getFirestore, setDoc } from 'firebase/firestore';

export async function run() {
  const app = getApps()[0] ?? initializeApp({ apiKey: 'ignored', projectId: 'vite-firestore-smoke' });
  try {
    await setDoc(doc(getFirestore(app), 'package-resolution/firestore'), { selected: 'sandbox' });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code, message: String(error.message) };
  }
}
`,
  );
  return root;
}

beforeAll(async () => {
  await resetAppRegistryForTests();
  await bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) });
  fixtureRoot = createFixture();
  const { createServer } = await import('vite');
  server = await createServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'silent',
    root: fixtureRoot,
    plugins: [pyric({ ui: false })],
    server: { port: 0, host: '127.0.0.1' },
    optimizeDeps: { noDiscovery: true },
  });
  await server.listen();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await resetAppRegistryForTests();
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('server-rendered firebase/firestore through Vite', () => {
  it('runs in a fixture where Vite externalizes the installed SDK', () => {
    expect(existsSync(join(fixtureRoot!, 'node_modules/firebase/package.json'))).toBe(true);
  });

  it('keeps the browser swap and routes the server import to the Node client', async () => {
    const container = server!.pluginContainer;
    const importer = join(fixtureRoot!, 'firestore-smoke.ts');
    const client = await container.resolveId('firebase/firestore', importer);
    expect(client?.id).toBe(defaultSdkEntries().firestore);
    const ssr = await container.resolveId('firebase/firestore', importer, { ssr: true });
    expect(ssr?.id).toBe('\0pyric-ssr-target:@pyric/cli/register/client/firestore');
  });

  it('refuses a server call on a SharedWorker dev server, naming hosted: true', async () => {
    const fixture = await server!.ssrLoadModule('/firestore-smoke.ts') as {
      run(): Promise<{ ok: boolean; code?: string; message?: string }>;
    };
    const outcome = await fixture.run();
    expect(outcome).toMatchObject({ ok: false, code: 'failed-precondition' });
    expect(outcome.message).toContain('pyric({ hosted: true })');
  }, 60_000);
});
