/**
 * esbuild plugin that marks user-installed bare specifiers as
 * `external`, so the bundler leaves the import as a bare specifier
 * in the output. The preview iframe's import map resolves it to the
 * canonical esm.sh URL.
 *
 * The plugin receives the `name → cdnUrl` map synchronously at
 * construction. Callers must `await getImportMap()` *before* calling
 * `esbuild.build` so the map is captured up front. esbuild plugin
 * hooks don't tolerate async filesystem I/O.
 */

import type * as esbuild from 'esbuild-wasm';

export function cdnImportPlugin(importMap: Record<string, string>): esbuild.Plugin {
  const installed = new Set(Object.keys(importMap));
  return {
    name: 'pyric-cdn-imports',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (!installed.has(args.path)) return null;
        return { path: args.path, external: true };
      });
    },
  };
}
