import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';

/** Hold the agreed persistence-backend seam; never depend on whole-store exports. */
export async function startPausedPersistenceHost() {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-held-persistence-'));
  const persistence = await createHostedPersistence(dir);
  const mount = createBridgeMount({ hosted: true, projectKey: dir, disableAuditLog: true });
  const released = Promise.withResolvers<void>();
  let held = false;
  let closed = false;
  const server = createServer((req, res) => {
    void mount.handler(req, res, new URL(req.url ?? '/', 'http://localhost')).then(handled => {
      const unmatched = !handled;
      if (unmatched) res.writeHead(404).end();
    }).catch(() => res.writeHead(500).end());
  });
  async function stop(): Promise<void> {
    if (closed) return;
    closed = true;
    released.resolve();
    try { await mount.close(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      persistence.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const missingAddress = address === null || typeof address === 'string';
    if (missingAddress) throw new Error('Missing test server address.');
    const url = `http://127.0.0.1:${address.port}`;
    await mount.startHostedSandbox({
      rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
      bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: dir,
    }, url, { persistence: {
      ...persistence,
      backend: {
        ...persistence.backend,
        async applyChanges(key, changed, removed) {
          const changesDocuments = [...changed.keys()].some(id => id !== 'meta');
          const holdThisCommit = !held && changesDocuments;
          if (holdThisCommit) {
            held = true;
            await released.promise;
          }
          await persistence.backend.applyChanges(key, changed, removed);
        },
      },
    } });
    return { dir, url, held: () => held, release: () => released.resolve(), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
