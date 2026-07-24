/**
 * Client-side module aliasing definitions for Firebase Web SDKs.
 */
import { defaultSdkEntries } from '../serve/bundler.js';

/**
 * Retrieve the explicit map of canonical Firebase import specifiers to their
 * standalone Pyric browser wrapper entries.
 */
export function getClientAliases(): Record<string, string> {
  const entries = defaultSdkEntries();
  const aliases: Record<string, string> = {
    'firebase/ai': entries.ai,
    'firebase/app': entries.app,
    'firebase/auth': entries.auth,
    'firebase/firestore': entries.firestore,
    'firebase/database': entries.database,
    'firebase/messaging': entries.messaging,
    'firebase/messaging/sw': entries['messaging-sw'],
    'firebase/storage': entries.storage,
  };
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
