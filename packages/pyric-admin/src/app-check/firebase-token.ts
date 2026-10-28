/**
 * App Check tokens from Firebase: a token whose `kid` names a key that is not
 * the sandbox's (#1552, #1301).
 *
 * In production AI mode the page's `firebase/app-check` is the Firebase SDK,
 * so its tokens come from Firebase, and only firebase-admin's own verifier can
 * check them. `@pyric/cli/register` installs that verifier behind
 * {@link FIREBASE_VERIFIER} in production AI mode only, the same kind of seam
 * as its `pyric.remote.sandboxFactory`: this package never learns what an AI
 * mode is, and never loads firebase-admin itself.
 *
 * With no verifier installed the token is refused with a message that says
 * why. The code stays `invalid-argument`, so a server that branches on it
 * still answers 401.
 */
import { FirebaseAppCheckError } from './error.js';
import type { VerifyAppCheckTokenResponse } from './index.js';

const FIREBASE_VERIFIER = Symbol.for('pyric.admin.appCheck.firebaseVerifier');

/** firebase-admin's `getAppCheck(app).verifyToken(token)` for an app scoped to `projectId`, with no options. */
type FirebaseVerifier = (token: string, projectId: string) => Promise<VerifyAppCheckTokenResponse>;

const MESSAGES = {
  notSandbox:
    "This App Check token was not minted by the Pyric sandbox, so the sandbox's firebase-admin/app-check cannot verify it. " +
    'A page in production AI mode gets its App Check tokens from Firebase. Start this server in production AI mode too ' +
    '(PYRIC_AI_MODE=production) and Pyric verifies them with firebase-admin. In sandbox AI mode, page tokens come from the sandbox and verify here.',
  install:
    'Production AI mode verifies App Check tokens from Firebase with firebase-admin, which is not installed beside this server. ' +
    'Install it in the project that runs the server (npm install firebase-admin) and restart.',
};

function installedVerifier(): FirebaseVerifier | undefined {
  const verifier = (globalThis as Record<symbol, unknown>)[FIREBASE_VERIFIER];
  return typeof verifier === 'function' ? (verifier as FirebaseVerifier) : undefined;
}

/** Whether a failure is the `firebase-admin` package itself not resolving, from ESM or CJS. */
function isFirebaseAdminMissing(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const isNotFound = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
  const namesFirebaseAdmin = typeof message === 'string' && /'firebase-admin[/']/.test(message);
  return isNotFound && namesFirebaseAdmin;
}

/**
 * Verifies a token from Firebase with firebase-admin, through the verifier the
 * register installs. Its result and its errors come back unchanged.
 */
export async function verifyFirebaseToken(token: string, projectId: string): Promise<VerifyAppCheckTokenResponse> {
  const verifier = installedVerifier();
  if (verifier === undefined) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.notSandbox);
  try {
    return await verifier(token, projectId);
  } catch (error) {
    if (isFirebaseAdminMissing(error)) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.install);
    throw error;
  }
}
