import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { bundleSdk, defaultSdkEntries } from '../../../dist/serve/bundler.js';
import { injectServeTags } from '../../../src/serve/html-injection.js';
import { createPyricNamespace, type InitPayload } from '../../../src/serve/namespace.js';

/** Hold the agreed persistence-backend seam; never depend on whole-store exports. */
export async function startPausedPersistenceHost(options: { browser?: boolean; rules?: string } = {}) {
  const servesBrowser = options.browser === true;
  const dir = mkdtempSync(join(tmpdir(), 'pyric-held-persistence-'));
  const persistence = await createHostedPersistence(dir);
  const mount = createBridgeMount({ hosted: true, projectKey: dir, disableAuditLog: true });
  const payload: InitPayload = {
    rules: options.rules ?? null, rulesHash: null,
    storageRules: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if true; } } }",
    storageRulesHash: null, bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: dir,
  };
  let holding = true;
  let heldCount = 0;
  const waiting: (() => void)[] = [];
  function release(): void {
    holding = false;
    for (const resolve of waiting.splice(0)) resolve();
  }
  let namespace: ReturnType<typeof createPyricNamespace> | undefined;
  const html = injectServeTags(`<!doctype html><html><head></head><body>
    <output id="ready">Starting</output><script type="module">
    import { initializeApp } from 'firebase/app';
    import { getStorage, listAll, ref } from 'firebase/storage';
    initializeApp({ apiKey: 'demo', projectId: 'demo-hosted', storageBucket: 'demo-hosted.appspot.com' });
    await listAll(ref(getStorage(), 'files'));
    document.querySelector('#ready').textContent = 'Ready';
    </script></body></html>`, { hosted: { projectKey: dir } });
  let closed = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    async function handle(): Promise<void> {
      const handled = await mount.handler(req, res, url);
      if (handled) return;
      const served = (await namespace?.(req, res, url)) === true;
      if (served) return;
      const isPage = servesBrowser && url.pathname === '/';
      if (isPage) { res.writeHead(200, { 'content-type': 'text/html' }).end(html); return; }
      res.writeHead(404).end();
    }
    void handle().catch(() => res.writeHead(500).end());
  });
  async function stop(): Promise<void> {
    if (closed) return;
    closed = true;
    release();
    try { await mount.close(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      persistence.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  try {
    if (servesBrowser) {
      const sdk = await bundleSdk({ entries: defaultSdkEntries() });
      namespace = createPyricNamespace({ sdkDir: sdk.outDir, initPayload: () => payload });
      mount.attachHost({ servers: [server], projectDir: dir, origin: () => null, closeOnServerClose: false });
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const missingAddress = address === null || typeof address === 'string';
    if (missingAddress) throw new Error('Missing test server address.');
    const url = `http://127.0.0.1:${address.port}`;
    payload.bridgeUrl = mount.wsUrl({ host: '127.0.0.1', port: address.port });
    await mount.startHostedSandbox(payload, url, { persistence: {
      ...persistence,
      backend: {
        ...persistence.backend,
        async applyChanges(key, changed, removed) {
          const changesDocuments = [...changed.keys()].some(id => id !== 'meta');
          // After the first document mutation, hold even unchanged flushes:
          // repeated writes still retain their admission charge until acknowledgment.
          const reachedMutation = heldCount > 0 || changesDocuments;
          const holdThisCommit = holding && reachedMutation;
          if (holdThisCommit) {
            heldCount += 1;
            await new Promise<void>(resolve => waiting.push(resolve));
          }
          await persistence.backend.applyChanges(key, changed, removed);
        },
      },
    } });
    return {
      dir, url, held: () => heldCount > 0, heldCount: () => heldCount,
      pause: () => { holding = true; }, releaseNext: () => waiting.shift()?.(), release, stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
