/**
 * Client-side module aliasing definitions for Firebase Web SDKs.
 */

/**
 * Each client `firebase/*` specifier and the `serve/entries` wrapper that
 * replaces it. Every wrapper is exported by `@pyric/cli` as
 * `@pyric/cli/next/internal/<entry>`.
 */
const CLIENT_MODULES: Readonly<Record<string, string>> = {
  'firebase/ai': 'ai',
  'firebase/app': 'app',
  'firebase/auth': 'auth',
  'firebase/firestore': 'firestore',
  'firebase/firestore/lite': 'firestore-lite',
  'firebase/database': 'database',
  'firebase/messaging': 'messaging',
  'firebase/messaging/sw': 'messaging-sw',
  'firebase/storage': 'storage',
};

/**
 * Retrieve the explicit map of canonical Firebase import specifiers to their
 * Pyric browser wrapper entries. Each target is a package specifier rather
 * than a file path: Turbopack reads an absolute alias path as relative to the
 * project root, while a package specifier resolves from the application's own
 * dependencies in Webpack and Turbopack alike.
 */
export function getClientAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const [source, entry] of Object.entries(CLIENT_MODULES)) {
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
