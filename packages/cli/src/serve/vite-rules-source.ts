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
  const rulesSource = explicitRules
    ?? (existsSync(path.join(root, 'firestore.modules.rules'))
      ? 'firestore.modules.rules'
      : undefined);

  if (!rulesSource) return firebaseConfig;
  return {
    ...(firebaseConfig ?? {}),
    firestore: {
      ...(firebaseConfig?.firestore ?? {}),
      rules: rulesSource,
    },
  };
}
