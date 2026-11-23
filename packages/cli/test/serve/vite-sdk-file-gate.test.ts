/**
 * HTTP request gate for installed Firebase SDK files in Vite dev servers
 * (`attachViteSdkRequestGate` in `vite-sdk-file-gate.ts`).
 *
 * Non-canonical `/@fs/` and root-relative URLs (`//@fs/...`, `/./@fs/...`,
 * `/items/../@fs/...`, encoded equivalents) fall past Vite's transform
 * middleware into `serveRawFsMiddleware` / `serveStaticMiddleware`. This
 * pre-middleware intercepts them ahead of Vite in both sandbox and live modes.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../src/serve/vite-plugin.js';
import { allocateFreeVitePort } from './free-vite-port.ts';
import { attachViteSdkRequestGate } from '../../src/serve/vite-sdk-file-gate.js';

const servers: ViteDevServer[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) await server.close();
  }
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function rawGet(base: string, target: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname,
        port,
        path: target,
        headers: { accept: 'text/javascript', connection: 'close' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function createFixtureWithInstalledSdk(): { root: string; firebaseAppFile: string; scopedSdkFile: string } {
  const requireHere = createRequire(import.meta.url);
  const installedPkg = requireHere.resolve('firebase/package.json');
  const installedDir = dirname(installedPkg);

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-sdk-gate-')));
  scratchDirs.push(root);

  const localFbDir = join(root, 'node_modules', 'firebase');
  mkdirSync(localFbDir, { recursive: true });
  copyFileSync(installedPkg, join(localFbDir, 'package.json'));
  const firebaseAppFile = join(localFbDir, 'firebase-app.js');
  copyFileSync(join(installedDir, 'firebase-app.js'), firebaseAppFile);

  const localScopedDir = join(root, 'node_modules', '@firebase', 'firestore', 'dist');
  mkdirSync(localScopedDir, { recursive: true });
  writeFileSync(
    join(root, 'node_modules', '@firebase', 'firestore', 'package.json'),
    JSON.stringify({ name: '@firebase/firestore', type: 'module' }),
  );
  const scopedSdkFile = join(localScopedDir, 'index.esm.js');
  writeFileSync(scopedSdkFile, 'export function getFirestore() { return "REAL_FIRESTORE_SDK_SENTINEL"; }\n');

  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.js'), 'export const appOk = true;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'items-app', type: 'module' }));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>ok</body></html>');
  writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));

  return { root, firebaseAppFile, scopedSdkFile };
}

describe('Vite SDK HTTP request gate', () => {
  it('stops canonical, non-canonical, and standard WHATWG fetch(//@fs...) requests for real Firebase SDK files in pyric()', async () => {
    const { root, firebaseAppFile, scopedSdkFile } = createFixtureWithInstalledSdk();
    const port = await allocateFreeVitePort();
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port, strictPort: false, ws: false },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [pyric({ ui: false, project: 'demo-project' })],
    });
    servers.push(server);
    await server.listen();
    const address = server.httpServer?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('server did not bind to a numeric port');
    }
    const base = `http://127.0.0.1:${address.port}`;

    const rawTargets = [
      `/@fs${firebaseAppFile}`,
      `/./@fs${firebaseAppFile}`,
      `//@fs${firebaseAppFile}`,
      `/items/../@fs${firebaseAppFile}`,
      `/items//../../@fs${firebaseAppFile}`,
      `/%2e/@fs${firebaseAppFile}`,
      `/%40fs${firebaseAppFile}`,
      `//node_modules/firebase/firebase-app.js`,
      `/./node_modules/firebase/firebase-app.js`,
      `/items/../node_modules/firebase/firebase-app.js`,
      `/./@fs${scopedSdkFile}`,
      `//@fs${scopedSdkFile}`,
    ];
    for (const target of rawTargets) {
      const answer = await rawGet(base, target);
      expect(answer.status).toBe(200);
      expect(answer.body).toStartWith('throw Object.assign(new Error(');
      expect(answer.body).toContain('PYRIC_REAL_SDK_STOPPED');
      expect(answer.body).not.toContain('FirebaseAppImpl');
      expect(answer.body).not.toContain('REAL_FIRESTORE_SDK_SENTINEL');
    }

    const fetchDoubleSlash = await fetch(`${base}//@fs${firebaseAppFile}`);
    const fetchBody = await fetchDoubleSlash.text();
    expect(fetchDoubleSlash.status).toBe(200);
    expect(fetchBody).toStartWith('throw Object.assign(new Error(');
    expect(fetchBody).toContain('PYRIC_REAL_SDK_STOPPED');
    expect(fetchBody).not.toContain('FirebaseAppImpl');

    const appResponse = await fetch(`${base}/src/main.js`);
    expect(appResponse.status).toBe(200);
    expect(await appResponse.text()).toContain('appOk');
  });

  it('allows canonical requests for explicitly allowed production-AI SDK files while still stopping non-canonical variants', async () => {
    const { root, scopedSdkFile } = createFixtureWithInstalledSdk();
    const aiDir = join(root, 'node_modules', '@firebase', 'ai', 'dist');
    mkdirSync(aiDir, { recursive: true });
    writeFileSync(
      join(root, 'node_modules', '@firebase', 'ai', 'package.json'),
      JSON.stringify({ name: '@firebase/ai', type: 'module' }),
    );
    const aiFile = join(aiDir, 'index.esm.js');
    writeFileSync(aiFile, 'export function getAI() {}\n');

    let middleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | undefined;
    const server = {
      config: { root, base: '/', publicDir: '' },
      middlewares: {
        use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => {
          middleware = fn;
        },
      },
    };
    const allowedUrls = new Set<string>([pathToFileURL(aiFile).href]);
    attachViteSdkRequestGate(server as unknown as Parameters<typeof attachViteSdkRequestGate>[0], {
      allowedUrls,
      aiMode: () => 'production',
    });

    const ask = (url: string, method = 'GET') =>
      new Promise<{ passed: boolean; body: string }>((resolve) => {
        const res = {
          statusCode: 0,
          setHeader: () => undefined,
          end: (body?: string) => resolve({ passed: false, body: body ?? '' }),
        };
        middleware?.({ url, method } as IncomingMessage, res as unknown as ServerResponse, () =>
          resolve({ passed: true, body: '' }),
        );
      });

    expect((await ask('/node_modules/@firebase/ai/dist/index.esm.js?v=abc')).passed).toBe(true);
    expect((await ask(`/@fs${aiFile}?v=abc`)).passed).toBe(true);
    expect((await ask(`//@fs${aiFile}`)).passed).toBe(false);
    expect((await ask(`/./@fs${aiFile}`)).passed).toBe(false);
    expect((await ask(`/items/../@fs${aiFile}`)).passed).toBe(false);
    expect((await ask(`/%40fs${aiFile}`)).passed).toBe(false);
    expect((await ask(`/@fs${scopedSdkFile}`)).passed).toBe(false);
    const headAnswer = await ask(`//@fs${scopedSdkFile}`, 'HEAD');
    expect(headAnswer.passed).toBe(false);
    expect(headAnswer.body).toBe('');
  });
});
