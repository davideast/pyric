import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type ViteDevServer } from 'vite';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import {
  createViteModuleContext,
  createViteModuleSwap,
  type SwapConfigOptions,
  type SwapEnvironment,
  type SwapResolveContext,
} from '../../src/serve/vite-module-swap.js';
import { pyric } from '../../src/serve/vite-plugin.js';
import { viteProcessStopHook } from '../../src/serve/vite-process-stop.js';
import { attachViteSdkRequestGate } from '../../src/serve/vite-sdk-file-gate.js';
import { loadServerTarget } from '../../src/serve/vite-ssr-loader.js';
import { resolveNodeExecutable } from './require-node-on-path.js';
import { SSR_SWAP_PREFIX, ssrSwapAlias } from '../../src/serve/vite-ssr-routing.js';

const STOP_PREFIX = '\0pyric-stop:';
const clientEnvironment: SwapEnvironment = { name: 'client', config: { consumer: 'client' } };

const activeServers: ViteDevServer[] = [];
const activeTmpDirs: string[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const server = activeServers.pop();
    if (server !== undefined) {
      await server.close();
    }
  }
  while (activeTmpDirs.length > 0) {
    const dir = activeTmpDirs.pop();
    if (dir !== undefined) {
      removePrivateJobTmpDir(dir);
    }
  }
});

interface IsolatedFirebaseFixture {
  readonly workspaceDir: string;
  readonly appRoot: string;
  readonly firebasePkgRoot: string;
  readonly scopedAppPkgRoot: string;
  readonly scopedComponentPkgRoot: string;
  readonly realFirebaseAppFile: string;
  readonly realFirebaseAppCheckFile: string;
  readonly realFirebaseAiFile: string;
  readonly realScopedAppFile: string;
  readonly realScopedComponentFile: string;
}

/**
 * Builds an isolated monorepo-like workspace whose app root links to its own
 * `firebase` and `@firebase/*` packages inside an external virtual store
 * directory (outside `appRoot`) with an independent component container
 * registry. If Pyric's shadow bridge resolves `firebase/app` from `@pyric/cli`'s
 * own `node_modules` instead of `appRoot`, `getAI(app)` fails with
 * `Error: Service AI is not available` just like the real `@firebase/component`
 * runtime when two copies load on one page or Node process.
 */
function createIsolatedFirebaseAppFixture(): IsolatedFirebaseFixture {
  const scratchRoot = createPrivateJobTmpDir('vite-ai-dedupe');
  activeTmpDirs.push(scratchRoot);

  const workspaceDir = path.join(scratchRoot, 'workspace');
  const appRoot = path.join(workspaceDir, 'apps', 'web');
  const storeNodeModules = path.join(scratchRoot, 'external-pnpm-store', 'node_modules');
  mkdirSync(path.join(appRoot, 'src'), { recursive: true });
  mkdirSync(path.join(appRoot, 'node_modules', '@firebase'), { recursive: true });
  mkdirSync(path.join(storeNodeModules, '@firebase'), { recursive: true });

  const writeStorePkg = (
    relPkgDir: string,
    manifest: Record<string, unknown>,
    files: Record<string, string>,
  ): string => {
    const pkgDir = path.join(storeNodeModules, relPkgDir);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2));
    for (const [relFile, source] of Object.entries(files)) {
      const fullPath = path.join(pkgDir, relFile);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, source);
    }
    return realpathSync(pkgDir);
  };

  const componentStoreDir = writeStorePkg(
    path.join('@firebase', 'component'),
    { name: '@firebase/component', version: '0.7.0-app-local', type: 'module', exports: { '.': './dist/index.js' } },
    {
      'dist/index.js': [
        'export class Component { constructor(name, instanceFactory) { this.name = name; this.instanceFactory = instanceFactory; } }',
        'export class ComponentContainer {',
        '  constructor(name) { this.name = name; this.providers = new Map(); }',
        '  addComponent(component) { this.providers.set(component.name, component); }',
        '  getProvider(name) {',
        '    const comp = this.providers.get(name);',
        '    return { getImmediate: () => { if (!comp) throw new Error(`Service ${name} is not available`); return comp.instanceFactory(this); } };',
        '  }',
        '}',
      ].join('\n'),
    },
  );

  const appStoreDir = writeStorePkg(
    path.join('@firebase', 'app'),
    { name: '@firebase/app', version: '0.14.0-app-local', type: 'module', exports: { '.': './dist/index.js' } },
    {
      'dist/index.js': [
        "import { ComponentContainer } from '@firebase/component';",
        'const apps = new Map(); const registeredComponents = new Map();',
        'export const APP_INSTANCE_ORIGIN = "app-root-firebase";',
        'export function _registerComponent(component) {',
        '  registeredComponents.set(component.name, component);',
        '  for (const app of apps.values()) app.container.addComponent(component);',
        '}',
        'export function initializeApp(options = {}, nameOrSettings = "[DEFAULT]") {',
        '  const name = typeof nameOrSettings === "string" ? nameOrSettings : (nameOrSettings?.name || "[DEFAULT]");',
        '  const container = new ComponentContainer(name);',
        '  for (const comp of registeredComponents.values()) container.addComponent(comp);',
        '  const app = { name, options, container, origin: APP_INSTANCE_ORIGIN };',
        '  apps.set(name, app); return app;',
        '}',
        'export function getApp(name = "[DEFAULT]") { const found = apps.get(name); if (!found) throw new Error(`No Firebase App ${name}`); return found; }',
        'export function getApps() { return [...apps.values()]; }',
        'export async function deleteApp(app) { apps.delete(app.name); }',
      ].join('\n'),
    },
  );

  const appCheckStoreDir = writeStorePkg(
    path.join('@firebase', 'app-check'),
    { name: '@firebase/app-check', version: '0.11.0-app-local', type: 'module', exports: { '.': './dist/index.js' } },
    {
      'dist/index.js': [
        "import { Component } from '@firebase/component';",
        "import { _registerComponent } from '@firebase/app';",
        '_registerComponent(new Component("app-check-internal", () => ({ ready: true })));',
        'export class CustomProvider { constructor(opts) { this.opts = opts; } }',
        'export class ReCaptchaV3Provider { constructor(key) { this.key = key; } }',
        'export class ReCaptchaEnterpriseProvider { constructor(key) { this.key = key; } }',
        'export function initializeAppCheck(app, options) {',
        '  if (!app || !app.container) throw new Error("Missing shadow app container on initializeAppCheck");',
        '  return { app, options, internal: app.container.getProvider("app-check-internal").getImmediate(), origin: app.origin };',
        '}',
        'export async function getToken() { return { token: "local-test-token" }; }',
        'export async function getLimitedUseToken() { return { token: "local-limited-token" }; }',
        'export function onTokenChanged() { return () => {}; }',
        'export function setTokenAutoRefreshEnabled() {}',
      ].join('\n'),
    },
  );

  const aiStoreDir = writeStorePkg(
    path.join('@firebase', 'ai'),
    { name: '@firebase/ai', version: '2.0.0-app-local', type: 'module', exports: { '.': './dist/index.js' } },
    {
      'dist/index.js': [
        "import { Component } from '@firebase/component';",
        "import { _registerComponent } from '@firebase/app';",
        '_registerComponent(new Component("AI", (container) => ({ service: "AI", appName: container.name, origin: "app-root-ai" })));',
        'export function getAI(app) {',
        '  if (!app || !app.container) throw new Error("Service AI is not available: missing container");',
        '  return app.container.getProvider("AI").getImmediate();',
        '}',
      ].join('\n'),
    },
  );

  const firebaseStoreDir = writeStorePkg(
    'firebase',
    {
      name: 'firebase',
      version: '12.19.0-app-local',
      type: 'module',
      exports: {
        './app': './app/dist/index.esm.js',
        './app-check': './app-check/dist/index.esm.js',
        './ai': './ai/dist/index.esm.js',
      },
    },
    {
      'app/package.json': JSON.stringify({ name: 'firebase/app', type: 'module' }),
      'app/dist/index.esm.js': "export * from '@firebase/app';\n",
      'app-check/package.json': JSON.stringify({ name: 'firebase/app-check', type: 'module' }),
      'app-check/dist/index.esm.js': "export * from '@firebase/app-check';\n",
      'ai/package.json': JSON.stringify({ name: 'firebase/ai', type: 'module' }),
      'ai/dist/index.esm.js': "export * from '@firebase/ai';\n",
    },
  );

  symlinkSync(componentStoreDir, path.join(appRoot, 'node_modules', '@firebase', 'component'));
  symlinkSync(appStoreDir, path.join(appRoot, 'node_modules', '@firebase', 'app'));
  symlinkSync(appCheckStoreDir, path.join(appRoot, 'node_modules', '@firebase', 'app-check'));
  symlinkSync(aiStoreDir, path.join(appRoot, 'node_modules', '@firebase', 'ai'));
  symlinkSync(firebaseStoreDir, path.join(appRoot, 'node_modules', 'firebase'));

  writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({ name: 'monorepo-web-app', private: true, type: 'module' }, null, 2),
  );
  writeFileSync(
    path.join(appRoot, '.firebaserc'),
    JSON.stringify({ projects: { default: 'demo-project' } }),
  );
  writeFileSync(path.join(appRoot, 'index.html'), '<!doctype html><html><body>ok</body></html>\n');
  writeFileSync(
    path.join(appRoot, 'src', 'sw.js'),
    "import { initializeApp } from 'firebase/app';\nself.addEventListener('fetch', () => {});\nvoid initializeApp;\n",
  );
  writeFileSync(
    path.join(appRoot, 'src', 'main.js'),
    "import { initializeApp } from 'firebase/app';\nimport { getAI } from 'firebase/ai';\nexport { initializeApp, getAI };\n",
  );

  return {
    workspaceDir,
    appRoot,
    firebasePkgRoot: firebaseStoreDir,
    scopedAppPkgRoot: appStoreDir,
    scopedComponentPkgRoot: componentStoreDir,
    realFirebaseAppFile: path.join(firebaseStoreDir, 'app', 'dist', 'index.esm.js'),
    realFirebaseAppCheckFile: path.join(firebaseStoreDir, 'app-check', 'dist', 'index.esm.js'),
    realFirebaseAiFile: path.join(firebaseStoreDir, 'ai', 'dist', 'index.esm.js'),
    realScopedAppFile: path.join(appStoreDir, 'dist', 'index.js'),
    realScopedComponentFile: path.join(componentStoreDir, 'dist', 'index.js'),
  };
}

describe('Vite and Node PYRIC_AI_MODE=production cross-tree Firebase deduplication', () => {
  it('resolves bypassed bridge imports from app root before importer, populates allowedUrls, and preserves direct @firebase/* stops', async () => {
    const fixture = createIsolatedFirebaseAppFixture();
    const context = createViteModuleContext();
    const prodSwap = createViteModuleSwap(context, { getAiMode: () => 'production' });

    const configOpts: SwapConfigOptions = {
      devServer: true,
      userConfig: { root: fixture.appRoot },
    };
    const devConfig = prodSwap.config(configOpts);
    let dedupeList: string[] = [];
    if (devConfig.resolve !== undefined && devConfig.resolve.dedupe !== undefined) {
      dedupeList = devConfig.resolve.dedupe;
    }
    expect(dedupeList).toEqual(['firebase']);
    expect(prodSwap.config({ devServer: false, userConfig: { root: fixture.appRoot } }).resolve?.dedupe).toEqual(['firebase']);
    const fsAllow = [fixture.appRoot];
    prodSwap.configResolved({
      root: fixture.appRoot,
      server: { fs: { allow: fsAllow } },
    } as never);

    expect(fsAllow).toContain(fixture.firebasePkgRoot);
    expect(fsAllow).toContain(fixture.scopedAppPkgRoot);
    expect(fsAllow).toContain(fixture.scopedComponentPkgRoot);

    const aliasRule = ssrSwapAlias();
    const activeAliasImporters = new Set<string>();
    const resolveContext: SwapResolveContext = {
      environment: clientEnvironment,
      resolve: async (source, importer, resolveOptions) => {
        const aliasKey = `${source}\0${String(importer)}`;
        if (aliasRule.find.test(source) && !activeAliasImporters.has(aliasKey)) {
          activeAliasImporters.add(aliasKey);
          try {
            const aliased = source.replace(aliasRule.find, aliasRule.replacement);
            const routed = await prodSwap.resolvePluginId(resolveContext, aliased, importer, resolveOptions);
            if (typeof routed === 'string') return { id: routed };
            if (routed !== null) return routed;
            return null;
          } finally {
            activeAliasImporters.delete(aliasKey);
          }
        }
        const isDedupedFirebase = source.startsWith('firebase/') && dedupeList.includes('firebase');
        const fromAppRoot =
          isDedupedFirebase || (importer !== undefined && importer.startsWith(fixture.appRoot + path.sep));
        if (source === 'firebase/app') {
          if (fromAppRoot) return { id: fixture.realFirebaseAppFile };
          return { id: '/wrong-cli-tree/node_modules/firebase/app/dist/index.esm.js' };
        }
        if (source === 'firebase/app-check') {
          if (fromAppRoot) return { id: fixture.realFirebaseAppCheckFile };
          return { id: '/wrong-cli-tree/node_modules/firebase/app-check/dist/index.esm.js' };
        }
        if (source === '@firebase/app' && importer === fixture.realFirebaseAppFile) {
          return { id: fixture.realScopedAppFile };
        }
        if (source === '@firebase/component' && importer === fixture.realScopedAppFile) {
          return { id: fixture.realScopedComponentFile };
        }
        return null;
      },
    };

    const userMain = path.join(fixture.appRoot, 'src', 'main.js');
    const passthroughAppEntry = context.entries['app-ai-passthrough'];
    const appCheckBridgeEntry = path.join(context.cliRoot, 'src', 'register', 'app-bridge-app-check.ts');

    activeAliasImporters.add(`firebase/app\0${passthroughAppEntry}`);
    const aliasedApp = await prodSwap.resolvePluginId(resolveContext, `${SSR_SWAP_PREFIX}firebase/app`, passthroughAppEntry);
    activeAliasImporters.delete(`firebase/app\0${passthroughAppEntry}`);
    expect(aliasedApp).toEqual({ id: fixture.realFirebaseAppFile });

    const unaliasedCheck = await prodSwap.resolvePluginId(resolveContext, 'firebase/app-check', appCheckBridgeEntry);
    expect(unaliasedCheck).toBeNull();

    expect(prodSwap.allowedUrls.has(pathToFileURL(fixture.realFirebaseAppFile).href)).toBe(true);
    expect(prodSwap.allowedUrls.has(pathToFileURL(fixture.realFirebaseAppCheckFile).href)).toBe(true);

    expect(await prodSwap.resolvePluginId(resolveContext, '@firebase/app', fixture.realFirebaseAppFile)).toBeNull();
    expect(prodSwap.allowedUrls.has(pathToFileURL(fixture.realScopedAppFile).href)).toBe(true);

    expect(await prodSwap.resolvePluginId(resolveContext, '@firebase/app', userMain)).toStartWith(STOP_PREFIX);
    expect(await prodSwap.resolvePluginId(resolveContext, '@firebase/component', userMain)).toStartWith(STOP_PREFIX);

    let gateMiddleware:
      | ((req: IncomingMessage, res: ServerResponse, next: () => void) => void)
      | undefined;
    attachViteSdkRequestGate(
      {
        config: { root: fixture.appRoot, base: '/', publicDir: '' },
        middlewares: {
          use(fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) {
            gateMiddleware = fn;
          },
        },
      } as unknown as Parameters<typeof attachViteSdkRequestGate>[0],
      {
        allowedUrls: prodSwap.allowedUrls,
        aiMode: () => 'production',
      },
    );

    const checkHttp = (url: string) =>
      new Promise<boolean>((resolveAllowed) => {
        const mockRes = {
          statusCode: 0,
          setHeader: () => undefined,
          end: () => resolveAllowed(false),
        };
        if (gateMiddleware === undefined) {
          resolveAllowed(false);
          return;
        }
        gateMiddleware(
          { url, method: 'GET' } as IncomingMessage,
          mockRes as unknown as ServerResponse,
          () => resolveAllowed(true),
        );
      });

    expect(await checkHttp(`/@fs${fixture.realFirebaseAppFile}?v=123`)).toBe(true);
    expect(await checkHttp(`/@fs${fixture.realScopedAppFile}`)).toBe(true);
    expect(await checkHttp(`//@fs${fixture.realFirebaseAppFile}`)).toBe(false);
  });

  it('resolves app-root Firebase SDK in a real ViteDevServer, wires ServiceWorkers, and allows app-bridge-app-check in SSR', async () => {
    const fixture = createIsolatedFirebaseAppFixture();
    const server = await createServer({
      root: fixture.appRoot,
      configFile: false,
      envFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [
        pyric({
          ui: false,
          functions: false,
          project: 'demo-project',
          serviceWorker: 'src/sw.js',
          ai: { mode: 'production' },
        }),
      ],
    });
    activeServers.push(server);

    const mainFile = path.join(fixture.appRoot, 'src', 'main.js');
    const swappedApp = await server.pluginContainer.resolveId('firebase/app', mainFile);
    expect(swappedApp).not.toBeNull();
    let passthroughId = '';
    if (swappedApp !== null) {
      passthroughId = swappedApp.id;
    }
    expect(passthroughId).toContain('app-ai-passthrough');

    const shadowResolvedApp = await server.pluginContainer.resolveId('firebase/app', passthroughId);
    expect(shadowResolvedApp).not.toBeNull();
    let resolvedShadowPath = '';
    if (shadowResolvedApp !== null) {
      resolvedShadowPath = realpathSync(shadowResolvedApp.id.split('?')[0]);
    }
    expect(resolvedShadowPath).toBe(fixture.realFirebaseAppFile);

    const appAiResolved = await server.pluginContainer.resolveId('firebase/ai', mainFile);
    expect(appAiResolved).not.toBeNull();
    let resolvedAiPath = '';
    if (appAiResolved !== null) {
      resolvedAiPath = realpathSync(appAiResolved.id.split('?')[0]);
    }
    expect(resolvedAiPath).toBe(fixture.realFirebaseAiFile);

    const swTransformed = await server.transformRequest('/src/sw.js');
    let swCode = '';
    if (swTransformed !== null && swTransformed !== undefined) {
      swCode = swTransformed.code;
    }
    expect(swCode).toContain('__pyricSandboxStorageFetch');
    expect(swCode).toContain('app-ai-passthrough');

    const passthroughModule = await import('../../src/serve/entries/app-ai-passthrough.js');
    expect(typeof passthroughModule.initializeServerApp).toBe('function');

    const ssrAppCheckBridge = await loadServerTarget('@pyric/cli/register/app-bridge-app-check');
    expect(typeof ssrAppCheckBridge.initializeAppCheck).toBe('function');

    const context = createViteModuleContext();
    const shadowParentUrl = pathToFileURL(
      path.join(context.cliRoot, 'dist', 'register', 'app-bridge-shadow.js'),
    ).href;
    const stopHook = viteProcessStopHook({
      getAiMode: () => 'production',
      projectRoot: fixture.appRoot,
      write: () => undefined,
    });
    const usedParents: Array<string | undefined> = [];
    const hookResult = stopHook(
      'firebase/app',
      { parentURL: shadowParentUrl, conditions: ['node', 'import'] },
      (_spec, ctx) => {
        usedParents.push(ctx?.parentURL);
        return { url: pathToFileURL(fixture.realFirebaseAppFile).href };
      },
    );
    expect(hookResult.url).toBe(pathToFileURL(fixture.realFirebaseAppFile).href);
    expect(usedParents[0]).toBe(pathToFileURL(path.join(fixture.appRoot, 'package.json')).href);
  }, 60_000);

  it('deduplicates firebase/app, firebase/app-check, and firebase/ai under Node @pyric/cli/register and stamps hosted ServiceWorker entries', () => {
    const fixture = createIsolatedFirebaseAppFixture();
    const context = createViteModuleContext();
    const registerEntryUrl = pathToFileURL(
      path.join(context.cliRoot, 'dist', 'register', 'index.js'),
    ).href;
    const viteEntryUrl = pathToFileURL(path.join(context.cliRoot, 'dist', 'serve', 'vite-plugin.js')).href;
    const vitePkgUrl = import.meta.resolve('vite');

    const appScript = path.join(fixture.appRoot, 'verify-node-ai.mjs');
    writeFileSync(
      appScript,
      [
        "import { initializeApp, deleteApp } from 'firebase/app';",
        "import { CustomProvider, initializeAppCheck } from 'firebase/app-check';",
        "import { getAI } from 'firebase/ai';",
        "const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-project', appId: '1:1:web:1' }, 'dedupe-check');",
        'const ai = getAI(app);',
        "const appCheck = initializeAppCheck(app, { provider: new CustomProvider({ getToken: async () => ({ token: 'tok', expireTimeMillis: 1 }) }) });",
        "let directStopCode = 'not-stopped';",
        'try {',
        "  await import('@firebase/app');",
        '} catch (err) {',
        "  directStopCode = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'other-err';",
        '}',
        'await deleteApp(app);',
        'console.log(JSON.stringify({',
        '  aiService: ai.service,',
        '  aiOrigin: ai.origin,',
        '  appCheckOrigin: appCheck.origin,',
        '  directStopCode,',
        '}));',
        '',
      ].join('\n'),
    );

    const nodeBin = resolveNodeExecutable();

    const child = spawnSync(nodeBin, ['--import', registerEntryUrl, appScript], {
      cwd: fixture.workspaceDir,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        PYRIC_SANDBOX: 'in-process',
        PYRIC_AI_MODE: 'production',
        PYRIC_PROCESS_HEALTH: 'off',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(child.status, child.stderr).toBe(0);
    const lines = child.stdout.trim().split('\n');
    let lastLine = '{}';
    const candidate = lines.at(-1);
    if (candidate !== undefined) {
      lastLine = candidate;
    }
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    expect(parsed).toEqual({
      aiService: 'AI',
      aiOrigin: 'app-root-ai',
      appCheckOrigin: 'app-root-firebase',
      directStopCode: 'PYRIC_REAL_SDK_STOPPED',
    });

    const hostedProbe = path.join(fixture.appRoot, 'verify-hosted-sw.mjs');
    writeFileSync(
      hostedProbe,
      [
        'import { createServer as createNetServer } from "node:net";',
        `import { createServer } from ${JSON.stringify(vitePkgUrl)};`,
        `import { pyric } from ${JSON.stringify(viteEntryUrl)};`,
        'const freePort = await new Promise((res, rej) => { const s = createNetServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });',
        `const server = await createServer({`,
        `  root: ${JSON.stringify(fixture.appRoot)},`,
        '  configFile: false,',
        '  envFile: false,',
        '  logLevel: "silent",',
        '  server: { host: "127.0.0.1", port: freePort, strictPort: false, ws: false },',
        '  optimizeDeps: { noDiscovery: true, include: [] },',
        '  plugins: [pyric({ ui: false, hosted: true, functions: false, project: "demo-project", ai: { mode: "production" } })],',
        '});',
        'await server.listen();',
        `const resolved = await server.pluginContainer.resolveId('firebase/app', ${JSON.stringify(path.join(fixture.appRoot, 'src', 'sw.js'))});`,
        'const tx = await server.transformRequest(`/@fs${resolved.id}`);',
        'await server.close();',
        'console.log(JSON.stringify({ hasInstanceStamp: Boolean(tx && tx.code.includes("globalThis.__PYRIC_HOST_INSTANCE_ID__=")) }));',
        'process.exit(0);',
      ].join('\n'),
    );

    const hostedChild = spawnSync(nodeBin, [hostedProbe], {
      cwd: fixture.appRoot,
      env: { ...process.env, NODE_OPTIONS: '', PYRIC_SANDBOX: '' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(hostedChild.status, hostedChild.stderr).toBe(0);
    const hostedLines = hostedChild.stdout.trim().split('\n');
    let hostedLast = '{}';
    const hostedCandidate = hostedLines.at(-1);
    if (hostedCandidate !== undefined) {
      hostedLast = hostedCandidate;
    }
    expect(JSON.parse(hostedLast)).toEqual({ hasInstanceStamp: true });
  }, 60_000);
});
