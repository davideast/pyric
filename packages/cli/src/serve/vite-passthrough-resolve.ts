import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRootDirOf } from '../register/package-identity.js';
import { isProductionAiSdkPackage } from './firebase-module-swap.js';
import type { SwapResolveContext } from './vite-module-swap.js';
import { packageRootOf, resolveUnhooked } from './vite-unhooked-resolve.js';

const PRODUCTION_AI_SUBPATHS = [
  'firebase/app',
  'firebase/ai',
  'firebase/app-check',
  '@firebase/ai',
  '@firebase/app',
  '@firebase/app-check',
  '@firebase/app-check-interop-types',
  '@firebase/component',
  '@firebase/logger',
  '@firebase/util',
] as const;

function addResolvedPackageRoot(specifier: string, base: string, out: Set<string>): string | null {
  let resolvedFile: string;
  try {
    resolvedFile = resolveUnhooked(specifier, base);
  } catch {
    return null;
  }
  let pkgRoot = packageRootDirOf(pathToFileURL(resolvedFile).href);
  if (pkgRoot === null) {
    pkgRoot = packageRootOf(resolvedFile);
  }
  out.add(pkgRoot);
  try {
    const realPkgRoot = realpathSync(pkgRoot);
    out.add(realPkgRoot);
    return realPkgRoot;
  } catch {
    return pkgRoot;
  }
}

/**
 * Resolves a bypassed production-AI bridge import (`firebase/app` or
 * `firebase/app-check` imported from Pyric's shadow wrappers) from the Vite
 * application root first so the shadow app shares the exact `@firebase/app`
 * and `@firebase/component` singleton that app code's `firebase/ai` registers
 * onto, even when `@pyric/cli` lives in a separate `node_modules` tree.
 */
export async function resolveBypassedBridgeFromAppRoot(
  context: SwapResolveContext,
  specifier: string,
  appRoot: string,
  importer: string | undefined,
  resolveOptions: { ssr?: boolean } | undefined,
): Promise<{ id: string; external?: boolean } | null> {
  const nextOptions: { skipSelf: boolean; ssr?: boolean } = { skipSelf: true };
  if (resolveOptions !== undefined && resolveOptions.ssr !== undefined) {
    nextOptions.ssr = resolveOptions.ssr;
  }
  const rootAnchor = path.join(path.resolve(appRoot), 'package.json');
  const fromRoot = await context.resolve(specifier, rootAnchor, nextOptions);
  if (fromRoot !== null) {
    return fromRoot;
  }
  return context.resolve(specifier, importer, nextOptions);
}

/**
 * Discovers the real filesystem package directories of the app root's
 * production-AI Firebase SDK packages so Vite's `server.fs.allow` serves
 * symlinked or workspace-linked `/@fs/` modules without HTTP 403 errors while
 * `attachViteSdkRequestGate` continues enforcing `allowedUrls`.
 */
export function productionAiSdkAllowDirs(appRoot: string): string[] {
  const dirs = new Set<string>();
  const rootBase = path.join(path.resolve(appRoot), 'package.json');
  const firebaseRoot = addResolvedPackageRoot('firebase/app', rootBase, dirs);

  const searchBases = [rootBase];
  if (firebaseRoot !== null) {
    searchBases.push(path.join(firebaseRoot, 'package.json'));
  }

  for (const subpath of PRODUCTION_AI_SUBPATHS) {
    if (subpath.startsWith('@firebase/') && !isProductionAiSdkPackage(subpath)) {
      continue;
    }
    for (const base of searchBases) {
      const added = addResolvedPackageRoot(subpath, base, dirs);
      if (added !== null) {
        break;
      }
    }
  }
  return [...dirs];
}
