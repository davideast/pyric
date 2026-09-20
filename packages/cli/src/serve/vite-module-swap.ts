import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DepOptimizationOptions, ResolvedConfig, UserConfig } from 'vite';
import {
  SDK_MODULES,
  defaultSdkEntries,
  pyricPackageRoot,
  NODE_BUILTIN_RE,
  NODE_BUILTIN_SHIMS,
} from './bundler.js';

const FIREBASE_SPECIFIER = /^firebase\/([a-z-]+(?:\/[a-z-]+)*)$/;
const SERVED_FIREBASE_SUBPATHS = new Set(
  SDK_MODULES.map((specifier) => specifier.slice('firebase/'.length)),
);
const NODE_SHIM_PREFIX = '\0pyric:node-shim:';
type OptimizerOptions = NonNullable<DepOptimizationOptions['esbuildOptions']>;
type OptimizerPlugin = NonNullable<OptimizerOptions['plugins']>[number];

function entryKey(subpath: string): string {
  return subpath.replaceAll('/', '-');
}

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
  getAiMode?: () => 'sandbox' | 'production';
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

  const optimizerMirror: OptimizerPlugin = {
    name: 'pyric-sandbox-optimizer',
    setup(build) {
      build.onResolve({ filter: FIREBASE_SPECIFIER }, (args) => {
        const isShadowBridgeImporter = args.importer !== undefined && args.importer !== '' &&
          (args.importer.includes('app-ai-passthrough') || args.importer.includes('app-bridge'));
        const isFirebaseAppSpecifier = args.path === 'firebase/app';
        const isBypassedBridgeImport = isShadowBridgeImporter && isFirebaseAppSpecifier;
        if (isBypassedBridgeImport) {
          return null;
        }

        const match = FIREBASE_SPECIFIER.exec(args.path);
        const subpath = match?.[1] ?? '';

        const isServedSubpath = SERVED_FIREBASE_SUBPATHS.has(subpath);
        if (isServedSubpath) {
          const key = entryKey(subpath);
          const entryPath = entries[key];
          const hasEntry = entryPath !== undefined;
          if (hasEntry) {
            return { path: entryPath };
          }
        }
        return null;
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
      return {
        optimizeDeps: {
          exclude: excludedModules,
          include: ['js-md5', 'js-sha256'],
          esbuildOptions: { plugins: [optimizerMirror] },
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
    resolveId(source, importer) {
      const isShadowBridgeImporter = importer !== undefined &&
        (importer.includes('app-ai-passthrough') || importer.includes('app-bridge'));
      const isFirebaseAppSpecifier = source === 'firebase/app';
      const isBypassedBridgeImport = isShadowBridgeImporter && isFirebaseAppSpecifier;
      if (isBypassedBridgeImport) {
        return null;
      }

      const firebaseMatch = FIREBASE_SPECIFIER.exec(source);
      const isFirebaseSpecifier = firebaseMatch !== null;
      if (isFirebaseSpecifier) {
        const subpath = firebaseMatch[1] ?? '';
        const isServedSubpath = SERVED_FIREBASE_SUBPATHS.has(subpath);
        if (isServedSubpath) {
          const key = entryKey(subpath);
          const entryPath = entries[key];
          const hasEntry = entryPath !== undefined;
          if (hasEntry) {
            return entryPath;
          }
        }
        return null;
      }

      const nodeMatch = NODE_BUILTIN_RE.exec(source);
      const isNodeBuiltin = nodeMatch !== null && nodeMatch[2] !== undefined;
      const isOwnedImporter = isOurCode(importer);
      const shouldShimNodeBuiltin = isNodeBuiltin && isOwnedImporter;
      if (shouldShimNodeBuiltin) {
        return NODE_SHIM_PREFIX + nodeMatch[2];
      }
      return null;
    },
    load(id) {
      const isForeignId = !id.startsWith(NODE_SHIM_PREFIX);
      if (isForeignId) {
        return null;
      }
      const specifier = id.slice(NODE_SHIM_PREFIX.length);
      return shimFor(specifier);
    },
  };
}
