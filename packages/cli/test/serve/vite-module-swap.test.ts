import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installedFirebaseSdkNames } from '../../src/bundler/externals.js';
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
import { suppliedRows } from '../../src/serve/vite-supplied-rows.js';

const context = createViteModuleContext();
const swap = createViteModuleSwap(context);
const userImporter = '/some/app/src/main.ts';
const pyricImporter = path.join(pyricPackageRoot(), 'dist', 'firestore', 'index.js');

/** The id prefix of a module that throws the stop error. */
const STOP_PREFIX = '\0pyric-stop:';

/** The error a stop module throws when it is imported. */
async function thrownBy(source: string | null): Promise<Error & { code?: string }> {
  expect(source).not.toBeNull();
  try {
    await import(`data:text/javascript;base64,${Buffer.from(source as string).toString('base64')}`);
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error(`the module did not throw:\n${source}`);
}

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

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A project whose node_modules holds two @firebase/* packages, firebase-admin under an npm alias, and another package. */
function projectWithSdkNames(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pyric-dev-sdk-names-'));
  scratch.push(root);
  const manifests: Record<string, string> = {
    '@firebase/app': '@firebase/app',
    '@firebase/firestore': '@firebase/firestore',
    'admin-alias': 'firebase-admin',
    'not-firebase': 'not-firebase',
  };
  for (const [folder, name] of Object.entries(manifests)) {
    const dir = path.join(root, 'node_modules', folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  }
  return root;
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
    expect(config.ssr?.external).toEqual(['@pyric/cli', ...installedFirebaseSdkNames({ projectDir: process.cwd() })]);
    expect(swap.config({ devServer: false }).resolve).toBeUndefined();
  });

  it('keeps the SSR loader external in other server environments, only under vite dev', () => {
    const devSwap = createViteModuleSwap(context);
    devSwap.config({ devServer: true, userConfig: { ssr: { external: true } } });
    expect(devSwap.configEnvironment('worker', {})).toEqual({ resolve: { external: ['@pyric/cli'] } });
    expect(devSwap.configEnvironment('rsc', { consumer: 'server' })).toEqual({ resolve: { external: ['@pyric/cli'] } });
    expect(devSwap.configEnvironment('ssr', { consumer: 'server' })).toBeNull();
    expect(devSwap.configEnvironment('client', {})).toBeNull();
    const buildSwap = createViteModuleSwap(context);
    buildSwap.config({ devServer: false });
    expect(buildSwap.configEnvironment('worker', {})).toBeNull();
  });

  it('keeps every installed Firebase SDK name external on the server, so the stop hook decides it (#2345)', () => {
    const root = projectWithSdkNames();
    const devSwap = createViteModuleSwap(context);
    const config = devSwap.config({ devServer: true, userConfig: { root, ssr: { noExternal: true } } });
    const names = ['firebase', 'firebase-admin', '@firebase/app', '@firebase/firestore', 'admin-alias'];
    expect(config.ssr?.external).toEqual(expect.arrayContaining(['@pyric/cli', ...names]));
    expect(config.ssr?.external).not.toContain('not-firebase');
    const environment = devSwap.configEnvironment('rsc', { consumer: 'server' });
    expect(environment?.resolve.external).toEqual(config.ssr?.external as string[]);
  });

  it('leaves server externals as they were under live rows, ssr.external: true, and a build', () => {
    const root = projectWithSdkNames();
    const live = createViteModuleSwap(context, { supplied: suppliedRows((specifier) => new Error(specifier)) });
    expect(live.config({ devServer: true, userConfig: { root } }).ssr?.external).toEqual(['@pyric/cli']);
    const everything = createViteModuleSwap(context);
    expect(everything.config({ devServer: true, userConfig: { root, ssr: { external: true } } }).ssr?.external).toEqual(['@pyric/cli']);
    expect(createViteModuleSwap(context).config({ devServer: false, userConfig: { root } }).ssr).toBeUndefined();
  });

  it('gives the client its entries through the alias, and firebase-admin the stop', async () => {
    const fake = fakeContext(clientEnvironment);
    expect(await swap.resolvePluginId(fake, aliased('firebase/firestore'), userImporter)).toBe(context.entries.firestore);
    const admin = await swap.resolvePluginId(fake, aliased('firebase-admin/app'), userImporter);
    expect(admin).toStartWith(STOP_PREFIX);
    const source = await swap.loadPluginModule(admin as string);
    // Declared, so a browser links the page's named import and then gets the stop.
    expect(source).toContain('__pyricStopped as initializeApp');
    const error = await thrownBy(source);
    expect(error.code).toBe('PYRIC_REAL_SDK_STOPPED');
    expect(error.message).toContain('stopped loading the real firebase-admin');
    expect(fake.passedOn).toEqual([]);
    expect(await swap.resolvePluginId(fake, 'react', userImporter)).toBeNull();
  });

  it("passes a shadow app's own firebase/app to Vite on the server in production AI mode", async () => {
    const prodSwap = createViteModuleSwap(context, { getAiMode: () => 'production' });
    const fake = fakeContext(runnableSsr);
    const shadow = path.join(context.cliRoot, 'src', 'register', 'client', 'app-bridge.ts');
    expect(await prodSwap.resolvePluginId(fake, aliased('firebase/app'), shadow)).toEqual({ id: '/node_modules/firebase/app.js' });
    expect(fake.passedOn).toEqual(['firebase/app']);
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

describe('a real Firebase SDK load the swap does not serve stops (ADR 0022)', () => {
  it('gives an unserved firebase/* subpath a module that throws the stop error', async () => {
    const id = swap.resolveId('firebase/installations', userImporter);
    expect(id).toStartWith(STOP_PREFIX);
    const source = await swap.loadPluginModule(id as string);
    expect(source).toContain('__pyricStopped as getInstallations');
    const error = await thrownBy(source);
    expect(error.code).toBe('PYRIC_REAL_SDK_STOPPED');
    expect(error.message).toContain('stopped loading the real firebase');
    expect(error.message).toContain("import 'firebase/installations'");
    expect(error.message).toContain(`from   ${userImporter}`);
    expect(error.message).toMatch(/found {2}file:\/\/\S*\/node_modules\/firebase\/installations\//);
  });

  it('stops an unserved subpath from a dependency too, with one module per import', () => {
    const dependency = '/app/node_modules/a-library/index.js';
    const id = swap.resolveId('firebase/installations', dependency);
    expect(id).toStartWith(STOP_PREFIX);
    expect(swap.resolveId('firebase/installations', dependency)).toBe(id);
    expect(swap.resolveId('firebase/installations', userImporter)).not.toBe(id);
    expect(swap.resolveId('firebase/compat/app', userImporter)).toStartWith(STOP_PREFIX);
  });

  it('leaves a subpath the firebase package does not have for Vite to report', () => {
    expect(swap.resolveId('firebase/not-served', userImporter)).toBeNull();
  });

  it('keeps an unserved subpath out of the pre-bundle, so the browser gets the stop', async () => {
    const plugins = swap.config().optimizeDeps?.esbuildOptions?.plugins ?? [];
    const resolvers: Array<(args: { path: string; importer: string }) => unknown> = [];
    const build = {
      onResolve: (options: { filter: RegExp }, run: (args: { path: string; importer: string }) => unknown) => {
        if (options.filter.test('firebase/installations')) resolvers.push(run);
      },
      onLoad: () => undefined,
    };
    for (const plugin of plugins) plugin.setup(build as never);
    const results = resolvers.map((run) => run({ path: 'firebase/installations', importer: '/app/node_modules/a-library/index.js' }));
    expect(results).toContainEqual({ path: 'firebase/installations', external: true });
  });

  it('lets production AI mode load the real firebase/ai, and still stops unserved subpaths', () => {
    const prodSwap = createViteModuleSwap(context, { getAiMode: () => 'production' });
    expect(prodSwap.resolveId('firebase/ai', userImporter)).toBeNull();
    expect(prodSwap.resolveId('firebase/installations', userImporter)).toStartWith(STOP_PREFIX);
  });

  it('swaps query-suffixed served firebase/* imports and stops query-suffixed unserved subpaths', () => {
    expect(swap.resolveId('firebase/firestore?raw', userImporter)).toBe(`${context.entries.firestore}?raw`);
    expect(swap.resolveId('firebase/firestore?url', userImporter)).toBe(`${context.entries.firestore}?url`);
    expect(swap.resolveId('firebase/firestore?worker', userImporter)).toBe(`${context.entries.firestore}?worker`);
    expect(swap.resolveId('firebase/installations?raw', userImporter)).toStartWith(STOP_PREFIX);

    const config = swap.config({ devServer: true });
    const alias = (config.resolve?.alias as Array<{ find: RegExp; replacement: string }>)[0]!;
    expect('firebase/firestore?raw'.replace(alias.find, alias.replacement)).toBe(aliased('firebase/firestore?raw'));
    expect('firebase-admin/app?url'.replace(alias.find, alias.replacement)).toBe(aliased('firebase-admin/app?url'));
  });

  it('stops bare firebase, @firebase/*, and direct /node_modules/firebase/*?raw client loads', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pyric-client-sdk-stop-'));
    scratch.push(root);
    mkdirSync(path.join(root, 'node_modules', 'firebase', 'firestore'), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules', 'firebase', 'package.json'),
      JSON.stringify({
        name: 'firebase',
        version: '12.0.0',
        type: 'module',
        exports: { '.': './index.js', './firestore': './firestore/index.js' },
      }),
    );
    writeFileSync(path.join(root, 'node_modules', 'firebase', 'index.js'), 'export const ROOT_MARKER = 1;\n');
    const realFirestoreIndex = path.join(root, 'node_modules', 'firebase', 'firestore', 'index.js');
    writeFileSync(realFirestoreIndex, 'export const REAL_MARKER = 1;\n');
    mkdirSync(path.join(root, 'node_modules', '@firebase', 'firestore'), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules', '@firebase', 'firestore', 'package.json'),
      JSON.stringify({ name: '@firebase/firestore', version: '4.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    writeFileSync(
      path.join(root, 'node_modules', '@firebase', 'firestore', 'index.js'),
      'export const SCOPED_MARKER = 1;\n',
    );
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'test-app', type: 'module' }));

    const localSwap = createViteModuleSwap(context);
    localSwap.configResolved({ root } as never);
    const appMain = path.join(root, 'src', 'main.js');

    const bareStop = localSwap.resolveId('firebase', appMain);
    expect(bareStop).toStartWith(STOP_PREFIX);
    const scopedStop = localSwap.resolveId('@firebase/firestore', appMain);
    expect(scopedStop).toStartWith(STOP_PREFIX);

    const scopedSource = await localSwap.loadPluginModule(scopedStop as string);
    expect(scopedSource).toContain('__pyricStopped as SCOPED_MARKER');
    expect((await thrownBy(scopedSource)).code).toBe('PYRIC_REAL_SDK_STOPPED');

    const diskContext: SwapResolveContext = {
      environment: clientEnvironment,
      resolve: async () => ({ id: `${realFirestoreIndex}?raw` }),
    };
    const pathStop = await localSwap.resolvePluginId(
      diskContext,
      '/node_modules/firebase/firestore/index.js?raw',
      undefined,
    );
    expect(pathStop).toStartWith(STOP_PREFIX);

    const subpathImportContext: SwapResolveContext = {
      environment: clientEnvironment,
      resolve: async (source) => {
        if (source === '#direct-firestore') {
          return { id: path.join(root, 'node_modules', '@firebase', 'firestore', 'index.js') };
        }
        return null;
      },
    };
    const subpathStop = await localSwap.resolvePluginId(subpathImportContext, '#direct-firestore', appMain);
    expect(subpathStop).toStartWith(STOP_PREFIX);

    for (const customPrefix of ['@sdk/firestore', '$lib/firestore', '~sdk/firestore']) {
      const customAliasContext: SwapResolveContext = {
        environment: clientEnvironment,
        resolve: async (source) => {
          if (source === customPrefix) {
            return { id: path.join(root, 'node_modules', '@firebase', 'firestore', 'index.js') };
          }
          return null;
        },
      };
      const customStop = await localSwap.resolvePluginId(customAliasContext, customPrefix, appMain);
      expect(customStop).toStartWith(STOP_PREFIX);
    }
  });

  it('routes non-production SSR builds to server targets rather than browser SharedWorker entries', async () => {
    const ssrBuildSwap = createViteModuleSwap(context);
    const ssrConfig = ssrBuildSwap.config({ devServer: false, ssrBuild: true } as never);
    const alias = (ssrConfig.resolve?.alias as Array<{ find: RegExp; replacement: string }>)?.[0];
    expect(alias).toBeDefined();
    expect(ssrConfig.ssr?.external).toContain('@pyric/cli');

    const buildSsrEnv = { name: 'ssr', mode: 'build', config: { consumer: 'server' } } as SwapEnvironment;
    const fake = fakeContext(buildSsrEnv);
    expect(await ssrBuildSwap.resolvePluginId(fake, aliased('firebase/app'), userImporter, { ssr: true }))
      .toBe('\0pyric-ssr-target:@pyric/cli/register/client/app');
    expect(await ssrBuildSwap.resolvePluginId(fake, 'firebase/app', userImporter, { ssr: true }))
      .toBe('\0pyric-ssr-target:@pyric/cli/register/client/app');
  });
});
