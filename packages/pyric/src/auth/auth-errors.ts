/**
 * Auth error factory — the shared primitive every sandbox auth module
 * throws through. Extracted from `sandbox-backend.ts` so the backend
 * core, the credential validators, and `prod-backend.ts` all depend on
 * one definition rather than a re-export chain.
 */

import { FirebaseError } from '../app/firebase-error.js';

/**
 * Build a Firebase-shaped `FirebaseError` from the sandbox-owned app mirror,
 * with the prod message wrapper `Firebase: <message> (<code>).`
 * (`clones/.../util/src/errors.ts:121` — `${serviceName}: ${message}
 * (${fullCode}).`, serviceName `Firebase`). So consumer code that does
 * `err instanceof FirebaseError` or matches on the wrapped message sees
 * the same shape sandbox vs prod (AUTH-GAP). `.code` is preserved.
 *
 * Oracle-pinned shapes this reproduces:
 *   - `Firebase: Error (auth/invalid-email).`
 *   - `Firebase: Password should be at least 6 characters (auth/weak-password).`
 */
export function makeAuthError(code: string, message: string): FirebaseError {
  return new FirebaseError(code, `Firebase: ${message} (${code}).`);
}
