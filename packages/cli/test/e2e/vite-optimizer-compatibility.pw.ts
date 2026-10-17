import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { SDK_MODULES } from '../../dist/serve/bundler.js';

const cliRoot = fileURLToPath(new URL('../../', import.meta.url));
const sdkImports = SDK_MODULES.map((name, index) => `import * as sdk${index} from ${JSON.stringify(name)};`).join('\n');
const sdkNamespaces = `[${SDK_MODULES.map((_, index) => `sdk${index}`).join(',')}]`;
const serverSource = `
import { createServer } from 'vite';
import { pyric } from '@pyric/cli/vite';
const server = await createServer({
  root: process.cwd(), configFile: false,
  plugins: [pyric({ hosted: process.argv[2] === 'Node', seed: 'seed.json', ui: false, capture: false, runtimeChip: false })],
  cacheDir: 'node_modules/.vite-' + process.argv[2],
  optimizeDeps: { include: ['sandbox-reader'] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [process.cwd(), ${JSON.stringify(cliRoot)}] } },
});
await server.listen();
process.send(server.resolvedUrls.local[0]);
process.on('message', async () => { await server.close(); process.exit(0); });
process.on('disconnect', async () => { await server.close(); process.exit(0); });
`;

/** Copy a built workspace package into the fixture and link the dependencies it
 *  declares (plus `extra`) from the workspace, unless the fixture has them. */
function copyBuiltPackage(source: string, name: string, root: string, extra: string[] = []): void {
  const destination = join(root, 'node_modules', name);
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, 'dist'), join(destination, 'dist'), { recursive: true });
  cpSync(join(source, 'package.json'), join(destination, 'package.json'));
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const declared = manifest.dependencies ?? {};
  for (const dependency of [...Object.keys(declared), ...extra]) {
    const link = join(root, 'node_modules', dependency);
    const installed = existsSync(link);
    if (installed) continue;
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(source, 'node_modules', dependency), link);
  }
}

for (const version of ['7.3.6', '8.3.0']) {
  test.describe(`Vite ${version} dependency optimizer`, () => {
    let root: string;
    test.beforeAll(() => {
      test.setTimeout(120_000);
      root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-compat-')));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { vite: version } }));
      execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, timeout: 90_000, stdio: 'pipe' });
      // Copy the built plugin and the pyric package into node_modules, as an npm
      // install lays them out. A symlinked plugin would import the repository's
      // Vite instead of the fixture's major. A symlinked pyric resolves to the
      // workspace, outside node_modules, so Vite treats it as source code: it
      // finds pyric's own dependencies only after the page starts loading,
      // re-optimizes, and sends a full reload that Vite 7 drops when its HMR
      // client has not connected yet, leaving the page at "Starting".
      copyBuiltPackage(realpathSync(join(cliRoot, 'node_modules/pyric')), 'pyric', root);
      copyBuiltPackage(cliRoot, '@pyric/cli', root, ['firebase']);
      const reader = join(root, 'node_modules/sandbox-reader');
      mkdirSync(reader);
      writeFileSync(join(reader, 'package.json'), JSON.stringify({ name: 'sandbox-reader', type: 'module', exports: './index.js' }));
      writeFileSync(join(reader, 'index.js'), `
        ${sdkImports}
        import { getFirestore, doc, getDoc } from 'firebase/firestore';
        export { getApp } from 'firebase/app';
        export const modules = ${sdkNamespaces};
        export async function readSandboxDocument() {
          return (await getDoc(doc(getFirestore(), 'proof/document'))).data()?.value;
        }
      `);
      writeFileSync(join(root, 'seed.json'), JSON.stringify({ 'proof/document': { value: `sandbox-only-${version}` } }));
      writeFileSync(join(root, 'firestore.rules'), `rules_version = '2'; service cloud.firestore {
        match /databases/{database}/documents { match /proof/{id} { allow read: if true; } }
      }`);
      writeFileSync(join(root, 'index.html'), '<output id="result">Starting</output><script type="module" src="/main.js"></script>');
      writeFileSync(join(root, 'main.js'), `
        ${sdkImports}
        import { initializeApp } from 'firebase/app';
        import { readSandboxDocument, getApp, modules } from 'sandbox-reader';
        const app = initializeApp({ projectId: 'optimizer-proof' });
        window.moduleIdentity = {
          app: getApp() === app,
          entries: Object.fromEntries(${JSON.stringify(SDK_MODULES)}.map((name, index) => [name, ${sdkNamespaces}[index] === modules[index]])),
        };
        document.querySelector('#result').textContent = await readSandboxDocument();
      `);
      writeFileSync(join(root, 'server.mjs'), serverSource);
    });
    test.afterAll(() => { rmSync(root, { recursive: true, force: true }); });

    for (const mode of ['SharedWorker', 'Node']) {
      test(`prebundled dependency reads sandbox data without deprecated options (${mode})`, async ({ page }) => {
        test.setTimeout(60_000);
        const productionRequests: string[] = [];
        const optimizedRequests: string[] = [];
        await page.route('**/*', async route => {
          const url = route.request().url();
          const isProductionFirestore = new URL(url).hostname === 'firestore.googleapis.com';
          if (isProductionFirestore) { productionRequests.push(url); await route.abort(); return; }
          const isOptimizedReader = url.includes(`/node_modules/.vite-${mode}/deps/sandbox-reader.js`);
          if (isOptimizedReader) optimizedRequests.push(url);
          await route.continue();
        });
        const server = fork(join(root, 'server.mjs'), [mode], { cwd: root, silent: true, execArgv: [] });
        let logs = '';
        server.stdout?.on('data', chunk => { logs += chunk.toString(); });
        server.stderr?.on('data', chunk => { logs += chunk.toString(); });
        try {
          const stopped = once(server, 'exit').then(() => { throw new Error(`Vite exited before startup:\n${logs}`); });
          const started = once(server, 'message', { signal: AbortSignal.timeout(30_000) });
          const [url] = await Promise.race([started, stopped]);
          expect(typeof url, logs).toBe('string');
          // Open the page after the startup optimizer run has committed, as a
          // user does who opens the browser a moment after starting Vite. Any
          // dependency the page reveals now forces a second run and a reload.
          const metadata = join(root, `node_modules/.vite-${mode}/deps/_metadata.json`);
          await expect.poll(() => existsSync(metadata), { message: 'the startup optimizer run never committed', timeout: 30_000 }).toBe(true);
          await page.goto(url);
          await expect(page.locator('#result')).toHaveText(`sandbox-only-${version}`);
          expect(await page.evaluate(() => Reflect.get(window, 'moduleIdentity'))).toEqual({
            app: true,
            entries: Object.fromEntries(SDK_MODULES.map(name => [name, true])),
          });
          expect(optimizedRequests).not.toHaveLength(0);
          expect(productionRequests).toEqual([]);
          console.info(`Vite ${version} ${mode}: prebundled reader returned sandbox-only seed; no production Firestore requests`);
          expect(logs).not.toMatch(/esbuildOptions.*deprecated|deprecated.*esbuildOptions/i);
          // The first optimizer run must cover everything the page loads. A
          // second run reloads the page, and Vite 7 can drop that reload.
          expect(logs).not.toMatch(/optimized dependencies changed/);
        } finally {
          await page.close();
          const running = server.exitCode === null && server.signalCode === null;
          if (running) {
            const exited = once(server, 'exit');
            const connected = server.connected;
            if (connected) server.send('close');
            else server.kill();
            const killDeadline = setTimeout(() => server.kill('SIGKILL'), 5_000);
            await exited;
            clearTimeout(killDeadline);
          }
        }
      });
    }
  });
}
