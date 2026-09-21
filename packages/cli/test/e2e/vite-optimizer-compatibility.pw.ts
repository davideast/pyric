import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const cliRoot = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8'));
const serverSource = `
import { createServer } from 'vite';
import { pyric } from '@pyric/cli/vite';
const server = await createServer({
  root: process.cwd(), configFile: false,
  plugins: [pyric({ hosted: process.argv[2] === 'Node', seed: 'seed.json', ui: false, capture: false, runtimeChip: false })],
  optimizeDeps: { include: ['sandbox-reader'] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [process.cwd(), ${JSON.stringify(cliRoot)}] } },
});
await server.listen();
process.send(server.resolvedUrls.local[0]);
process.on('message', async () => { await server.close(); process.exit(0); });
process.on('disconnect', async () => { await server.close(); process.exit(0); });
`;

for (const version of ['7.3.6', '8.3.0']) {
  test.describe(`Vite ${version} dependency optimizer`, () => {
    let root: string;
    test.beforeAll(() => {
      test.setTimeout(120_000);
      root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-compat-')));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { vite: version } }));
      execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, timeout: 90_000, stdio: 'pipe' });
      // Copy the built plugin so its Vite import resolves to the fixture's real
      // major. A symlink would silently select the repository's Vite instead.
      const plugin = join(root, 'node_modules/@pyric/cli');
      mkdirSync(plugin, { recursive: true });
      cpSync(join(cliRoot, 'dist'), join(plugin, 'dist'), { recursive: true });
      cpSync(join(cliRoot, 'package.json'), join(plugin, 'package.json'));
      for (const name of [...Object.keys(manifest.dependencies), 'firebase']) {
        const destination = join(root, 'node_modules', name);
        const installed = existsSync(destination);
        if (installed) continue;
        mkdirSync(dirname(destination), { recursive: true });
        symlinkSync(join(cliRoot, 'node_modules', name), destination);
      }
      const reader = join(root, 'node_modules/sandbox-reader');
      mkdirSync(reader);
      writeFileSync(join(reader, 'package.json'), JSON.stringify({ name: 'sandbox-reader', type: 'module', exports: './index.js' }));
      writeFileSync(join(reader, 'index.js'), `
        import { getFirestore, doc, getDoc } from 'firebase/firestore';
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
        import { initializeApp } from 'firebase/app';
        import { readSandboxDocument } from 'sandbox-reader';
        initializeApp({ projectId: 'optimizer-proof' });
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
          const isOptimizedReader = url.includes('/node_modules/.vite/deps/sandbox-reader.js');
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
          await page.goto(url);
          await expect(page.locator('#result')).toHaveText(`sandbox-only-${version}`);
          expect(optimizedRequests).not.toHaveLength(0);
          expect(productionRequests).toEqual([]);
          console.info(`Vite ${version} ${mode}: prebundled reader returned sandbox-only seed; no production Firestore requests`);
          expect(logs).not.toMatch(/esbuildOptions.*deprecated|deprecated.*esbuildOptions/i);
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
