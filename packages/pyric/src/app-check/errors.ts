/**
 * App Check errors with the codes, messages, and customData production
 * throws (captures `app-check-client-initialize-twice` and
 * `app-check-client-get-token-before-initialize`).
 */
import { FirebaseError } from '../sandbox/internal/firebase-error.js';

const MESSAGES = {
  'already-initialized': (appName: string) =>
    `You have already called initializeAppCheck() for FirebaseApp ${appName} with different options. To avoid this error, call initializeAppCheck() with the same options as when it was originally called. This will return the already initialized instance.`,
  'use-before-activation': (appName: string) =>
    `App Check is being used before initializeAppCheck() is called for FirebaseApp ${appName}. Call initializeAppCheck() before instantiating other Firebase services.`,
} as const;

export type AppCheckErrorCode = keyof typeof MESSAGES;

export function appCheckError(code: AppCheckErrorCode, appName: string): FirebaseError {
  const fullCode = `appCheck/${code}`;
  return new FirebaseError(fullCode, `AppCheck: ${MESSAGES[code](appName)} (${fullCode}).`, { appName });
}
