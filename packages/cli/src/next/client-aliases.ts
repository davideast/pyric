/**
 * Client-side module aliasing definitions for Firebase Web SDKs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedFirebaseSdkNames } from '../bundler/externals.js';
import {
  isProductionAiSdkPackage,
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

/**
 * Turbopack alias target for {@link CLIENT_STOP_MODULE}. Uses a project-relative
 * `./` path when `@pyric/cli` is reachable under `projectDir`, avoiding both
 * package `exports` restrictions and Turbopack's root-relative leading-`/` rule.
 */
export function clientStopTurbopackTarget(projectDir: string = process.cwd()): string {
  for (const rel of [
    'node_modules/@pyric/cli/dist/next/client-stop.js',
    'node_modules/@pyric/cli/src/next/client-stop.ts',
  ]) {
    if (existsSync(join(projectDir, rel))) {
      return `./${rel}`;
    }
  }
  const relFromProject = relative(projectDir, CLIENT_STOP_MODULE).split(sep).join('/');
  if (!relFromProject.startsWith('..')) {
    return relFromProject.startsWith('.') ? relFromProject : `./${relFromProject}`;
  }
  return CLIENT_STOP_MODULE;
}

const KNOWN_FIREBASE_SUBPATHS: readonly string[] = [
  'firebase',
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
  '@firebase/auth-compat',
  '@firebase/auth-interop-types',
  '@firebase/auth-types',
  '@firebase/component',
  '@firebase/data-connect',
  '@firebase/database',
  '@firebase/database-compat',
  '@firebase/database-types',
  '@firebase/firestore',
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

function collectPackageExportSubpaths(packageName: string, searchDirs: readonly string[]): string[] {
  const found: string[] = [];
  for (const startDir of searchDirs) {
    for (let dir = startDir; ; dir = dirname(dir)) {
      const manifestPath = join(dir, 'node_modules', packageName, 'package.json');
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            exports?: Record<string, unknown>;
          };
          for (const key of Object.keys(manifest.exports ?? {})) {
            if (key === './package.json') continue;
            if (key === '.') {
              found.push(packageName);
            } else if (key.startsWith('./') && !key.includes('*')) {
              found.push(`${packageName}/${key.slice(2)}`);
            }
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
 * Unserved `firebase`, `firebase/*`, `firebase-admin`, `firebase-admin/*`, and
 * `@firebase/*` specifiers that client bundlers (Webpack and Turbopack) must
 * stop before loading the real Firebase SDK in the browser (ADR 0022).
 */
export function getClientStopSpecifiers(
  mode: AiMode = resolveAiMode(undefined, process.env),
  projectDir: string = process.cwd(),
): string[] {
  const swapped = swappedFirebaseEntries(mode);
  const cliDir = fileURLToPath(new URL('../../', import.meta.url));
  const searchDirs = [projectDir, cliDir];
  const candidates = new Set<string>([
    ...KNOWN_FIREBASE_SUBPATHS,
    ...KNOWN_FIREBASE_ADMIN_SUBPATHS,
    ...KNOWN_SCOPED_FIREBASE_PACKAGES,
    ...collectPackageExportSubpaths('firebase', searchDirs),
    ...collectPackageExportSubpaths('firebase-admin', searchDirs),
    ...installedFirebaseSdkNames({ projectDir }),
  ]);

  const stops: string[] = [];
  for (const specifier of candidates) {
    if (swapped.has(specifier as never)) continue;
    if (mode === 'production') {
      if (specifier === 'firebase/ai' || isProductionAiSdkPackage(specifier)) {
        continue;
      }
    }
    stops.push(specifier);
  }
  return stops;
}
