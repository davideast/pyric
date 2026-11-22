import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { resolvePlannedChildAppOrigin } from '../../src/cli/child-app-origin.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { formatNoTabMessage, resolveConnectedAppOrigin } from '../../src/remote/app-origin.js';
import { connectRemoteSandbox } from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';

const tempDirs: string[] = [];
const activeRuntimes: ServeRuntime[] = [];

afterEach(async () => {
  while (activeRuntimes.length > 0) {
    const runtime = activeRuntimes.pop();
    if (runtime !== undefined) {
      await runtime.handle.stop();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-app-origin-'));
  tempDirs.push(dir);
  return dir;
}

describe('resolveConnectedAppOrigin and formatNoTabMessage (#1200)', () => {
  it('names the app origin first and contrasts it with the sandbox host when they differ', () => {
    const message = formatNoTabMessage('http://localhost:3473', 'http://localhost:3000/', {});

    expect(message).toBe(
      "no browser tab is connected to the sandbox - keep your app open at http://localhost:3000 in a browser and retry (your app's SharedWorker and IndexedDB data live on http://localhost:3000, not the sandbox host http://localhost:3473).",
    );
  });

  it('infers the Next.js dev server origin from __NEXT_PRIVATE_ORIGIN', () => {
    const env: NodeJS.ProcessEnv = {
      __NEXT_PRIVATE_ORIGIN: 'http://localhost:3000',
    };
    expect(resolveConnectedAppOrigin('http://localhost:3473', undefined, env)).toBe(
      'http://localhost:3000',
    );
    const message = formatNoTabMessage('http://localhost:3473', undefined, env);
    expect(message).toContain('keep your app open at http://localhost:3000 in a browser and retry');
    expect(message).toContain('not the sandbox host http://localhost:3473');
  });

  it('uses PYRIC_SANDBOX_APP_ORIGIN injected by pyric sandbox -- <cmd>', () => {
    const env: NodeJS.ProcessEnv = {
      PYRIC_SANDBOX_APP_ORIGIN: 'http://localhost:4321',
    };
    const message = formatNoTabMessage('http://localhost:5000', undefined, env);
    expect(message).toContain('keep your app open at http://localhost:4321 in a browser and retry');
    expect(message).toContain('not the sandbox host http://localhost:5000');
  });

  it('keeps the single-origin message when the app origin matches serveUrl or is absent', () => {
    const sameOrigin = formatNoTabMessage('http://localhost:5173', 'http://localhost:5173', {});
    expect(sameOrigin).toContain('open http://localhost:5173 in a browser and retry');
    expect(sameOrigin).not.toContain('not the sandbox host');

    const noAppOrigin = formatNoTabMessage('http://localhost:5000', undefined, {});
    expect(noAppOrigin).toContain('open http://localhost:5000 in a browser and retry');
    expect(noAppOrigin).not.toContain('not the sandbox host');
  });
});

describe('resolvePlannedChildAppOrigin (#1200)', () => {
  it('resolves direct framework dev server commands and custom ports', () => {
    const cwd = makeTempProject();
    expect(resolvePlannedChildAppOrigin(['next', 'dev'], cwd, {})).toBe('http://localhost:3000');
    expect(resolvePlannedChildAppOrigin(['next', 'dev', '-p', '3005'], cwd, {})).toBe(
      'http://localhost:3005',
    );
    expect(resolvePlannedChildAppOrigin(['vite', '--port=5179'], cwd, {})).toBe(
      'http://localhost:5179',
    );
    expect(resolvePlannedChildAppOrigin(['astro', 'dev'], cwd, {})).toBe('http://localhost:4321');
    expect(resolvePlannedChildAppOrigin(['node', 'seed.mjs'], cwd, {})).toBeUndefined();
  });

  it('unwraps package-manager run scripts to detect the child dev server origin', () => {
    const cwd = makeTempProject();
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        scripts: {
          dev: 'next dev --turbopack -p 3100',
        },
      }),
    );
    expect(resolvePlannedChildAppOrigin(['npm', 'run', 'dev'], cwd, {})).toBe(
      'http://localhost:3100',
    );
  });
});

describe('connectRemoteSandbox no-tab error (#1200)', () => {
  it('throws unavailable error naming the Next.js origin instead of the sandbox port', async () => {
    const cwd = makeTempProject();
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
    mkdirSync(join(cwd, 'public'), { recursive: true });
    writeFileSync(join(cwd, 'public', 'index.html'), '<!doctype html><html><body></body></html>');

    const runtime = await startServe({
      cwd,
      port: 0,
      cacheRoot: join(cwd, '.cache'),
      bridge: {},
      logger: silentServeLogger(),
    });
    activeRuntimes.push(runtime);
    const serveUrl = runtime.handle.url;

    const previousNextOrigin = process.env.__NEXT_PRIVATE_ORIGIN;
    process.env.__NEXT_PRIVATE_ORIGIN = 'http://localhost:3000';
    try {
      let caught: unknown;
      try {
        const handle = await connectRemoteSandbox({ url: serveUrl });
        handle.close();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { code?: string }).code).toBe('unavailable');
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).toContain('keep your app open at http://localhost:3000 in a browser and retry');
      expect(message).toContain(`not the sandbox host ${serveUrl}`);
      expect(message).not.toContain(`open ${serveUrl} in a browser`);
    } finally {
      if (previousNextOrigin === undefined) {
        delete process.env.__NEXT_PRIVATE_ORIGIN;
      } else {
        process.env.__NEXT_PRIVATE_ORIGIN = previousNextOrigin;
      }
    }
  });
});
