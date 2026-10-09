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
  isShadowAppImporter,
  swappedFirebaseEntries,
  type AiMode,
  type ServedFirebaseSpecifier,
} from './firebase-module-swap.js';

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

export interface ViteModuleSwap {
  config(): UserConfig;
  configResolved(config: ResolvedConfig): void;
  resolveId(source: string, importer: string | undefined): string | null;
  load(id: string): string | null;
}

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

  function resolveId(source: string, importer: string | undefined): string | null {
    const isBypassedBridgeImport = isShadowAppImporter(importer) && source === 'firebase/app';
    if (isBypassedBridgeImport) return null;

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
    config() {
      const excludedModules = [
        ...SDK_MODULES,
        '@firebase/app',
        '@firebase/component',
        '@firebase/ai',
        '@firebase/util',
        '@firebase/logger',
      ];
      const usesRolldown = Number(viteVersion.split('.')[0]) >= 8;
      const optimizer = usesRolldown
        ? { rolldownOptions: { plugins: [rolldownMirror] } }
        : { esbuildOptions: { plugins: [optimizerMirror] } };
      return {
        optimizeDeps: {
          exclude: excludedModules,
          ...optimizer,
        },
      };
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
    load,
  };
}
