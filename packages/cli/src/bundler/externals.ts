/**
 * Externalization presets and helpers for Node backend bundlers.
 *
 * Prevents backend bundlers (Rolldown, esbuild, tsup, Rollup, Vite, Webpack)
 * from inlining Firebase and Firebase Admin SDKs — and their transitive
 * Google Cloud dependencies — into bundled server outputs, preserving runtime
 * interception by `@pyric/cli/register` under `pyric sandbox`.
 *
 * The transitive set (`google-auth-library`, `@google-cloud/*`) is included
 * because `firebase-admin` depends on them and their inlined code contacts
 * production Google endpoints (metadata server, OAuth2, Cloud APIs) directly,
 * bypassing the sandbox even when `firebase-admin` itself is externalized.
 */

interface ExternalSpecifierDescriptor {
  readonly prefix: string;
  readonly includeBareRoot: boolean;
  readonly packages: readonly string[];
}

/**
 * Single canonical definition of Firebase and transitive Google Cloud SDK
 * specifier families intercepted by Pyric. All bundler external arrays and
 * plugins are computed from this table so they cannot drift.
 */
const PYRIC_EXTERNAL_DESCRIPTORS: readonly ExternalSpecifierDescriptor[] = Object.freeze([
  {
    prefix: 'firebase-admin',
    includeBareRoot: true,
    packages: ['firebase-admin'],
  },
  {
    prefix: 'firebase',
    includeBareRoot: true,
    packages: ['firebase'],
  },
  {
    prefix: '@firebase',
    includeBareRoot: false,
    packages: [
      '@firebase/app',
      '@firebase/auth',
      '@firebase/firestore',
      '@firebase/database',
      '@firebase/messaging',
      '@firebase/storage',
      '@firebase/util',
    ],
  },
  {
    prefix: 'google-auth-library',
    includeBareRoot: true,
    packages: ['google-auth-library'],
  },
  {
    prefix: '@google-cloud',
    includeBareRoot: false,
    packages: ['@google-cloud/firestore', '@google-cloud/storage'],
  },
]);

function deriveRollupExternals(
  descriptors: readonly ExternalSpecifierDescriptor[],
): readonly RegExp[] {
  return Object.freeze(descriptors.map((d) => new RegExp(`^${d.prefix}(\\/.*)?$`)));
}

function deriveEsbuildExternals(
  descriptors: readonly ExternalSpecifierDescriptor[],
): readonly string[] {
  const patterns: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.includeBareRoot) {
      patterns.push(descriptor.prefix);
    }
    patterns.push(`${descriptor.prefix}/*`);
  }
  return Object.freeze(patterns);
}

function deriveExternalPackages(
  descriptors: readonly ExternalSpecifierDescriptor[],
): readonly string[] {
  const packages: string[] = [];
  for (const descriptor of descriptors) {
    for (const pkg of descriptor.packages) {
      packages.push(pkg);
    }
  }
  return Object.freeze(packages);
}

/**
 * RegExp patterns matching Firebase packages and their transitive backend
 * dependencies for bundlers that accept RegExp in their external configuration
 * (Rolldown, Rollup, Vite, Webpack).
 */
export const pyricRollupExternals: readonly RegExp[] = deriveRollupExternals(
  PYRIC_EXTERNAL_DESCRIPTORS,
);

/**
 * Wildcard string patterns matching Firebase packages and their transitive
 * backend dependencies for bundlers that require string arrays with glob
 * wildcards (esbuild, tsup).
 */
export const pyricEsbuildExternals: readonly string[] = deriveEsbuildExternals(
  PYRIC_EXTERNAL_DESCRIPTORS,
);

/**
 * Canonical package names intercepted by Pyric in Node/SSR backend builds.
 * Used by Vite `ssr.external` and bundler interlock plugins.
 */
export const PYRIC_EXTERNAL_PACKAGES: readonly string[] = deriveExternalPackages(
  PYRIC_EXTERNAL_DESCRIPTORS,
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
 * Webpack `externals` callback that marks any Pyric-intercepted specifier as a
 * CommonJS external so `@pyric/cli/register` can rewrite it at runtime.
 */
export function pyricWebpackExternals(
  _context: unknown,
  request: string,
  callback: (err?: Error | null, result?: string) => void,
): void {
  if (isPyricExternal(request)) {
    callback(null, `commonjs ${request}`);
    return;
  }
  callback();
}

/**
 * Universal bundler interlock plugin compatible with Rollup, Rolldown, Vite
 * (client & SSR `ssr.external`), esbuild, tsup, and Bun.build.
 */
export interface PyricBundlerPlugin {
  readonly name: 'pyric-bundler-interlock';
  resolveId(source: string): { id: string; external: true } | null;
  config(): { ssr: { external: string[] } };
  setup(build: {
    onResolve(
      options: { filter: RegExp },
      callback: (args: { path: string }) => { path: string; external: true } | undefined,
    ): void;
  }): void;
}

export function createPyricBundlerPlugin(): PyricBundlerPlugin {
  return {
    name: 'pyric-bundler-interlock',
    resolveId(source: string) {
      if (isPyricExternal(source)) {
        return { id: source, external: true };
      }
      return null;
    },
    config() {
      return {
        ssr: {
          external: [...PYRIC_EXTERNAL_PACKAGES],
        },
      };
    },
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (isPyricExternal(args.path)) {
          return { path: args.path, external: true };
        }
        return undefined;
      });
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

