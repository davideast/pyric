/**
 * `resolveLocalAccessToken` — mint a Google access token from whatever durable
 * credential exists on the local machine, for a LOCAL server (e.g. the
 * playground's `astro dev` `/api` routes) that wants to act on the user's
 * behalf without a browser OAuth flow.
 *
 * Precedence (first that mints wins):
 *   1. Service account  — `FIREBASE_SA_BASE64` / `GOOGLE_APPLICATION_CREDENTIALS`
 *   2. `pyric login`    — `~/.pyric/credentials.json`, refreshed with the OAuth
 *                         client from `PYRIC_OAUTH_CLIENT_ID`/`_SECRET`. If the
 *                         client env is absent or the refresh fails (expired /
 *                         revoked token), we FALL THROUGH to ADC rather than
 *                         letting a stale login block a working credential.
 *   3. ADC              — `gcloud auth application-default login`
 *
 * Returns `null` when nothing can mint (caller shows a "run `pyric login` /
 * `gcloud auth application-default login`" hint). Node-only: reads credential
 * files via the existing `credentials/` adapters — never by hand.
 */
import { fromServiceAccount } from '../../deploy/index.js';
import { oauthClient } from '../core/client.js';
import { fromUserCredential } from '../core/from-user-credential.js';
import type { CredentialStore, ProjectScope } from '../core/types.js';
import { defaultCredentialPath, fileCredentialStore } from './file-store.js';
import { fromAdc } from './from-adc.js';

export type LocalCredentialSource = 'service-account' | 'login' | 'adc';

export interface LocalAccessToken {
  accessToken: string;
  /** Epoch ms, when the source reports a lifetime. */
  expiresAt?: number;
  source: LocalCredentialSource;
  /** Present for the `login` source (from the stored credential). */
  email?: string;
}

export interface ResolveLocalTokenOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  store?: CredentialStore;
  /** Placeholder project for the ProjectScope; the access token itself is not
   *  project-bound (cloud-platform). Defaults to `'local'`. */
  projectId?: string;
}

/**
 * Normalize `ProjectScope.resolveToken()`, whose runtime shape is inconsistent:
 * the service-account/ADC path returns a raw `string`, while the user-credential
 * (pyric login) path returns `{ token, expiresIn }`. (The declared type is
 * `Promise<string>`; the object case is a latent contract wart in
 * `from-user-credential`.) Handle both.
 */
async function mint(scope: ProjectScope): Promise<{ token: string; expiresIn?: number }> {
  const r: unknown = await (scope.resolveToken() as Promise<unknown>);
  if (typeof r === 'string') return { token: r };
  if (r && typeof r === 'object' && 'token' in r) {
    const o = r as { token: unknown; expiresIn?: unknown };
    return {
      token: String(o.token),
      ...(typeof o.expiresIn === 'number' ? { expiresIn: o.expiresIn } : {}),
    };
  }
  throw new Error('resolveToken returned an unexpected shape');
}

export async function resolveLocalAccessToken(
  opts: ResolveLocalTokenOptions = {},
): Promise<LocalAccessToken | null> {
  const env = opts.env ?? process.env;
  const projectId = opts.projectId ?? 'local';
  const withExpiry = (token: string, expiresIn: number | undefined) =>
    typeof expiresIn === 'number' ? { expiresAt: Date.now() + expiresIn * 1000 } : {};

  // 1. Service account (env).
  const saSpec = env.FIREBASE_SA_BASE64?.trim()
    ? `base64:${env.FIREBASE_SA_BASE64}`
    : env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || null;
  if (saSpec) {
    try {
      const { token, expiresIn } = await mint(await fromServiceAccount(saSpec));
      return { accessToken: token, source: 'service-account', ...withExpiry(token, expiresIn) };
    } catch {
      /* fall through */
    }
  }

  // 2. pyric login — only attempt when the OAuth client env is present to
  //    refresh it. On any refresh failure (expired/revoked), fall through.
  const clientId = env.PYRIC_OAUTH_CLIENT_ID;
  if (clientId?.trim()) {
    const store = opts.store ?? fileCredentialStore(defaultCredentialPath());
    const cred = await store.read();
    if (cred) {
      try {
        const client = oauthClient({ clientId, clientSecret: env.PYRIC_OAUTH_CLIENT_SECRET });
        const { token, expiresIn } = await mint(fromUserCredential(cred, client, projectId));
        return {
          accessToken: token,
          source: 'login',
          ...(cred.email ? { email: cred.email } : {}),
          ...withExpiry(token, expiresIn),
        };
      } catch {
        /* stale login → fall through to ADC */
      }
    }
  }

  // 3. ADC (gcloud / workload identity).
  try {
    const scope = await fromAdc(projectId, env);
    if (scope) {
      const { token, expiresIn } = await mint(scope);
      return { accessToken: token, source: 'adc', ...withExpiry(token, expiresIn) };
    }
  } catch {
    /* fall through */
  }

  return null;
}
