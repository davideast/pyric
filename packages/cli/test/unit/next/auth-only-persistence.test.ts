/**
 * Next.js auth-only client page persistence across reloads (#2046).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { build } from 'esbuild';
import { startServe } from '../../../src/cli/serve.js';
import { getClientAliases } from '../../../src/next/client-aliases.js';
import { silentServeLogger } from '../../../src/serve/server.js';

const cliDir = fileURLToPath(new URL('../../../', import.meta.url));

describe('Next.js auth-only client alias persistence (#2046)', () => {
  it('declares auth-entry sideEffects and keeps top-level await out of the static Service Worker graph', async () => {
    const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')) as {
      sideEffects?: string[];
      exports?: Record<string, { import?: string }>;
    };
    expect(pkg.exports?.['./next/internal/auth']?.import).toBe('./dist/next/auth-entry.js');
    expect(pkg.sideEffects).toContain('./dist/next/auth-entry.js');
    expect(pkg.sideEffects).toContain('./dist/next/auth-page-backend.js');

    // Static graph with externalized dynamic runtime import must compile to CJS
    // (proving zero top-level await in the synchronous evaluation graph, #697).
    const authAliasTarget = getClientAliases('sandbox')['firebase/auth'];
    expect(authAliasTarget).toBe('@pyric/cli/next/internal/auth');
    const cjsCheck = await build({
      stdin: {
        contents: `export * from '${authAliasTarget}';`,
        resolveDir: cliDir,
      },
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'browser',
      external: ['*/runtime.js'],
      logLevel: 'silent',
    });
    expect(cjsCheck.outputFiles.length).toBe(1);
  });

  it('saves accounts and restores the signed-in user across reload on an auth-only Next.js client page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-next-auth-2046-'));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><body></body></html>');

    const srv = await startServe({
      cwd: dir,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: join(dir, '.cache'),
      persist: true,
      permissive: true,
      logger: silentServeLogger(),
    });
    const fixture = new URL('./fixtures/next-auth-only-reload.ts', import.meta.url).pathname;
    const child = Bun.spawn(
      [
        process.env.PYRIC_TEST_NODE ?? 'node',
        '--experimental-strip-types',
        '--experimental-vm-modules',
        fixture,
        srv.handle.url,
        srv.sessionToken,
        JSON.stringify(srv.workerInit),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const deadline = setTimeout(() => child.kill(), 50_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
    } finally {
      clearTimeout(deadline);
      child.kill();
      await srv.handle.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
