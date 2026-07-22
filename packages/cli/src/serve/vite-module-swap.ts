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

/** Own the Vite and optimizer forms of the Firebase-module swap. */
export function createViteModuleSwap(context: ViteModuleContext): ViteModuleSwap {
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
    NODE_BUILTIN_SHIMS[specifier.replace(/^node:/, '')]!;

  const optimizerMirror: EsbuildPlugin = {
    name: 'pyric-sandbox-optimizer',
    setup(build) {
      build.onResolve({ filter: FIREBASE_SPECIFIER }, (args) => {
        const subpath = FIREBASE_SPECIFIER.exec(args.path)![1]!;
        if (SERVED_FIREBASE_SUBPATHS.has(subpath)) {
          return { path: entries[entryKey(subpath)]! };
        }
        return null;
      });
      build.onResolve({ filter: NODE_BUILTIN_RE }, (args) => {
        if (!isOurCode(args.importer)) return null;
        return { path: args.path.replace(/^node:/, ''), namespace: 'pyric-node-shim' };
      });
      build.onLoad({ filter: /.*/, namespace: 'pyric-node-shim' }, (args) => ({
        contents: NODE_BUILTIN_SHIMS[args.path]!,
        loader: 'js',
      }));
    },
  };

  return {
    config() {
      return {
        optimizeDeps: {
          exclude: [...SDK_MODULES],
          include: ['js-md5', 'js-sha256'],
          esbuildOptions: { plugins: [optimizerMirror] },
        },
      } as unknown as UserConfig;
    },
    configResolved(config) {
      const allow = config.server?.fs?.allow;
      if (!allow) return;
      for (const dir of [pyricRoot, cliRoot]) {
        if (!allow.includes(dir)) allow.push(dir);
      }
    },
    resolveId(source, importer) {
      const firebase = FIREBASE_SPECIFIER.exec(source);
      if (firebase) {
        const subpath = firebase[1]!;
        return SERVED_FIREBASE_SUBPATHS.has(subpath) ? entries[entryKey(subpath)]! : null;
      }
      const node = NODE_BUILTIN_RE.exec(source);
      return node && isOurCode(importer) ? NODE_SHIM_PREFIX + node[2]! : null;
    },
    load(id) {
      return id.startsWith(NODE_SHIM_PREFIX) ? shimFor(id.slice(NODE_SHIM_PREFIX.length)) : null;
    },
  };
}
