/**
 * `getDeploy(app)` — build a `ProjectScope` from an already-initialized
 * firebase-admin App. Mirrors the modular Web SDK's `getFirestore(app)` /
 * `getAuth(app)` shape so Firebase devs reach for it without learning
 * a new entry-point.
 *
 * The App must have been initialized with a `cert(...)` credential
 * (i.e. via a service-account key). For raw base64 SA env vars without
 * a firebase-admin App in hand, use {@link fromServiceAccount} from
 * the same package — it'll build the ProjectScope without touching
 * firebase-admin.
 *
 * Resolves the OAuth access token via the credential's internal
 * `getAccessToken()` (the stable accessor used by firebase tooling).
 * Wraps in `memoizeTtl` so consumers get caching for free.
 */
import type { App as AdminApp } from 'firebase-admin/app';
import type { ProjectScope } from './scope.js';
import { memoizeTtl } from './memoize-ttl.js';

interface CredentialWithToken {
  getAccessToken(): Promise<{ access_token: string; expires_in: number }>;
}

export function getDeploy(app: AdminApp): ProjectScope {
  const projectId = app.options.projectId;
  if (!projectId) {
    throw new Error(
      'getDeploy: firebase-admin App has no projectId. Initialize with `projectId` in the options.',
    );
  }
  const credential = app.options.credential as unknown as CredentialWithToken | undefined;
  if (!credential || typeof credential.getAccessToken !== 'function') {
    throw new Error(
      'getDeploy: firebase-admin App was not initialized with a cert credential ' +
        '(no `getAccessToken` on app.options.credential). Use admin.credential.cert(saCert) at init time.',
    );
  }
  const resolveToken = memoizeTtl(async () => {
    const tokenObj = await credential.getAccessToken();
    return { token: tokenObj.access_token, expiresIn: tokenObj.expires_in };
  });
  return { projectId, resolveToken };
}
