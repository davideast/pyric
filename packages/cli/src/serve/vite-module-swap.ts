import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DepOptimizationOptions, ResolvedConfig, UserConfig } from 'vite';
import { version as viteVersion } from 'vite';
import {
  SDK_MODULES,
  defaultSdkEntries,
  pyricPackageRoot,
  NODE_BUILTIN_RE,
  NODE_BUILTIN_SHIMS,
} from './bundler.js';
import {
  isBypassedBridgeImport,
  swappedFirebaseEntries,
  type AiMode,
  type ServedFirebaseSpecifier,
} from './firebase-module-swap.js';
import { loadRoutedModule, routeServerImport, ssrSwapAlias, unaliasedSpecifier } from './vite-ssr-routing.js';
import { loadServerTarget } from './vite-ssr-loader.js';

const FIREBASE_SPECIFIER = /^firebase\/([a-z-]+(?:\/[a-z-]+)*)$/;
const NODE_SHIM_PREFIX = '\0pyric:node-shim:';
type OptimizerOptions = NonNullable<DepOptimizationOptions['esbuildOptions']>;
type OptimizerPlugin = NonNullable<OptimizerOptions['plugins']>[number];

function packageRootOf(file: string): string {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir) && !existsSync(path.join(dir, 'package.json'))) {
    dir = path.dirname(dir);
  }
  return dir;
}

export interface ViteModuleContext {
  entries: ReturnType<typeof defaultSdkEntries>;
  cliRoot: string;
}

/** The part of a Vite environment the server branch reads (Vite 6 and later). */
export interface SwapEnvironment {
  readonly name: string;
  readonly config: { readonly consumer: string };
}

/** The part of Vite's plugin context the resolve hook uses. */
export interface SwapResolveContext {
  resolve(
    source: string,
    importer?: string,
    options?: { skipSelf?: boolean; ssr?: boolean },
  ): Promise<{ id: string } | null>;
  /** Present from Vite 6. On Vite 5 the `ssr` resolve option tells the server apart. */
  readonly environment?: SwapEnvironment;
}

export interface SwapConfigOptions {
  /** `vite dev`: route server-rendered imports too (`vite-ssr-routing.ts`). */
  devServer?: boolean;
}

export interface ViteModuleSwap {
  config(options?: SwapConfigOptions): UserConfig;
  /** Vite 6+: keeps the SSR loader external in every server environment. */
  configEnvironment(name: string, config: { consumer?: string }): { resolve: { external: string[] } } | null;
  configResolved(config: ResolvedConfig): void;
  resolveId(source: string, importer: string | undefined): string | null;
  /** The plugin's resolve hook: the client swap, and the server routing behind the SSR alias. */
  resolvePluginId(
    context: SwapResolveContext,
    source: string,
    importer: string | undefined,
    options?: { ssr?: boolean },
  ): Promise<string | { id: string } | null>;
  load(id: string): string | null;
  /** The plugin's load hook: the node shims, and the routed SSR modules. */
  loadPluginModule(id: string): Promise<string | null>;
}

/** A server environment's own config, for `configEnvironment`. Unset consumers default as Vite defaults them. */
function isServerEnvironment(name: string, consumer: string | undefined): boolean {
  const resolvedConsumer = consumer ?? (name === 'client' ? 'client' : 'server');
  return resolvedConsumer === 'server';
}

/** Whether Vite runs this environment's modules in this process. A runnable environment has a runner. */
function runsInProcess(environment: SwapEnvironment | undefined): boolean {
  const isViteFive = environment === undefined;
  return isViteFive || 'runner' in environment;
}

/** The package the SSR shims import; external so every runner shares the one Node module. */
const SSR_EXTERNAL = ['@pyric/cli'];

export function createViteModuleContext(): ViteModuleContext {
  const entries = defaultSdkEntries();
  return { entries, cliRoot: packageRootOf(entries.init) };
}

export interface ViteModuleSwapOptions {
  /** The resolved AI mode. Read on each resolution, since Vite resolves the
   *  mode from its env files after the plugin is constructed. */
  getAiMode?: () => AiMode;
}

/** Own the Vite and optimizer forms of the Firebase-module swap. */
export function createViteModuleSwap(
  context: ViteModuleContext,
  options?: ViteModuleSwapOptions,
): ViteModuleSwap {
  const { entries, cliRoot } = context;
  const pyricRoot = pyricPackageRoot();
  const isPyricImporter = (importer: string | undefined): boolean => {
    const hasNoImporter = !importer;
    if (hasNoImporter) return false;
    const file = importer.split('?')[0];
    return file === pyricRoot || file.startsWith(pyricRoot + path.sep);
  };
  const isOurCode = (importer: string | undefined): boolean => {
    const hasNoImporter = !importer;
    if (hasNoImporter) return false;
    const isOwnedByPyric = isPyricImporter(importer);
    if (isOwnedByPyric) return true;
    const file = importer.split('?')[0];
    return file === cliRoot || file.startsWith(cliRoot + path.sep);
  };
  const shimFor = (specifier: string): string =>
    NODE_BUILTIN_SHIMS[specifier.replace(/^node:/, '')];

  const aiMode = (): AiMode => options?.getAiMode?.() ?? 'sandbox';
  /** Set by `config()`: whether this server routes server-rendered imports. */
  let routesServerImports = false;

  function resolveId(source: string, importer: string | undefined): string | null {
    if (isBypassedBridgeImport(source, importer)) return null;

    const isFirebaseSpecifier = FIREBASE_SPECIFIER.test(source);
    if (isFirebaseSpecifier) {
      const swapped = swappedFirebaseEntries(aiMode());
      const key = swapped.get(source as ServedFirebaseSpecifier);
      return key === undefined ? null : entries[key] ?? null;
    }

    const nodeMatch = NODE_BUILTIN_RE.exec(source);
    const isNodeBuiltin = nodeMatch !== null && nodeMatch[2] !== undefined;
    const isOwnedImporter = isOurCode(importer);
    const shouldShimNodeBuiltin = isNodeBuiltin && isOwnedImporter;
    return shouldShimNodeBuiltin ? NODE_SHIM_PREFIX + nodeMatch[2] : null;
  }

  async function resolvePluginId(
    context: SwapResolveContext,
    source: string,
    importer: string | undefined,
    resolveOptions?: { ssr?: boolean },
  ): Promise<string | { id: string } | null> {
    const original = unaliasedSpecifier(source);
    const isUnaliased = original === null;
    if (isUnaliased) return resolveId(source, importer);
    const environment = context.environment;
    const isServer = environment === undefined
      ? resolveOptions?.ssr === true
      : environment.config.consumer === 'server';
    const routed = isServer
      ? routeServerImport({
        specifier: original,
        importer,
        aiMode: aiMode(),
        runsInProcess: runsInProcess(environment),
        environmentName: environment?.name ?? 'ssr',
      })
      : resolveId(original, importer);
    const isRouted = routed !== null;
    if (isRouted) return routed;
    // Not swapped here (the real firebase/ai in production AI mode, a shadow
    // app's own firebase/app, firebase-admin in browser code): resolve it as
    // Vite would have. The alias is in the skip set this call inherits.
    return context.resolve(original, importer, { ...resolveOptions, skipSelf: true });
  }

  function loadPluginModule(id: string): Promise<string | null> {
    const shim = load(id);
    const isShim = shim !== null;
    if (isShim) return Promise.resolve(shim);
    return loadRoutedModule(id, loadServerTarget);
  }

  function load(id: string): string | null {
    const isForeignId = !id.startsWith(NODE_SHIM_PREFIX);
    if (isForeignId) return null;
    return shimFor(id.slice(NODE_SHIM_PREFIX.length));
  }

  // Keep Firebase specifiers external so Vite resolves them through the same
  // hook as direct application imports, including the same module URL.
  const rolldownMirror = {
    name: 'pyric-sandbox-optimizer',
    resolveId(source: string, importer: string | undefined) {
      const id = resolveId(source, importer);
      const isUnchanged = id === null;
      if (isUnchanged) return null;
      const isNodeShim = id.startsWith(NODE_SHIM_PREFIX);
      return isNodeShim ? id : { id: source, external: true };
    },
    load,
  };

  const optimizerMirror: OptimizerPlugin = {
    name: 'pyric-sandbox-optimizer',
    setup(build) {
      build.onResolve({ filter: FIREBASE_SPECIFIER }, (args) => {
        const id = resolveId(args.path, args.importer);
        const isUnchanged = id === null;
        return isUnchanged ? null : { path: args.path, external: true };
      });
      build.onResolve({ filter: NODE_BUILTIN_RE }, (args) => {
        const isForeignImporter = !isOurCode(args.importer);
        if (isForeignImporter) {
          return null;
        }
        const shimPath = args.path.replace(/^node:/, '');
        return { path: shimPath, namespace: 'pyric-node-shim' };
      });
      build.onLoad({ filter: /.*/, namespace: 'pyric-node-shim' }, (args) => {
        const content = NODE_BUILTIN_SHIMS[args.path];
        const hasContent = content !== undefined;
        if (hasContent) {
          return { contents: content, loader: 'js' };
        }
        return null;
      });
    },
  };

  return {
    config(configOptions) {
      const excludedModules = [
        ...SDK_MODULES,
        // Never pre-bundled for the browser: the SSR alias names it, and an
        // excluded id stays external before the optimizer applies aliases.
        'firebase-admin',
        '@firebase/app',
        '@firebase/component',
        '@firebase/ai',
        '@firebase/app-check',
        '@firebase/util',
        '@firebase/logger',
      ];
      const usesRolldown = Number(viteVersion.split('.')[0]) >= 8;
      const optimizer = usesRolldown
        ? { rolldownOptions: { plugins: [rolldownMirror] } }
        : { esbuildOptions: { plugins: [optimizerMirror] } };
      routesServerImports = configOptions?.devServer === true;
      const ssrRouting: UserConfig = routesServerImports
        ? { resolve: { alias: [ssrSwapAlias()] }, ssr: { external: SSR_EXTERNAL } }
        : {};
      return {
        ...ssrRouting,
        optimizeDeps: {
          exclude: excludedModules,
          ...optimizer,
        },
      };
    },
    configEnvironment(name, environmentConfig) {
      // The `ssr` environment takes the top-level `ssr.external` above.
      const isOtherServerEnvironment = routesServerImports && name !== 'ssr' &&
        isServerEnvironment(name, environmentConfig.consumer);
      return isOtherServerEnvironment ? { resolve: { external: [...SSR_EXTERNAL] } } : null;
    },
    configResolved(config) {
      const allow = config.server?.fs?.allow;
      const hasNoAllowList = allow === undefined || !Array.isArray(allow);
      if (hasNoAllowList) {
        return;
      }
      for (const dir of [pyricRoot, cliRoot]) {
        const needsAllowance = !allow.includes(dir);
        if (needsAllowance) {
          allow.push(dir);
        }
      }
    },
    resolveId,
    resolvePluginId,
    load,
    loadPluginModule,
  };
}
