import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FirebaseJson } from '../cli/firebase-json.js';

/**
 * Apply the Vite authoring convention without replacing unrelated Firebase
 * configuration. The normal rules loader retains responsibility for its
 * `firebase.json` and root `firestore.rules` fallbacks.
 */
export function resolveViteRulesConfig(
  root: string,
  explicitRules: string | undefined,
  firebaseConfig: FirebaseJson | null,
): FirebaseJson | null {
  const firestoreSource = explicitRules
    ?? (existsSync(path.join(root, 'firestore.modules.rules'))
      ? 'firestore.modules.rules'
      : undefined);
  const storageSource = existsSync(path.join(root, 'storage.modules.rules'))
    ? 'storage.modules.rules'
    : undefined;

  if (!firestoreSource && !storageSource) return firebaseConfig;
  let resolved: FirebaseJson = {
    ...(firebaseConfig ?? {}),
  };
  if (firestoreSource) {
    resolved.firestore = {
      ...(firebaseConfig?.firestore ?? {}),
      rules: firestoreSource,
    };
  }
  if (storageSource) {
    const storage = firebaseConfig?.storage;
    if (Array.isArray(storage)) {
      const index = Math.max(0, storage.findIndex((entry) => entry.rules));
      resolved.storage = storage.length === 0
        ? [{ rules: storageSource }]
        : storage.map((entry, entryIndex) =>
            entryIndex === index ? { ...entry, rules: storageSource } : entry,
          );
    } else {
      resolved.storage = {
        ...(storage ?? {}),
        rules: storageSource,
      };
    }
  }
  return resolved;
}
