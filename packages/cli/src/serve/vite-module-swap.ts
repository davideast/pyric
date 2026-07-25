import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import type { ResolvedConfig, UserConfig } from 'vite';
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
  const aiMode = () => options?.getAiMode?.() ?? 'sandbox';

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
    NODE_BUILTIN_SHIMS[specifier.replace(/^node:/, '')]!;

  const optimizerMirror: EsbuildPlugin = {
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
        const subpath = match !== null && match[1] !== undefined ? match[1] : '';
        const isProductionAiMode = aiMode() === 'production';
        if (isProductionAiMode) {
          const isAiSubpath = subpath === 'ai';
          if (isAiSubpath) {
            return null;
          }
          const isAppSubpath = subpath === 'app';
          const passthroughEntry = entries['app-ai-passthrough'];
          const hasPassthroughEntry = passthroughEntry !== undefined;
          const shouldUsePassthroughBridge = isAppSubpath && hasPassthroughEntry;
          if (shouldUsePassthroughBridge) {
            return { path: passthroughEntry };
          }
        }

        const isServedSubpath = SERVED_FIREBASE_SUBPATHS.has(subpath);
        if (isServedSubpath) {
          const key = entryKey(subpath);
          const entryPath = entries[key];
          if (entryPath !== undefined) {
            return { path: entryPath };
          }
        }
        return null;
      });
      build.onResolve({ filter: NODE_BUILTIN_RE }, (args) => {
        const isOwnedImporter = isOurCode(args.importer);
        if (!isOwnedImporter) {
          return null;
        }
        const shimPath = args.path.replace(/^node:/, '');
        return { path: shimPath, namespace: 'pyric-node-shim' };
      });
      build.onLoad({ filter: /.*/, namespace: 'pyric-node-shim' }, (args) => {
        const content = NODE_BUILTIN_SHIMS[args.path];
        if (content !== undefined) {
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
      } as unknown as UserConfig;
    },
    configResolved(config) {
      const allow = config.server?.fs?.allow;
      const hasAllowList = allow !== undefined && Array.isArray(allow);
      if (!hasAllowList) {
        return;
      }
      for (const dir of [pyricRoot, cliRoot]) {
        const isAlreadyAllowed = allow.includes(dir);
        if (!isAlreadyAllowed) {
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
        const subpath = firebaseMatch[1] !== undefined ? firebaseMatch[1] : '';
        const isProductionAiMode = aiMode() === 'production';
        if (isProductionAiMode) {
          const isAiSubpath = subpath === 'ai';
          if (isAiSubpath) {
            return null;
          }
          const isAppSubpath = subpath === 'app';
          const passthroughEntry = entries['app-ai-passthrough'];
          const hasPassthroughEntry = passthroughEntry !== undefined;
          const shouldUsePassthroughBridge = isAppSubpath && hasPassthroughEntry;
          if (shouldUsePassthroughBridge) {
            return passthroughEntry;
          }
        }
        const isServedSubpath = SERVED_FIREBASE_SUBPATHS.has(subpath);
        if (isServedSubpath) {
          const key = entryKey(subpath);
          const entryPath = entries[key];
          if (entryPath !== undefined) {
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
      const isNodeShim = id.startsWith(NODE_SHIM_PREFIX);
      if (!isNodeShim) {
        return null;
      }
      const specifier = id.slice(NODE_SHIM_PREFIX.length);
      return shimFor(specifier);
    },
  };
}
