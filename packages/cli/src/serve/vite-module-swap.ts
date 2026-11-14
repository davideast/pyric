import { existsSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
import {
  OBSERVER_MODULE_ID,
  OBSERVER_SPECIFIER,
  isLiveModuleId,
  isSuppliedRowsImport,
  passThroughSdkPackages,
  realFileUrlOf,
  suppliedRowsResolution,
  type SuppliedRows,
} from './vite-supplied-rows.js';
import {
  SSR_LOADER,
  STOP_PREFIX,
  isRoutedServerSpecifier,
  loadRoutedModule,
  routeServerImport,
  ssrSwapAlias,
  stopModule,
  stopModuleExports,
  unaliasedSpecifier,
} from './vite-ssr-routing.js';
import { loadServerTarget } from './vite-ssr-loader.js';
import { createViteSdkFileGate, type StopEntry } from './vite-sdk-file-gate.js';
import { LIVE_ROW_SDK_PACKAGES, isFirebaseSdkName, stopFor } from '../register/swap-or-stop.js';
import { packageNameOf } from '../register/package-identity.js';
import { installedFirebaseSdkNames } from '../bundler/externals.js';

const FIREBASE_SPECIFIER = /^firebase\/([a-z-]+(?:\/[a-z-]+)*)$/;
const SDK_PACKAGE_SPECIFIER = /^@firebase\//;
const DIRECT_SDK_STOP_SPECIFIER = /^(?:firebase|firebase-admin(?:\/.+)?|@firebase\/[^/]+(?:\/.+)?)$/;
const NODE_SHIM_PREFIX = '\0pyric:node-shim:';

function splitSpecifierQuery(source: string): { bare: string; query: string } {
  const queryIndex = source.indexOf('?');
  if (queryIndex === -1) return { bare: source, query: '' };
  return { bare: source.slice(0, queryIndex), query: source.slice(queryIndex) };
}

/** The SDK package the served entries import; one instance per page. */
const PYRIC_PACKAGE = 'pyric';

interface CommonJsResolver {
  _resolveFilename?: (request: string, parent: unknown, isMain: boolean) => string;
  _nodeModulePaths?: (from: string) => string[];
}
type ModuleConstructor = new (id: string) => { filename: string; paths: string[] };
const moduleApi = Module as unknown as CommonJsResolver & ModuleConstructor;
type OptimizerOptions = NonNullable<DepOptimizationOptions['esbuildOptions']>;
type OptimizerPlugin = NonNullable<OptimizerOptions['plugins']>[number];

function packageRootOf(file: string): string {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir) && !existsSync(path.join(dir, 'package.json'))) {
    dir = path.dirname(dir);
  }
  return dir;
}

/**
 * The file Node resolves `specifier` to from `base`, without running the
 * process's `module.registerHooks` resolve hooks.
 */
function resolveUnhooked(specifier: string, base: string): string {
  const resolveFilename = moduleApi._resolveFilename;
  const nodeModulePaths = moduleApi._nodeModulePaths;
  const hasInternals = typeof resolveFilename === 'function' && typeof nodeModulePaths === 'function';
  if (!hasInternals) return createRequire(base).resolve(specifier);
  const parent = new moduleApi(base);
  parent.filename = base;
  parent.paths = nodeModulePaths.call(Module, path.dirname(base));
  return resolveFilename.call(Module, specifier, parent, false);
}

export interface ViteModuleContext {
  entries: ReturnType<typeof defaultSdkEntries>;
  cliRoot: string;
}

/** The part of a Vite environment the server branch reads (Vite 6 and later). */
export interface SwapEnvironment {
  readonly name: string;
  readonly mode?: string;
  readonly config: {
    readonly consumer: string;
    readonly ssr?: { readonly target?: string };
  };
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
  /** `vite build --ssr --mode development`: route server-rendered imports during SSR sandbox builds. */
  ssrBuild?: boolean;
  /** The app's own Vite config: its `root` and `ssr.external`. */
  userConfig?: UserConfig;
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
  ): Promise<string | { id: string; external?: boolean } | null>;
  load(id: string): string | null;
  /** The plugin's load hook: the node shims, and the routed SSR modules. */
  loadPluginModule(id: string): Promise<string | null>;
  /** The served specifiers the page resolved to live rows, in first-import order; empty without supplied rows. */
  readonly observed: ReadonlySet<ServedFirebaseSpecifier>;
}

/** A server environment's own config, for `configEnvironment`. Unset consumers default as Vite defaults them. */
function isServerEnvironment(name: string, consumer: string | undefined): boolean {
  const resolvedConsumer = consumer ?? (name === 'client' ? 'client' : 'server');
  return resolvedConsumer === 'server';
}

/** Whether Vite runs this environment's modules in Node rather than an external worker runtime. */
function runsInProcess(environment: SwapEnvironment | undefined): boolean {
  if (environment === undefined) return true;
  if ('runner' in environment) return true;
  return environment.mode === 'build' && environment.config.ssr?.target !== 'webworker';
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
  /**
   * The live rows, served on this plane in place of the swap once the
   * installed `@pyric/live` opens them (`vite-supplied-rows.ts`). Absent for
   * every `pyric()` plugin.
   */
  supplied?: SuppliedRows;
}

/** Own the Vite and optimizer forms of the Firebase-module swap. */
export function createViteModuleSwap(
  context: ViteModuleContext,
  options?: ViteModuleSwapOptions,
): ViteModuleSwap {
  const { entries, cliRoot } = context;
  const pyricRoot = pyricPackageRoot();
  const isPyricImporter = (importer: string | undefined): boolean => {
    if (!importer) return false;
    const file = importer.split('?')[0];
    return file === pyricRoot || file.startsWith(pyricRoot + path.sep);
  };
  const isOurCode = (importer: string | undefined): boolean => {
    if (!importer) return false;
    if (isPyricImporter(importer)) return true;
    const file = importer.split('?')[0];
    return file === cliRoot || file.startsWith(cliRoot + path.sep);
  };
  const shimFor = (specifier: string): string =>
    NODE_BUILTIN_SHIMS[specifier.replace(/^node:/, '')];

  const aiMode = (): AiMode => options?.getAiMode?.() ?? 'sandbox';
  let routesServerImports = false;
  let serverExternal: string[] = SSR_EXTERNAL;
  let root = process.cwd();
  let cachedSdkAliasRoot: string | null = null;
  let cachedSdkAliases: string[] = [];
  const stops = new Map<string, StopEntry>();
  const stopIds = new Map<string, string>();
  const allowedUrls = new Set<string>();
  const observed = new Set<ServedFirebaseSpecifier>();

  function sdkAliasNames(): readonly string[] {
    if (cachedSdkAliasRoot === root) return cachedSdkAliases;
    cachedSdkAliasRoot = root;
    cachedSdkAliases = installedFirebaseSdkNames({ projectDir: root }).filter(
      (name) => name !== 'firebase' && name !== 'firebase-admin' && !name.startsWith('@firebase/'),
    );
    return cachedSdkAliases;
  }

  function isInstalledSdkAlias(bare: string): boolean {
    for (const aliasName of sdkAliasNames()) {
      if (bare === aliasName || bare.startsWith(`${aliasName}/`)) {
        return true;
      }
    }
    return false;
  }

  const { gateLiveSdkFile, gateSandboxSdkFile } = createViteSdkFileGate({
    stops,
    allowedUrls,
    aiMode,
    isInstalledSdkAlias,
  });

  function resolveBases(importer: string | undefined): string[] {
    const importerFile = importer?.split('?')[0];
    const fromRoot = path.join(root, 'package.json');
    const isFileImporter = importerFile !== undefined && path.isAbsolute(importerFile);
    return isFileImporter ? [importerFile, fromRoot] : [fromRoot];
  }

  function installedFileOf(specifier: string, importer: string | undefined): { url: string; base: string } | null {
    for (const base of resolveBases(importer)) {
      try {
        return { url: pathToFileURL(resolveUnhooked(specifier, base)).href, base };
      } catch {
        // Not installed where this base looks; try the next one.
      }
    }
    return null;
  }

  function stopIdFor(specifier: string, importer: string | undefined): string | null {
    const mode = aiMode();
    const key = [specifier, importer ?? '', mode].join('\0');
    const known = stopIds.get(key);
    if (known !== undefined) return known;
    const installed = installedFileOf(specifier, importer);
    if (installed === null) return null;
    const error = stopFor({ specifier, importer, url: installed.url, aiMode: mode }, allowedUrls);
    if (error === null) return null;
    const id = `${STOP_PREFIX}${stops.size}:${specifier}`;
    const importerDir = path.dirname(installed.base);
    const resolveDir = existsSync(importerDir) ? importerDir : root;
    stops.set(id, { error, specifier, resolveDir });
    stopIds.set(key, id);
    return id;
  }

  function refusalIdFor(specifier: string, plane: 'page' | 'server', error: Error): string {
    const id = `${STOP_PREFIX}refused:${plane}:${specifier}`;
    if (!stops.has(id)) stops.set(id, { error, specifier, resolveDir: root });
    return id;
  }

  function resolveSupplied(supplied: SuppliedRows, source: string, importer: string | undefined): string | null {
    const resolution = suppliedRowsResolution(supplied, source, importer);
    if (resolution.kind === 'module') {
      observed.add(source as ServedFirebaseSpecifier);
      return resolution.id;
    }
    if (resolution.kind === 'refused') return refusalIdFor(source, 'page', resolution.error);
    return null;
  }

  function isObserverImport(source: string, importer: string | undefined): boolean {
    const supplied = options?.supplied;
    const isOpen = supplied !== undefined && supplied.package() !== null;
    return isOpen && source === OBSERVER_SPECIFIER && importer !== undefined && isLiveModuleId(importer);
  }

  function loadLiveModule(supplied: SuppliedRows, id: string): string | null {
    const found = supplied.package();
    if (found === null) {
      throw new Error(`pyric: ${JSON.stringify(id)} is a live row module, and @pyric/live has not opened the rows.`);
    }
    return found.moduleSource(id);
  }

  function resolveId(source: string, importer: string | undefined): string | null {
    const { bare, query } = splitSpecifierQuery(source);
    if (isBypassedBridgeImport(bare, importer)) return null;
    if (isObserverImport(bare, importer)) return OBSERVER_MODULE_ID;

    const supplied = options?.supplied;
    const isSuppliedImport = supplied !== undefined && isSuppliedRowsImport(bare);
    if (isSuppliedImport) return resolveSupplied(supplied, bare, importer);
    if (FIREBASE_SPECIFIER.test(bare)) {
      const swapped = swappedFirebaseEntries(aiMode());
      const key = swapped.get(bare as ServedFirebaseSpecifier);
      if (key !== undefined) {
        const entry = entries[key];
        return entry !== undefined ? `${entry}${query}` : null;
      }
      return stopIdFor(bare, importer);
    }

    const isDirectSdkStop = DIRECT_SDK_STOP_SPECIFIER.test(bare) || isInstalledSdkAlias(bare);
    if (supplied === undefined && !isOurCode(importer) && isDirectSdkStop) {
      let importerUrl: string | undefined;
      if (importer !== undefined) {
        importerUrl = realFileUrlOf(importer) ?? importer;
      }
      const fromAllowedRealSdk = aiMode() === 'production' && importerUrl !== undefined && allowedUrls.has(importerUrl);
      if (!fromAllowedRealSdk) {
        const stopId = stopIdFor(bare, importerUrl);
        if (stopId !== null) return stopId;
      }
    }

    const nodeMatch = NODE_BUILTIN_RE.exec(bare);
    const isNodeBuiltin = nodeMatch !== null && nodeMatch[2] !== undefined;
    if (isNodeBuiltin && isOurCode(importer)) {
      return NODE_SHIM_PREFIX + nodeMatch[2];
    }
    return null;
  }

  function isServerResolve(context: SwapResolveContext, resolveOptions?: { ssr?: boolean }): boolean {
    const environment = context.environment;
    return environment === undefined ? resolveOptions?.ssr === true : environment.config.consumer === 'server';
  }

  async function resolvePluginId(
    context: SwapResolveContext,
    source: string,
    importer: string | undefined,
    resolveOptions?: { ssr?: boolean },
  ): Promise<string | { id: string; external?: boolean } | null> {
    const routed = await routePluginId(context, source, importer, resolveOptions);
    const isPage = !isServerResolve(context, resolveOptions);
    const supplied = options?.supplied;
    if (supplied === undefined) {
      if (!isPage) return routed;
      return gateSandboxSdkFile(context, source, importer, resolveOptions, routed);
    }
    const isOpenOnPage = supplied.package() !== null && isPage;
    if (!isOpenOnPage) return routed;
    return gateLiveSdkFile(context, supplied, source, importer, resolveOptions, routed);
  }

  async function routePluginId(
    context: SwapResolveContext,
    source: string,
    importer: string | undefined,
    resolveOptions?: { ssr?: boolean },
  ): Promise<string | { id: string; external?: boolean } | null> {
    const isServer = isServerResolve(context, resolveOptions);
    if (isServer && source === SSR_LOADER) {
      return { id: SSR_LOADER, external: true };
    }
    let original = unaliasedSpecifier(source);
    if (original === null && isServer && isRoutedServerSpecifier(source)) {
      original = source;
    }
    if (original === null) return resolveId(source, importer);
    const { bare: originalBare } = splitSpecifierQuery(original);
    const environment = context.environment;
    const supplied = options?.supplied;
    if (isServer && supplied !== undefined) {
      return refusalIdFor(originalBare, 'server', supplied.refusal(originalBare, 'server'));
    }
    let routed: string | null;
    if (isServer) {
      routed = routeServerImport({
        specifier: original,
        importer,
        aiMode: aiMode(),
        runsInProcess: runsInProcess(environment),
        environmentName: environment?.name ?? 'ssr',
      });
    } else {
      routed = resolveId(original, importer);
    }
    if (routed !== null) return routed;
    const suppliedKind = supplied === undefined ? null : suppliedRowsResolution(supplied, originalBare, importer).kind;
    const isInstalledSdkImport = suppliedKind === 'installed-sdk' || suppliedKind === 'pass-through';
    if (isInstalledSdkImport) return context.resolve(original, importer, { ...resolveOptions, skipSelf: true });
    const stopId = stopIdFor(originalBare, importer);
    if (stopId !== null) return stopId;
    return context.resolve(original, importer, { ...resolveOptions, skipSelf: true });
  }

  async function loadStopModule(stop: StopEntry): Promise<string> {
    return stopModule(stop.error, await stopModuleExports(stop.specifier, stop.resolveDir));
  }

  function loadPluginModule(id: string): Promise<string | null> {
    const supplied = options?.supplied;
    if (supplied !== undefined && isLiveModuleId(id)) {
      return Promise.resolve().then(() => loadLiveModule(supplied, id));
    }
    const stop = stops.get(id);
    if (stop !== undefined) return loadStopModule(stop);
    const shim = load(id);
    if (shim !== null) return Promise.resolve(shim);
    return loadRoutedModule(id, loadServerTarget);
  }

  function load(id: string): string | null {
    if (!id.startsWith(NODE_SHIM_PREFIX)) return null;
    return shimFor(id.slice(NODE_SHIM_PREFIX.length));
  }

  async function preBundledSdkRefusal(file: string): Promise<string | null> {
    const supplied = options?.supplied;
    if (supplied === undefined) return null;
    const url = realFileUrlOf(file);
    const isInstalled = url !== null && url.includes('/node_modules/');
    if (!isInstalled) return null;
    const name = packageNameOf(url);
    if (name === null || !isFirebaseSdkName(name)) return null;
    return stopModule(supplied.refusal(name, 'page'), await stopModuleExports(file, path.dirname(file)));
  }

  const rolldownMirror = {
    name: 'pyric-sandbox-optimizer',
    resolveId(source: string, importer: string | undefined) {
      const id = resolveId(source, importer);
      if (id === null) return null;
      if (id.startsWith(NODE_SHIM_PREFIX)) return id;
      return { id: source, external: true };
    },
    async load(id: string) {
      return (await preBundledSdkRefusal(id)) ?? load(id);
    },
  };

  const optimizerMirror: OptimizerPlugin = {
    name: 'pyric-sandbox-optimizer',
    setup(build) {
      const keepFirebaseExternal = (args: { path: string; importer: string }) => {
        const id = resolveId(args.path, args.importer);
        if (id === null) return null;
        return { path: args.path, external: true };
      };
      build.onResolve({ filter: FIREBASE_SPECIFIER }, keepFirebaseExternal);
      build.onResolve({ filter: SDK_PACKAGE_SPECIFIER }, keepFirebaseExternal);
      build.onResolve({ filter: DIRECT_SDK_STOP_SPECIFIER }, keepFirebaseExternal);
      build.onResolve({ filter: NODE_BUILTIN_RE }, (args) => {
        if (!isOurCode(args.importer)) return null;
        const shimPath = args.path.replace(/^node:/, '');
        return { path: shimPath, namespace: 'pyric-node-shim' };
      });
      if (options?.supplied !== undefined) {
        build.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
          const contents = await preBundledSdkRefusal(args.path);
          if (contents === null) return null;
          return { contents, loader: 'js' };
        });
      }
      build.onLoad({ filter: /.*/, namespace: 'pyric-node-shim' }, (args) => {
        const content = NODE_BUILTIN_SHIMS[args.path];
        if (content === undefined) return null;
        return { contents: content, loader: 'js' };
      });
    },
  };

  function installedSdkExternals(userConfig: UserConfig | undefined): string[] {
    const hasLiveRows = options?.supplied !== undefined;
    const externalizesEveryDependency = userConfig?.ssr?.external === true;
    if (hasLiveRows || externalizesEveryDependency) return [];
    const projectDir = path.resolve(userConfig?.root ?? process.cwd());
    return installedFirebaseSdkNames({ projectDir });
  }

  return {
    config(configOptions) {
      const excludedModules = [
        ...SDK_MODULES,
        'firebase-admin',
        '@firebase/app',
        '@firebase/component',
        '@firebase/ai',
        '@firebase/app-check',
        '@firebase/util',
        '@firebase/logger',
        PYRIC_PACKAGE,
      ];
      if (options?.supplied !== undefined) {
        excludedModules.push(...LIVE_ROW_SDK_PACKAGES, ...passThroughSdkPackages(options.supplied.passThrough));
      }
      const usesRolldown = Number(viteVersion.split('.')[0]) >= 8;
      let optimizeDeps: DepOptimizationOptions;
      if (usesRolldown) {
        optimizeDeps = { exclude: excludedModules, rolldownOptions: { plugins: [rolldownMirror] } } as DepOptimizationOptions;
      } else {
        optimizeDeps = { exclude: excludedModules, esbuildOptions: { plugins: [optimizerMirror] } };
      }
      routesServerImports = configOptions?.devServer === true || configOptions?.ssrBuild === true;
      if (routesServerImports) {
        serverExternal = [...SSR_EXTERNAL, ...installedSdkExternals(configOptions?.userConfig)];
        return {
          resolve: { alias: [ssrSwapAlias()] },
          ssr: { external: serverExternal },
          optimizeDeps,
        };
      }
      serverExternal = SSR_EXTERNAL;
      return { optimizeDeps };
    },
    configEnvironment(name, environmentConfig) {
      const isOtherServerEnvironment =
        routesServerImports && name !== 'ssr' && isServerEnvironment(name, environmentConfig.consumer);
      if (!isOtherServerEnvironment) return null;
      return { resolve: { external: [...serverExternal] } };
    },
    configResolved(config) {
      root = config.root ?? root;
      const allow = config.server?.fs?.allow;
      if (allow === undefined || !Array.isArray(allow)) {
        return;
      }
      for (const dir of [pyricRoot, cliRoot]) {
        if (!allow.includes(dir)) {
          allow.push(dir);
        }
      }
    },
    resolveId,
    resolvePluginId,
    load,
    loadPluginModule,
    observed,
  };
}
