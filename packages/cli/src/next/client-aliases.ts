/**
 * Client-side module aliasing definitions for Firebase Web SDKs.
 */

import { resolveAiMode, swappedFirebaseEntries, type AiMode } from '../serve/firebase-module-swap.js';

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
