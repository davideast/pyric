/**
 * `resolveScope` — build a `ProjectScope` for hosted Rules Test API verification.
 *
 * Credential sources, in precedence order:
 *   1. `FIREBASE_SA_BASE64` — base64 service-account JSON (CI). Grants all scopes.
 *   2. `GOOGLE_APPLICATION_CREDENTIALS` — path to a service-account JSON file.
 *   3. `PYRIC_REFRESH_TOKEN` — a CI-injected user refresh token.
 *   4. A stored user credential; carries only the scopes Google granted.
 *   5. ADC (`gcloud auth application-default login` / workload identity) — the
 *      ambient keyless fallback.
 *
 * Service accounts win so CI is deterministic. Sources 3-5 are user credentials
 * not bound to a project, so they need `--project` / `.firebaserc`. Sources 1-3
 * and 5 report `'all'` (non-interactive — no incremental upgrade); only an
 * interactive login carries the narrow granted set that drives the upgrade.
 */
import { fromUserCredential } from '../credentials/core/from-user-credential.js';
import { oauthClient } from '../credentials/core/client.js';
import { fileCredentialStore, defaultCredentialPath } from '../credentials/node/file-store.js';
import { fromAdc } from '../credentials/node/from-adc.js';
import { fromServiceAccount } from '../credentials/node/from-service-account.js';
import type {
  CredentialStore,
  OAuthClient,
  ProjectScope,
  StoredCredential,
} from '../credentials/core/types.js';

/** Registered Google OAuth client baked for the published binary; env-overridable. */
const DEFAULT_OAUTH_CLIENT_ID = '';

export interface ResolvedScope {
  scope: ProjectScope;
  source: 'FIREBASE_SA_BASE64' | 'GOOGLE_APPLICATION_CREDENTIALS' | 'PYRIC_REFRESH_TOKEN' | 'login' | 'adc';
  /** What the credential is authorized for: a service account / CI token / ADC is
   *  `'all'`; a logged-in user carries the scopes Google granted (drives the
   *  deploy scope-upgrade preflight). */
  grantedScopes: string[] | 'all';
}

export interface ResolveScopeOptions {
  projectId?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  store?: CredentialStore;
  oauthClient?: OAuthClient;
  adc?: (projectId: string, env: NodeJS.ProcessEnv) => Promise<ProjectScope | null>;
}

export async function resolveScope(options: ResolveScopeOptions = {}): Promise<ResolvedScope> {
  const env = options.env ?? process.env;

  // 1 + 2. Service-account env (CI) — highest precedence; grants all scopes.
  const saBase64 = env.FIREBASE_SA_BASE64;
  if (saBase64 && saBase64.trim() !== '') {
    return withProject(await fromServiceAccount(`base64:${saBase64}`), 'FIREBASE_SA_BASE64', 'all', options, env);
  }
  const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac && gac.trim() !== '') {
    return withProject(await fromServiceAccount(gac), 'GOOGLE_APPLICATION_CREDENTIALS', 'all', options, env);
  }

  // The remaining sources are user credentials — not bound to a project.
  const projectId = options.projectId ?? env.PYRIC_PROJECT;
  const client =
    options.oauthClient ??
    oauthClient({
      clientId: env.PYRIC_OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID,
      clientSecret: env.PYRIC_OAUTH_CLIENT_SECRET,
    });

  // 3. CI-injected refresh token.
  const ciToken = env.PYRIC_REFRESH_TOKEN;
  if (ciToken && ciToken.trim() !== '') {
    const pid = requireProject(projectId);
    const cred: StoredCredential = { version: 1, refreshToken: ciToken, scopes: [], clientId: client.clientId, obtainedAt: 0 };
    return { scope: fromUserCredential(cred, client, pid), source: 'PYRIC_REFRESH_TOKEN', grantedScopes: 'all' };
  }

  // 4. Logged-in user.
  const store = options.store ?? fileCredentialStore(defaultCredentialPath());
  const cred = await store.read();
  if (cred) {
    const pid = requireProject(projectId);
    return { scope: fromUserCredential(cred, client, pid), source: 'login', grantedScopes: cred.scopes };
  }

  // 5. ADC (gcloud / workload identity) — ambient fallback; needs a project.
  if (projectId) {
    const adcScope = await (options.adc ?? fromAdc)(projectId, env);
    if (adcScope) return { scope: adcScope, source: 'adc', grantedScopes: 'all' };
  }

  // 6. Nothing.
  throw new Error(
    'pyric: Rules Test API verification requires FIREBASE_SA_BASE64, ' +
      'GOOGLE_APPLICATION_CREDENTIALS, or Application Default Credentials from ' +
      '`gcloud auth application-default login`.',
  );
}

function requireProject(projectId: string | undefined): string {
  if (!projectId || projectId.trim() === '') {
    throw new Error('pyric: authenticated, but no project selected. Pass --project <id> or set a default in .firebaserc.');
  }
  return projectId;
}

function withProject(
  baseScope: ProjectScope,
  source: ResolvedScope['source'],
  grantedScopes: ResolvedScope['grantedScopes'],
  options: ResolveScopeOptions,
  env: NodeJS.ProcessEnv,
): ResolvedScope {
  const overrideProjectId = options.projectId ?? env.PYRIC_PROJECT;
  const scope =
    overrideProjectId && overrideProjectId !== baseScope.projectId
      ? Object.freeze({ projectId: overrideProjectId, resolveToken: baseScope.resolveToken })
      : baseScope;
  return { scope, source, grantedScopes };
}
