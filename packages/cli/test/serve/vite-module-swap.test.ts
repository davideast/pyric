import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { SDK_MODULES, pyricPackageRoot } from '../../src/serve/bundler.js';
import { REAL_SDK_ENTRIES } from '../../src/serve/firebase-module-swap.js';
import {
  createViteModuleContext,
  createViteModuleSwap,
  type SwapEnvironment,
  type SwapResolveContext,
} from '../../src/serve/vite-module-swap.js';
import { SSR_SWAP_PREFIX } from '../../src/serve/vite-ssr-routing.js';
import { sdkImportMap } from '../../src/serve/html-injection.js';

const context = createViteModuleContext();
const swap = createViteModuleSwap(context);
const userImporter = '/some/app/src/main.ts';
const pyricImporter = path.join(pyricPackageRoot(), 'dist', 'firestore', 'index.js');

describe('Vite module swap', () => {
  it('swaps every served Firebase entry for app and dependency importers', () => {
    for (const specifier of SDK_MODULES) {
      const key = specifier.slice('firebase/'.length).replaceAll('/', '-');
      expect(swap.resolveId(specifier, userImporter)).toBe(context.entries[key]);
      expect(swap.resolveId(specifier, '/app/node_modules/a-library/index.js')).toBe(
        context.entries[key],
      );
    }
  });

  it('leaves unrelated and unserved imports alone', () => {
    expect(swap.resolveId('react', userImporter)).toBeNull();
    expect(swap.resolveId('firebase/not-served', userImporter)).toBeNull();
    expect(swap.resolveId('pyric/firestore', userImporter)).toBeNull();
  });

  it('shims Node builtins only for Pyric-owned code', () => {
    expect(swap.resolveId('node:fs', pyricImporter)).toBe('\0pyric:node-shim:fs');
    expect(swap.resolveId('path', pyricImporter)).toBe('\0pyric:node-shim:path');
    expect(swap.resolveId('node:fs', userImporter)).toBeNull();
    expect(swap.resolveId('fs', '/app/node_modules/a-library/index.js')).toBeNull();
  });

  it('loads only its Node shim namespace', () => {
    expect(swap.load('\0pyric:node-shim:fs')).toContain('readFileSync');
    expect(swap.load('\0pyric:node-shim:path')).toContain('export const join');
    expect(swap.load('\0some/other/id')).toBeNull();
  });

  it('configures both optimizer exclusion and its esbuild mirror', () => {
    const config = swap.config();
    expect(config.optimizeDeps?.exclude).toEqual([
      ...SDK_MODULES,
      'firebase-admin',
      '@firebase/app',
      '@firebase/component',
      '@firebase/ai',
      '@firebase/app-check',
      '@firebase/util',
      '@firebase/logger',
      'pyric',
    ]);
    expect(config.optimizeDeps?.include).toBeUndefined();
    expect(config.optimizeDeps?.esbuildOptions?.plugins).toHaveLength(1);
    expect(config.resolve).toBeUndefined();
  });

  it('augments rather than replaces Vite filesystem allowances', () => {
    const resolved = { server: { fs: { allow: ['/the/app/root'] } } };
    swap.configResolved(resolved as never);
    expect(resolved.server.fs.allow).toContain('/the/app/root');
    expect(resolved.server.fs.allow).toContain(pyricPackageRoot());
    expect(
      resolved.server.fs.allow.some((dir) => context.entries.init.startsWith(dir + path.sep)),
    ).toBe(true);
  });

  it('leaves firebase/ai to the Firebase SDK and serves the passthrough app in production AI mode', () => {
    const prodSwap = createViteModuleSwap(context, { getAiMode: () => 'production' });
    expect(prodSwap.resolveId('firebase/ai', userImporter)).toBeNull();
    expect(prodSwap.resolveId('firebase/app', userImporter)).toBe(context.entries['app-ai-passthrough']);
    expect(prodSwap.resolveId('firebase/firestore', userImporter)).toBe(context.entries['firestore']);
    // The passthrough app's own firebase/app import reaches the Firebase SDK.
    expect(prodSwap.resolveId('firebase/app', context.entries['app-ai-passthrough'])).toBeNull();
    // The App Check bridge and its own firebase/app-check import.
    expect(prodSwap.resolveId('firebase/app-check', userImporter)).toBe(context.entries['app-ai-passthrough-app-check']);
    const bridge = path.join(path.dirname(context.entries['app-ai-passthrough']!), '..', '..', 'register', 'app-bridge-app-check.ts');
    expect(prodSwap.resolveId('firebase/app-check', bridge)).toBeNull();
  });

  it('swaps an app file that is merely named like a bridge', () => {
    for (const userFile of ['/home/me/app/src/register/app-bridge.js', '/home/me/app/src/serve/entries/app-ai-passthrough.js']) {
      expect(swap.resolveId('firebase/app-check', userFile)).toBe(context.entries['app-check']);
      expect(swap.resolveId('firebase/app', userFile)).toBe(context.entries['app']);
    }
  });
});

describe('import map and Vite resolver agree', () => {
  for (const mode of ['sandbox', 'production'] as const) {
    it(`serves the same entry for every Firebase module in ${mode} mode`, () => {
      const modeSwap = createViteModuleSwap(context, { getAiMode: () => mode });
      const importMap = sdkImportMap(mode);
      for (const specifier of SDK_MODULES) {
        const viteEntry = modeSwap.resolveId(specifier, userImporter);
        const mapped = importMap[specifier];
        if (mapped === undefined) {
          expect({ specifier, viteEntry }).toEqual({ specifier, viteEntry: null });
          continue;
        }
        const key = mapped.slice('/__pyric/sdk/'.length, -'.js'.length);
        // The import map's Firebase SDK build (production firebase/ai) is the
        // module Vite resolves itself, unswapped.
        const isProjectFirebase = [...REAL_SDK_ENTRIES.values()].includes(key);
        if (isProjectFirebase) {
          expect({ specifier, viteEntry }).toEqual({ specifier, viteEntry: null });
          continue;
        }
        expect({ specifier, viteEntry }).toEqual({ specifier, viteEntry: context.entries[key] });
      }
      expect(Object.keys(importMap).every((specifier) => (SDK_MODULES as readonly string[]).includes(specifier))).toBe(true);
    });
  }
});

/** A plugin context that records what falls through to Vite's own resolution. */
function fakeContext(environment?: SwapEnvironment): SwapResolveContext & { passedOn: string[] } {
  const passedOn: string[] = [];
  return {
    passedOn,
    environment,
    resolve: async (source) => {
      passedOn.push(source);
      return { id: `/node_modules/${source}.js` };
    },
  };
}

const runnableSsr = { name: 'ssr', config: { consumer: 'server' }, runner: {} } as SwapEnvironment;
const workerdSsr: SwapEnvironment = { name: 'worker', config: { consumer: 'server' } };
const clientEnvironment: SwapEnvironment = { name: 'client', config: { consumer: 'client' } };
const aliased = (specifier: string) => `${SSR_SWAP_PREFIX}${specifier}`;

describe('server-rendered imports under vite dev (#1123)', () => {
  it('aliases the served firebase/* specifiers and every firebase-admin subpath, in dev only', () => {
    const config = swap.config({ devServer: true });
    const alias = (config.resolve?.alias as Array<{ find: RegExp; replacement: string }>)[0]!;
    for (const specifier of [...SDK_MODULES, 'firebase-admin', 'firebase-admin/app', 'firebase-admin/database']) {
      expect(specifier.replace(alias.find, alias.replacement)).toBe(aliased(specifier));
    }
    for (const specifier of ['firebase/unknown-subpath', 'firebase-functions', 'firebase']) {
      expect(alias.find.test(specifier)).toBe(false);
    }
    expect(config.ssr?.external).toEqual(['@pyric/cli']);
    expect(swap.config({ devServer: false }).resolve).toBeUndefined();
  });

  it('keeps the SSR loader external in other server environments, only under vite dev', () => {
    const devSwap = createViteModuleSwap(context);
    devSwap.config({ devServer: true });
    expect(devSwap.configEnvironment('worker', {})).toEqual({ resolve: { external: ['@pyric/cli'] } });
    expect(devSwap.configEnvironment('rsc', { consumer: 'server' })).toEqual({ resolve: { external: ['@pyric/cli'] } });
    expect(devSwap.configEnvironment('ssr', { consumer: 'server' })).toBeNull();
    expect(devSwap.configEnvironment('client', {})).toBeNull();
    const buildSwap = createViteModuleSwap(context);
    buildSwap.config({ devServer: false });
    expect(buildSwap.configEnvironment('worker', {})).toBeNull();
  });

  it('gives the client its entries through the alias, and passes the rest to Vite', async () => {
    const fake = fakeContext(clientEnvironment);
    expect(await swap.resolvePluginId(fake, aliased('firebase/firestore'), userImporter)).toBe(context.entries.firestore);
    expect(await swap.resolvePluginId(fake, aliased('firebase-admin/app'), userImporter))
      .toEqual({ id: '/node_modules/firebase-admin/app.js' });
    expect(fake.passedOn).toEqual(['firebase-admin/app']);
    expect(await swap.resolvePluginId(fake, 'react', userImporter)).toBeNull();
  });

  it('routes a runnable server environment to what the register maps a remote Node process to', async () => {
    const fake = fakeContext(runnableSsr);
    const routed = async (specifier: string) => swap.resolvePluginId(fake, aliased(specifier), userImporter);
    expect(await routed('firebase/app')).toBe('\0pyric-ssr-target:@pyric/cli/register/client/app');
    for (const service of ['auth', 'database', 'firestore', 'storage']) {
      expect(await routed(`firebase/${service}`)).toBe(`\0pyric-ssr-target:@pyric/cli/register/client/${service}`);
    }
    expect(await routed('firebase/ai')).toBe('\0pyric-ssr-target:pyric/ai');
    expect(await routed('firebase/messaging/sw')).toBe('\0pyric-ssr-target:pyric/messaging/sw');
    expect(await routed('firebase/app-check')).toBe('\0pyric-ssr-target:pyric/app-check');
    for (const deferred of ['analytics', 'firestore/lite', 'functions', 'performance', 'remote-config']) {
      expect(await routed(`firebase/${deferred}`)).toBe(`\0pyric-ssr-target:pyric/${deferred}`);
      const shim = await swap.loadPluginModule(`\0pyric-ssr-target:pyric/${deferred}`);
      expect(shim).toContain(`loadServerTarget("pyric/${deferred}")`);
      expect(shim).toContain('PyricDeferredApiError');
    }
    expect(await routed('firebase-admin')).toBe('\0pyric-ssr-target:pyric-admin');
    expect(await routed('firebase-admin/firestore')).toBe('\0pyric-ssr-target:pyric-admin/firestore');
    expect(fake.passedOn).toEqual([]);
  });

  it('tells the server apart by the ssr option on Vite 5, which has no environments', async () => {
    const fake = fakeContext();
    expect(await swap.resolvePluginId(fake, aliased('firebase/database'), userImporter, { ssr: true }))
      .toBe('\0pyric-ssr-target:@pyric/cli/register/client/database');
    expect(await swap.resolvePluginId(fake, aliased('firebase/database'), userImporter)).toBe(context.entries.database);
  });

  it('leaves the real firebase/ai to Vite on the server in production AI mode', async () => {
    const prodSwap = createViteModuleSwap(context, { getAiMode: () => 'production' });
    const fake = fakeContext(runnableSsr);
    expect(await prodSwap.resolvePluginId(fake, aliased('firebase/ai'), userImporter))
      .toEqual({ id: '/node_modules/firebase/ai.js' });
    expect(await prodSwap.resolvePluginId(fake, aliased('firebase/app'), userImporter))
      .toBe('\0pyric-ssr-target:@pyric/cli/register/client/app-bridge');
  });

  it('gives a server environment Vite does not run in this process a module that throws', async () => {
    const id = await swap.resolvePluginId(fakeContext(workerdSsr), aliased('firebase/firestore'), userImporter);
    expect(id).toBe('\0pyric-ssr-outside:worker:firebase/firestore');
    const source = await swap.loadPluginModule(id as string);
    expect(source).toMatch(/^throw new Error\(/);
    expect(source).toContain('firebase/firestore in the Vite \\"worker\\" environment runs outside');
    expect(source).toContain('pyric({ hosted: true })');
  });

  it('loads a routed target through the SSR loader, re-exporting its names', async () => {
    const source = await swap.loadPluginModule('\0pyric-ssr-target:pyric-admin/app') as string;
    expect(source).toContain('import { loadServerTarget } from "@pyric/cli/vite/ssr-loader";');
    expect(source).toContain('const __pyricTarget = await loadServerTarget("pyric-admin/app");');
    expect(source).toMatch(/__pyric\d+ as initializeApp/);
    expect(await swap.loadPluginModule('/src/app.ts')).toBeNull();
  });
});
