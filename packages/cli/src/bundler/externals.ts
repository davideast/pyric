/**
 * Externalization presets and helpers for Node backend bundlers.
 *
 * Prevents backend bundlers (Rolldown, esbuild, tsup, Rollup, Vite, Webpack)
 * from inlining Firebase and Firebase Admin SDKs into bundled server outputs,
 * preserving runtime interception by `@pyric/cli/register` under `pyric sandbox`.
 *
 * Every export derives from one table of specifier families, so the formats
 * each bundler takes cannot drift apart.
 */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { manifestNameAt } from '../register/package-identity.js';
import { isFirebaseSdkName } from '../register/swap-or-stop.js';

/** One family of module specifiers kept out of backend bundles. */
interface ExternalFamily {
  /** A package name, or an npm scope such as `@firebase`. */
  readonly name: string;
  /** `package` covers the name and its subpaths; `scope` covers every package
   *  in the scope and their subpaths. */
  readonly kind: 'package' | 'scope';
}

/**
 * The two packages `@pyric/cli/register` rewrites, and the `@firebase` scope
 * the client SDK is built from.
 */
const EXTERNAL_FAMILIES: readonly ExternalFamily[] = [
  { name: 'firebase-admin', kind: 'package' },
  { name: 'firebase', kind: 'package' },
  { name: '@firebase', kind: 'scope' },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rollupPattern(family: ExternalFamily): RegExp {
  const name = escapeRegExp(family.name);
  if (family.kind === 'scope') return new RegExp(`^${name}/.+$`);
  return new RegExp(`^${name}(/.*)?$`);
}

function esbuildPatterns(family: ExternalFamily): string[] {
  if (family.kind === 'scope') return [`${family.name}/*`];
  return [family.name, `${family.name}/*`];
}

/**
 * RegExp patterns matching Firebase packages for bundlers that accept RegExp
 * in their external configuration (Rolldown, Rollup, Vite, Webpack).
 */
export const pyricRollupExternals: readonly RegExp[] = Object.freeze(
  EXTERNAL_FAMILIES.map(rollupPattern),
);

/**
 * Wildcard string patterns matching Firebase packages for bundlers that require
 * string arrays with glob wildcards (esbuild, tsup).
 */
export const pyricEsbuildExternals: readonly string[] = Object.freeze(
  EXTERNAL_FAMILIES.flatMap(esbuildPatterns),
);

/**
 * The package names, for configuration that takes names rather than patterns,
 * such as Vite's `ssr.external`. The `@firebase` scope has no single name, so
 * it is not here. A bundler that keeps `firebase` external leaves the SDK's own
 * `@firebase/*` imports to Node, but an app's direct `@firebase/*` import, or
 * an npm alias of a Firebase SDK, is bundled unless listed by name.
 * {@link installedFirebaseSdkNames} adds those from what is installed, for
 * `withPyric` (#1626) and {@link pyricViteExternals} (#1756).
 */
export const pyricExternalPackages: readonly string[] = Object.freeze(
  EXTERNAL_FAMILIES.filter((family) => family.kind === 'package').map((family) => family.name),
);

/** Where the scan for installed Firebase SDKs starts, and the last directory it searches. */
export interface ExternalsScan {
  /** The project directory the bundler runs for. */
  readonly projectDir: string;
  /** The last directory whose `node_modules` is searched. Defaults to the filesystem root. */
  readonly stopDir?: string;
}

/** Each `node_modules` folder Node searches from `scan.projectDir`, nearest first. */
function nodeModulesFolders(scan: ExternalsScan): string[] {
  const folders: string[] = [];
  let directory = scan.projectDir;
  for (;;) {
    folders.push(join(directory, 'node_modules'));
    const parent = dirname(directory);
    const isLastDirectory = directory === scan.stopDir || parent === directory;
    if (isLastDirectory) return folders;
    directory = parent;
  }
}

function sortedEntries(folder: string): string[] {
  try {
    return readdirSync(folder).filter((entry) => !entry.startsWith('.')).sort();
  } catch {
    return [];
  }
}

/** The package folders directly in `folder`: `name`, and `@scope/name` for each scope. */
function topLevelPackages(folder: string): string[] {
  return sortedEntries(folder).flatMap((entry) => {
    const isScope = entry.startsWith('@');
    if (!isScope) return [entry];
    return sortedEntries(join(folder, entry)).map((scoped) => `${entry}/${scoped}`);
  });
}

/** Whether `folder/entry` is a Firebase SDK, by the name in its own `package.json` only. */
function isInstalledFirebaseSdk(folder: string, entry: string): boolean {
  return isFirebaseSdkName(manifestNameAt(join(folder, entry)));
}

/**
 * The names a server module can import a Firebase SDK by: `firebase` and
 * `firebase-admin`, then each top-level entry of each `node_modules` folder
 * Node searches from the project whose own `package.json` names a Firebase
 * SDK, by the register's check (`isFirebaseSdkName`). That covers every
 * `@firebase/*` package and npm aliases such as
 * `"admin": "npm:firebase-admin@13"`, whoever declares them.
 */
export function installedFirebaseSdkNames(scan: ExternalsScan): string[] {
  const installed = nodeModulesFolders(scan).flatMap((folder) =>
    topLevelPackages(folder).filter((entry) => isInstalledFirebaseSdk(folder, entry)));
  return Array.from(new Set([...pyricExternalPackages, ...installed]));
}

/**
 * Universal predicate returning true if a module specifier belongs to Firebase
 * or Firebase Admin SDK surfaces intercepted by Pyric.
 *
 * Compatible with bundlers that accept a function in their external setting
 * (Rolldown, Rollup, Vite, Webpack).
 */
export function isPyricExternal(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) {
    return false;
  }
  return pyricRollupExternals.some((regex) => regex.test(id));
}

/**
 * A Vite plugin that keeps every Firebase SDK external in SSR output. It adds
 * {@link installedFirebaseSdkNames} from the Vite root to `ssr.external`,
 * which Vite applies to SSR builds only and ranks above `ssr.noExternal`, so
 * a server bundled with `noExternal: true` still imports `firebase`,
 * `firebase-admin`, a direct `@firebase/*` import and an npm alias of either
 * at runtime, where the register sees them (#1756). Vite matches the list by
 * the name an import names, so an alias is listed by its own name. Client
 * builds are unaffected, and the plugin does not run in the dev server. A
 * config with `ssr.external: true` already externalizes every dependency, so
 * the plugin leaves it alone.
 */
export function pyricViteExternals(): Plugin {
  return {
    name: 'pyric-vite-externals',
    apply: 'build',
    config(config) {
      const externalizesEveryDependency = config.ssr?.external === true;
      if (externalizesEveryDependency) return undefined;
      const projectDir = resolve(config.root ?? process.cwd());
      return { ssr: { external: installedFirebaseSdkNames({ projectDir }) } };
    },
  };
}

/**
 * Convenience presets mapping bundler names to their supported external pattern format.
 */
export const pyricExternals = Object.freeze({
  rolldown: pyricRollupExternals,
  rollup: pyricRollupExternals,
  vite: pyricRollupExternals,
  webpack: pyricRollupExternals,
  esbuild: pyricEsbuildExternals,
  tsup: pyricEsbuildExternals,
});
