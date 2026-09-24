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
import type { Plugin } from 'vite';

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
 * such as Vite's `ssr.external`. The `@firebase` scope has no single name, and
 * needs none: its packages are dependencies of `firebase`, and a bundler that
 * keeps `firebase` external leaves those imports to Node as well.
 */
export const pyricExternalPackages: readonly string[] = Object.freeze(
  EXTERNAL_FAMILIES.filter((family) => family.kind === 'package').map((family) => family.name),
);

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
 * A Vite plugin that keeps `firebase` and `firebase-admin` external in SSR
 * output. It adds {@link pyricExternalPackages} to `ssr.external`, which Vite
 * applies to SSR builds only and ranks above `ssr.noExternal`, so a server
 * bundled with `noExternal: true` still imports Firebase at runtime. Client
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
      return { ssr: { external: [...pyricExternalPackages] } };
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
