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
  suppliedRowsResolution,
  type SuppliedRows,
} from './vite-supplied-rows.js';
import {
  STOP_PREFIX,
  loadRoutedModule,
  routeServerImport,
  ssrSwapAlias,
  stopModule,
  stopModuleExports,
  unaliasedSpecifier,
} from './vite-ssr-routing.js';
import { loadServerTarget } from './vite-ssr-loader.js';
import { stopFor } from '../register/swap-or-stop.js';

const FIREBASE_SPECIFIER = /^firebase\/([a-z-]+(?:\/[a-z-]+)*)$/;
const SDK_PACKAGE_SPECIFIER = /^@firebase\//;
const NODE_SHIM_PREFIX = '\0pyric:node-shim:';
/** The installed SDK packages live rows load beside the excluded ones. */
const LIVE_SDK_PACKAGES = ['@firebase/auth', '@firebase/firestore'];
/** The SDK package the served entries import; one instance per page. */
const PYRIC_PACKAGE = 'pyric';
/**
 * Node's CommonJS resolver, typed locally: the repo's ambient Node types
 * leave out these internals.
 */
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
 * process's `module.registerHooks` resolve hooks. From Node 24.16 those hooks
 * also run for `require.resolve`: pyric's own stop hook throws there, which
 * read as "not installed", and the register maps `firebase-admin` to
 * `pyric-admin`, which read as "not the real SDK", so the stop was skipped
 * (#1906). `Module._resolveFilename` runs below the hooks on Node 22.15 and
 * 24.16. Falls back to `createRequire` on a runtime without it.
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

/** A real SDK import the swap stops: the register's error, and where the import resolves from. */
interface Stop {
  readonly error: Error;
  readonly specifier: string;
  readonly resolveDir: string;
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
  /** Vite's root, set by `configResolved`: where an import with no file importer resolves from. */
  let root = process.cwd();
  /** The stop behind each stop module id, and the id each import got. */
  const stops = new Map<string, Stop>();
  const stopIds = new Map<string, string>();
  /** The real SDK files the stop allowed, as the register's hook keeps them. */
  const allowedUrls = new Set<string>();

  /** The files an import resolves from: the importer's, when it is a file, then the root's. */
  function resolveBases(importer: string | undefined): string[] {
    const importerFile = importer?.split('?')[0];
    const fromRoot = path.join(root, 'package.json');
    const isFileImporter = importerFile !== undefined && path.isAbsolute(importerFile);
    return isFileImporter ? [importerFile, fromRoot] : [fromRoot];
  }

  /** Where Node resolves `specifier` from the first base that has it installed, or null when none does. */
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

  /**
   * Swap or stop (ADR 0022): the id of a module that throws the register's
   * stop error, for an import of the real SDK the swap does not choose here.
   * `stopFor` decides, as the register's hook does, from the file the import
   * resolves to. Null when the swap chooses the real SDK (production AI
   * mode's `firebase/ai`, a shadow app's own `firebase/app`), or when the
   * import is not installed, so Vite reports it as before.
   */
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

  /**
   * The id of a module that throws `error` when it loads, for a served
   * specifier the supplied rows refuse. It declares the real module's export
   * names, as a stop module does, so the importer sees the refusal rather
   * than a missing export.
   */
  function refusalIdFor(specifier: string, plane: 'page' | 'server', error: Error): string {
    const id = `${STOP_PREFIX}refused:${plane}:${specifier}`;
    const isKnown = stops.has(id);
    if (!isKnown) stops.set(id, { error, specifier, resolveDir: root });
    return id;
  }

  /** The supplied rows' answer for a Firebase or `firebase-admin` import on the page plane. */
  function resolveSupplied(supplied: SuppliedRows, source: string, importer: string | undefined): string | null {
    const resolution = suppliedRowsResolution(supplied, source, importer);
    if (resolution.kind === 'module') return resolution.id;
    if (resolution.kind === 'refused') return refusalIdFor(source, 'page', resolution.error);
    return null;
  }

  /** A row module's import of the one observer module, while the rows are open. */
  function isObserverImport(source: string, importer: string | undefined): boolean {
    const supplied = options?.supplied;
    const isOpen = supplied !== undefined && supplied.package() !== null;
    return isOpen && source === OBSERVER_SPECIFIER && importer !== undefined && isLiveModuleId(importer);
  }

  /** The source of a fixed live module, from the installed `@pyric/live`. Throws while the rows are shut. */
  function loadLiveModule(supplied: SuppliedRows, id: string): string | null {
    const found = supplied.package();
    if (found === null) throw new Error(`pyric: ${JSON.stringify(id)} is a live row module, and @pyric/live has not opened the rows.`);
    return found.moduleSource(id);
  }

  function resolveId(source: string, importer: string | undefined): string | null {
    if (isBypassedBridgeImport(source, importer)) return null;
    if (isObserverImport(source, importer)) return OBSERVER_MODULE_ID;

    const supplied = options?.supplied;
    const isSuppliedImport = supplied !== undefined && isSuppliedRowsImport(source);
    if (isSuppliedImport) return resolveSupplied(supplied, source, importer);
    const isFirebaseSpecifier = FIREBASE_SPECIFIER.test(source);
    if (isFirebaseSpecifier) {
      const swapped = swappedFirebaseEntries(aiMode());
      const key = swapped.get(source as ServedFirebaseSpecifier);
      const isServed = key !== undefined;
      return isServed ? entries[key] ?? null : stopIdFor(source, importer);
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
    // Supplied rows serve pages only: server code gets no row of either kind.
    const supplied = options?.supplied;
    if (isServer && supplied !== undefined) return refusalIdFor(original, 'server', supplied.refusal(original, 'server'));
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
    const isRowModuleOwnImport = supplied !== undefined &&
      suppliedRowsResolution(supplied, original, importer).kind === 'installed-sdk';
    if (isRowModuleOwnImport) return context.resolve(original, importer, { ...resolveOptions, skipSelf: true });
    // Not swapped here. firebase-admin in browser code, and any other load of
    // the real SDK the swap does not choose, gets the stop module.
    const stopId = stopIdFor(original, importer);
    if (stopId !== null) return stopId;
    // The real firebase/ai in production AI mode, or a shadow app's own
    // firebase/app: resolve it as Vite would have. The alias is in the skip
    // set this call inherits.
    return context.resolve(original, importer, { ...resolveOptions, skipSelf: true });
  }

  async function loadStopModule(stop: Stop): Promise<string> {
    return stopModule(stop.error, await stopModuleExports(stop.specifier, stop.resolveDir));
  }

  function loadPluginModule(id: string): Promise<string | null> {
    const supplied = options?.supplied;
    const isLiveModule = supplied !== undefined && isLiveModuleId(id);
    if (isLiveModule) return Promise.resolve().then(() => loadLiveModule(supplied, id));
    const stop = stops.get(id);
    if (stop !== undefined) return loadStopModule(stop);
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
      const keepFirebaseExternal = (args: { path: string; importer: string }) => {
        const id = resolveId(args.path, args.importer);
        const isUnchanged = id === null;
        return isUnchanged ? null : { path: args.path, external: true };
      };
      build.onResolve({ filter: FIREBASE_SPECIFIER }, keepFirebaseExternal);
      // Under live rows a dependency's `@firebase/*` import stays external too, so the page refuses it.
      build.onResolve({ filter: SDK_PACKAGE_SPECIFIER }, keepFirebaseExternal);
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
        // A page's own `pyric/*` import would otherwise get a pre-bundled copy
        // of pyric, with its own app registry, and the served entries would
        // resolve to that copy too. The page and the entries must share the
        // one pyric `initializeApp` registers apps in (#1506). The bare name
        // covers every subpath.
        PYRIC_PACKAGE,
        // Live rows load the installed Auth and Firestore, which import the
        // excluded @firebase/app: kept out too, so the page has one registry.
        ...(options?.supplied === undefined ? [] : LIVE_SDK_PACKAGES),
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
      root = config.root ?? root;
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
