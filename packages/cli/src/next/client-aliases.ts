/**
 * Client-side module aliasing definitions for Firebase Web SDKs.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedFirebaseSdkNames } from '../bundler/externals.js';
import {
  SDK_MODULES,
  resolveAiMode,
  swappedFirebaseEntries,
  type AiMode,
} from '../serve/firebase-module-swap.js';

/**
 * Retrieve the explicit map of canonical Firebase import specifiers to their
 * Pyric browser wrapper entries, for one AI mode. The entries come from
 * {@link swappedFirebaseEntries}, the table every plane that swaps reads, so
 * production AI mode leaves `firebase/ai` to the Firebase SDK here as the
 * import map and the Vite resolver do. The mode defaults to the one the
 * environment names, resolved as every front door resolves it.
 *
 * Each target is a package specifier rather than a file path: Turbopack reads
 * an absolute alias path as relative to the project root, while a package
 * specifier resolves from the application's own dependencies in Webpack and
 * Turbopack alike. Every wrapper is exported by `@pyric/cli` as
 * `@pyric/cli/next/internal/<entry>`.
 */
export function getClientAliases(mode: AiMode = resolveAiMode(undefined, process.env)): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const [source, entry] of swappedFirebaseEntries(mode)) {
    aliases[source] = `@pyric/cli/next/internal/${entry}`;
  }
  return aliases;
}

/**
 * Retrieve benign boolean fallback replacements for Node built-in modules
 * accessible in browser packaging bundles.
 */
export function getNodeBuiltinFallbacks(): Record<string, boolean> {
  const fallbacks: Record<string, boolean> = {
    fs: false,
    path: false,
    url: false,
    'node:fs': false,
    'node:path': false,
    'node:url': false,
  };
  return fallbacks;
}

function moduleExtension(): string {
  return import.meta.url.endsWith('.ts') ? '.ts' : '.js';
}

/** Absolute path to the compiled browser client stop module. */
export const CLIENT_STOP_MODULE = fileURLToPath(new URL(`./client-stop${moduleExtension()}`, import.meta.url));

/** Package specifier exported by `@pyric/cli` for Turbopack client stop aliases. */
const CLIENT_STOP_SPECIFIER = '@pyric/cli/next/internal/client-stop';

/**
 * Turbopack alias target for {@link CLIENT_STOP_MODULE}. Uses a package
 * specifier exported by `@pyric/cli` so hoisted monorepos, pnpm virtual stores,
 * and standard `node_modules` installs resolve uniformly without OS-absolute
 * leading `/` paths.
 */
export function clientStopTurbopackTarget(): string {
  return CLIENT_STOP_SPECIFIER;
}

const KNOWN_FIREBASE_SUBPATHS: readonly string[] = [
  'firebase',
  'firebase/auth/cordova',
  'firebase/auth/web-extension',
  'firebase/firestore/pipelines',
  'firebase/firestore/lite/pipelines',
  'firebase/installations',
  'firebase/data-connect',
  'firebase/vertexai',
  'firebase/compat',
  'firebase/compat/app',
  'firebase/compat/analytics',
  'firebase/compat/app-check',
  'firebase/compat/auth',
  'firebase/compat/database',
  'firebase/compat/firestore',
  'firebase/compat/functions',
  'firebase/compat/installations',
  'firebase/compat/messaging',
  'firebase/compat/performance',
  'firebase/compat/remote-config',
  'firebase/compat/storage',
];

const KNOWN_FIREBASE_ADMIN_SUBPATHS: readonly string[] = [
  'firebase-admin',
  'firebase-admin/app',
  'firebase-admin/app-check',
  'firebase-admin/auth',
  'firebase-admin/data-connect',
  'firebase-admin/database',
  'firebase-admin/eventarc',
  'firebase-admin/extensions',
  'firebase-admin/firestore',
  'firebase-admin/functions',
  'firebase-admin/installations',
  'firebase-admin/machine-learning',
  'firebase-admin/messaging',
  'firebase-admin/project-management',
  'firebase-admin/remote-config',
  'firebase-admin/security-rules',
  'firebase-admin/storage',
];

const KNOWN_SCOPED_FIREBASE_PACKAGES: readonly string[] = [
  '@firebase/ai',
  '@firebase/analytics',
  '@firebase/analytics-compat',
  '@firebase/analytics-types',
  '@firebase/app',
  '@firebase/app-check',
  '@firebase/app-check-compat',
  '@firebase/app-check-interop-types',
  '@firebase/app-compat',
  '@firebase/app-types',
  '@firebase/auth',
  '@firebase/auth/cordova',
  '@firebase/auth/internal',
  '@firebase/auth/web-extension',
  '@firebase/auth-compat',
  '@firebase/auth-interop-types',
  '@firebase/auth-types',
  '@firebase/component',
  '@firebase/data-connect',
  '@firebase/database',
  '@firebase/database-compat',
  '@firebase/database-types',
  '@firebase/firestore',
  '@firebase/firestore/lite',
  '@firebase/firestore/lite/pipelines',
  '@firebase/firestore/pipelines',
  '@firebase/firestore-compat',
  '@firebase/firestore-types',
  '@firebase/functions',
  '@firebase/functions-compat',
  '@firebase/functions-types',
  '@firebase/installations',
  '@firebase/installations-compat',
  '@firebase/installations-types',
  '@firebase/logger',
  '@firebase/messaging',
  '@firebase/messaging/sw',
  '@firebase/messaging-compat',
  '@firebase/messaging-interop-types',
  '@firebase/performance',
  '@firebase/performance-compat',
  '@firebase/performance-types',
  '@firebase/remote-config',
  '@firebase/remote-config-compat',
  '@firebase/remote-config-types',
  '@firebase/storage',
  '@firebase/storage-compat',
  '@firebase/storage-types',
  '@firebase/util',
  '@firebase/vertexai',
  '@firebase/webchannel-wrapper',
];

function sdkStoreSearchDirs(baseDirs: readonly string[]): string[] {
  const dirs = new Set<string>(baseDirs);
  for (const startDir of baseDirs) {
    for (let dir = startDir; ; dir = dirname(dir)) {
      for (const rootPkg of ['firebase', 'firebase-admin']) {
        const candidate = join(dir, 'node_modules', rootPkg);
        if (existsSync(join(candidate, 'package.json'))) {
          try {
            const realPkg = realpathSync(candidate);
            dirs.add(realPkg);
            dirs.add(dirname(dirname(realPkg)));
          } catch {
            // Keep walking if realpath fails.
          }
        }
      }
      if (dirname(dir) === dir) break;
    }
  }
  return [...dirs];
}

function fallbackAliasSubpaths(aliasName: string, manifestName: string | undefined): string[] {
  if (manifestName === 'firebase' && aliasName !== 'firebase') {
    const allFirebase = [...SDK_MODULES, ...KNOWN_FIREBASE_SUBPATHS];
    return allFirebase.map((spec) => {
      if (spec === 'firebase') return aliasName;
      return `${aliasName}/${spec.slice('firebase/'.length)}`;
    });
  }
  if (manifestName === 'firebase-admin' && aliasName !== 'firebase-admin') {
    return KNOWN_FIREBASE_ADMIN_SUBPATHS.map((spec) => {
      if (spec === 'firebase-admin') return aliasName;
      return `${aliasName}/${spec.slice('firebase-admin/'.length)}`;
    });
  }
  if (manifestName !== undefined && manifestName.startsWith('@firebase/') && aliasName !== manifestName) {
    const prefix = `${manifestName}/`;
    const matching = KNOWN_SCOPED_FIREBASE_PACKAGES.filter(
      (spec) => spec === manifestName || spec.startsWith(prefix),
    );
    if (matching.length > 0) {
      return matching.map((spec) => {
        if (spec === manifestName) return aliasName;
        return `${aliasName}/${spec.slice(prefix.length)}`;
      });
    }
  }
  return [aliasName];
}

function collectPackageExportSubpaths(packageName: string, searchDirs: readonly string[]): string[] {
  const found: string[] = [];
  for (const startDir of searchDirs) {
    for (let dir = startDir; ; dir = dirname(dir)) {
      const manifestPath = join(dir, 'node_modules', packageName, 'package.json');
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            name?: string;
            exports?: Record<string, unknown>;
          };
          if (manifest.exports !== undefined && typeof manifest.exports === 'object' && manifest.exports !== null) {
            for (const key of Object.keys(manifest.exports)) {
              if (key === './package.json') continue;
              if (key === '.') {
                found.push(packageName);
              } else if (key.startsWith('./') && !key.includes('*')) {
                found.push(`${packageName}/${key.slice(2)}`);
              }
            }
          } else {
            found.push(...fallbackAliasSubpaths(packageName, manifest.name));
          }
        } catch {
          // Unreadable manifest is ignored; static list still covers standard subpaths.
        }
        return found;
      }
      if (dirname(dir) === dir) break;
    }
  }
  return found;
}

/**
 * Unserved `firebase`, `firebase/*`, `firebase-admin`, `firebase-admin/*`,
 * `@firebase/*` (including subpath exports), and npm-aliased SDK specifiers
 * that client bundlers (Webpack and Turbopack) must stop before loading the
 * real Firebase SDK in the browser (ADR 0022).
 */
export function getClientStopSpecifiers(
  mode: AiMode = resolveAiMode(undefined, process.env),
  projectDir: string = process.cwd(),
): string[] {
  const swapped = swappedFirebaseEntries(mode);
  const cliDir = fileURLToPath(new URL('../../', import.meta.url));
  const searchDirs = sdkStoreSearchDirs([projectDir, cliDir]);
  const installedPackages = new Set<string>([
    'firebase',
    'firebase-admin',
    ...KNOWN_SCOPED_FIREBASE_PACKAGES.filter((spec) => spec.split('/').length === 2),
    ...installedFirebaseSdkNames({ projectDir }),
    ...installedFirebaseSdkNames({ projectDir: cliDir }),
  ]);

  const candidates = new Set<string>([
    ...KNOWN_FIREBASE_SUBPATHS,
    ...KNOWN_FIREBASE_ADMIN_SUBPATHS,
    ...KNOWN_SCOPED_FIREBASE_PACKAGES,
  ]);
  for (const pkgName of installedPackages) {
    candidates.add(pkgName);
    for (const exportedSubpath of collectPackageExportSubpaths(pkgName, searchDirs)) {
      candidates.add(exportedSubpath);
    }
  }

  const stops: string[] = [];
  for (const specifier of candidates) {
    if (swapped.has(specifier as never)) continue;
    if (mode === 'production' && specifier === 'firebase/ai') {
      continue;
    }
    stops.push(specifier);
  }
  return stops;
}
