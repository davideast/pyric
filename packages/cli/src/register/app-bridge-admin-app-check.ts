/**
 * Production AI mode's App Check verifier for a registered Node process
 * (#1552): firebase-admin's own `verifyToken`, for the tokens the page gets
 * from Firebase.
 *
 * The register installs it behind `pyric.admin.appCheck.firebaseVerifier` in
 * production AI mode only, and loads this module on the first token whose
 * `kid` is not the sandbox's, so a server that never sees one never loads
 * firebase-admin. `firebase-admin/app` and `firebase-admin/app-check` reach
 * the real package from here (`isBypassedBridgeImport`), and the tripwire lets
 * them through.
 *
 * Each project gets one firebase-admin app whose credential refuses to mint an
 * access token, so the app cannot fall back to Application Default
 * Credentials, the metadata server, or Google's OAuth endpoints. Verifying a
 * token needs none of them: firebase-admin fetches Firebase's public keys from
 * `https://firebaseappcheck.googleapis.com/v1/jwks` without credentials and
 * caches them for six hours. `consume` is never passed here; the mirror
 * records it in the process.
 *
 * The export is typed loosely on purpose: the published declarations of
 * @pyric/cli carry no Firebase SDK edge. pyric-admin types the result.
 */
import { initializeApp, type App, type Credential } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';

const NO_CREDENTIALS = "Pyric's App Check verifier holds no credentials.";

/** A credential that never mints an access token. */
const noCredentials: Credential = {
  getAccessToken: () => Promise.reject(new Error(NO_CREDENTIALS)),
};

const appsByProject = new Map<string, App>();

function verifierApp(projectId: string): App {
  const existing = appsByProject.get(projectId);
  if (existing !== undefined) return existing;
  const app = initializeApp({ projectId, credential: noCredentials }, `[pyric] app-check verifier ${projectId}`);
  appsByProject.set(projectId, app);
  return app;
}

/** firebase-admin's `verifyToken(token)` for an app scoped to `projectId`, with no options. */
export function verifyFirebaseAppCheckToken(token: string, projectId: string): Promise<unknown> {
  return getAppCheck(verifierApp(projectId)).verifyToken(token);
}
