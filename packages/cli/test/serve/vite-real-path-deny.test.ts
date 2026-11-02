/**
 * Vite's dev server follows a symlink inside its root, and `server.fs.deny`
 * matches the requested path, not the real one. The plugin's real-path guard
 * refuses a request whose file resolves into `.pyric/` or a `.env` file.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { viteRealPathDeny } from '../../src/serve/vite-real-path-deny.js';

const servers: ViteDevServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'pyric-vite-real-path-'));
  mkdirSync(join(root, '.pyric', 'state', 'hosted'), { recursive: true });
  writeFileSync(join(root, '.pyric', 'state', 'hosted', 'state.sqlite'), 'users and data');
  writeFileSync(join(root, '.env'), 'API_KEY=secret');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'main.js'), 'export const ok = 1;');
  writeFileSync(join(root, 'index.html'), '<!doctype html><script type="module" src="/src/main.js"></script>');
  symlinkSync(join(root, '.pyric', 'state'), join(root, 'state-link'));
  symlinkSync(join(root, '.env'), join(root, 'env-link'));
  symlinkSync(join(root, '.env'), join(root, 'src', 'config.js'));
  writeFileSync(join(root, '.envrc'), 'export API_KEY=rc');
  symlinkSync(join(root, '.envrc'), join(root, 'rc-link'));
  return root;
}

async function serve(root: string, plugins: Plugin[]): Promise<string> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins,
  });
  servers.push(server);
  await server.listen();
  const address = server.httpServer!.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function guardPlugin(root: string): Plugin {
  return {
    name: 'test:real-path-deny',
    configureServer(server) {
      server.middlewares.use(viteRealPathDeny(() => [server.config.root, root]));
    },
  };
}

const deniedUrls = [
  '/state-link/hosted/state.sqlite',
  '/state-link/hosted/state.sqlite?raw',
  '/state-link/hosted/state.sqlite?import',
  '/env-link',
  '/env-link?raw',
  '/src/config.js',
  '/rc-link',
  '/.pyric/state/hosted/state.sqlite',
  '/%2epyric/state/hosted/state.sqlite',
];

describe('Vite real-path guard', () => {
  it('Vite alone serves a symlink into .pyric (the premise)', async () => {
    const root = project();
    const base = await serve(root, []);
    const res = await fetch(`${base}/state-link/hosted/state.sqlite`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('users and data');
  });

  for (const path of deniedUrls) {
    it(`refuses ${path}`, async () => {
      const root = project();
      const base = await serve(root, [guardPlugin(root)]);
      const res = await fetch(`${base}${path}`);
      const body = await res.text();
      expect(res.status).toBe(403);
      expect(body).not.toContain('users and data');
      expect(body).not.toContain('API_KEY');
    });
  }

  it('refuses an /@fs/ request whose real path is project state', async () => {
    const root = project();
    const base = await serve(root, [guardPlugin(root)]);
    const res = await fetch(`${base}/@fs${join(root, 'state-link', 'hosted', 'state.sqlite')}`);
    expect(res.status).toBe(403);
  });

  it('refuses a link to another project\'s state, outside every root', async () => {
    const root = project();
    const other = project();
    symlinkSync(join(other, '.pyric', 'state'), join(root, 'other-link'));
    const base = await serve(root, [guardPlugin(root)]);
    const res = await fetch(`${base}/other-link/hosted/state.sqlite`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('users and data');
  });

  it('serves a project whose own path passes through a denied name', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pyric-vite-real-path-parent-'));
    const root = join(parent, '.pyric', 'app');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'main.js'), 'export const ok = 1;');
    const base = await serve(root, [guardPlugin(root)]);
    expect((await fetch(`${base}/main.js`)).status).toBe(200);
  });

  it('still serves ordinary files', async () => {
    const root = project();
    const base = await serve(root, [guardPlugin(root)]);
    expect((await fetch(`${base}/src/main.js`)).status).toBe(200);
    expect((await fetch(`${base}/`)).status).toBe(200);
  });
});
