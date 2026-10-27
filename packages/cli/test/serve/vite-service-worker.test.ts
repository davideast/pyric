/**
 * The Vite plugin's `serviceWorker` option: in dev, the app's own service
 * worker module gets a fetch listener that answers production Storage URLs
 * from the sandbox, ahead of the app's listeners. Nothing else changes.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { pyricPackageRoot } from '../../src/serve/bundler.js';
import { createViteModuleContext, createViteModuleSwap } from '../../src/serve/vite-module-swap.js';
import { createServiceWorkerWiring } from '../../src/serve/vite-service-worker.js';

const ROOT = '/app/web';
const SOURCE = "self.addEventListener('fetch', () => {});\n";

describe('createServiceWorkerWiring', () => {
  it('prepends a sandboxStorageFetch listener to the named module in dev', () => {
    const wiring = createServiceWorkerWiring('src/sw.ts');
    const wired = wiring.transform(SOURCE, '/app/web/src/sw.ts?v=1', { root: ROOT, devServer: true });
    expect(wired).toStartWith('import { sandboxStorageFetch as __pyricSandboxStorageFetch } from ');
    expect(wired).toContain('if (__pyricSandboxStorageFetch(event)) event.stopImmediatePropagation();');
    expect(wired).toEndWith(SOURCE);
  });

  it('imports the helper by an absolute path from Pyric own install', () => {
    const wiring = createServiceWorkerWiring('src/sw.ts');
    const wired = wiring.transform(SOURCE, '/app/web/src/sw.ts', { root: ROOT, devServer: true }) ?? '';
    const specifier = /from (".*?");/.exec(wired)?.[1];
    const path = JSON.parse(specifier ?? '""') as string;
    expect(path).toMatch(/\/storage\/sw\.(js|ts)$/);
    expect(existsSync(path)).toBe(true);
  });

  it("imports the helper from a directory the plugin adds to Vite's fs allow list", () => {
    const wired = createServiceWorkerWiring('src/sw.ts').transform(SOURCE, '/app/web/src/sw.ts', { root: ROOT, devServer: true }) ?? '';
    const helper = JSON.parse(/from (".*?");/.exec(wired)?.[1] ?? '""') as string;
    const resolved = { server: { fs: { allow: [ROOT] } } };
    createViteModuleSwap(createViteModuleContext()).configResolved(resolved as never);
    expect(resolved.server.fs.allow).toContain(ROOT);
    expect(resolved.server.fs.allow.some((dir) => helper.startsWith(dir + sep))).toBe(true);
    expect(helper.startsWith(pyricPackageRoot() + sep)).toBe(true);
  });

  it('accepts an absolute service worker path', () => {
    const wiring = createServiceWorkerWiring('/app/web/src/sw.ts');
    expect(wiring.transform(SOURCE, '/app/web/src/sw.ts', { root: '/elsewhere', devServer: true })).not.toBeNull();
  });

  it('leaves other modules, builds, and an unset option untouched', () => {
    const wiring = createServiceWorkerWiring('src/sw.ts');
    expect(wiring.transform(SOURCE, '/app/web/src/main.ts', { root: ROOT, devServer: true })).toBeNull();
    expect(wiring.transform(SOURCE, '/app/web/src/sw.ts', { root: ROOT, devServer: false })).toBeNull();
    expect(createServiceWorkerWiring(undefined).transform(SOURCE, '/app/web/src/sw.ts', { root: ROOT, devServer: true })).toBeNull();
  });
});
