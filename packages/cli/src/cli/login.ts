/**
 * `pyric login` / `logout` / `whoami` — interactive Google sign-in for deploy.
 * Thin: wire the Node loopback authorizer + file store + the OAuth client, then
 * call the isomorphic `runLogin` core. All effects are injectable for tests.
 */
import { runLogin } from '../credentials/core/flow.js';
import { oauthClient } from '../credentials/core/client.js';
import { BASE_SCOPES } from '../credentials/core/scopes.js';
import { loopbackAuthorizer } from '../credentials/node/loopback-authorizer.js';
import { fileCredentialStore } from '../credentials/node/file-store.js';
import { openBrowser } from '../serve/open-browser.js';
import type { Authorizer, CredentialStore } from '../credentials/core/types.js';

/** Registered Google OAuth client baked for the published binary; env-overridable. */
const DEFAULT_OAUTH_CLIENT_ID = '';

export interface LoginDeps {
  env?: NodeJS.ProcessEnv;
  store?: CredentialStore;
  authorizer?: Authorizer;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  /** `--ci`: print the refresh token (for PYRIC_REFRESH_TOKEN) instead of a friendly line. */
  ci?: boolean;
}

export async function runLoginCommand(deps: LoginDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const clientId = env.PYRIC_OAUTH_CLIENT_ID ?? DEFAULT_OAUTH_CLIENT_ID;
  if (!clientId) {
    err.write(
      'pyric login: no OAuth client configured. Set PYRIC_OAUTH_CLIENT_ID (a Google "Desktop app" client id).\n',
    );
    return 1;
  }
  const client = oauthClient({ clientId, clientSecret: env.PYRIC_OAUTH_CLIENT_SECRET });
  const store = deps.store ?? fileCredentialStore();
  const authorizer =
    deps.authorizer ?? loopbackAuthorizer({ openUrl: openBrowser, print: (l) => out.write(`${l}\n`) });
  try {
    const cred = await runLogin({ authorizer, store, client, scopes: BASE_SCOPES });
    if (deps.ci) {
      // CI: the refresh token goes to stdout (capturable); instructions to stderr.
      err.write('Set this as PYRIC_REFRESH_TOKEN in your CI environment:\n');
      out.write(`${cred.refreshToken}\n`);
    } else {
      out.write(`Signed in${cred.email ? ` as ${cred.email}` : ''}.\n`);
    }
    return 0;
  } catch (e) {
    err.write(`pyric login: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

export async function runLogoutCommand(deps: LoginDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  await (deps.store ?? fileCredentialStore()).clear();
  out.write('Signed out.\n');
  return 0;
}

export async function runWhoamiCommand(deps: LoginDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const cred = await (deps.store ?? fileCredentialStore()).read();
  if (!cred) {
    out.write('Not signed in. Run `pyric login`.\n');
    return 0;
  }
  out.write(`Signed in${cred.email ? ` as ${cred.email}` : ''} (scopes: ${cred.scopes.join(', ')}).\n`);
  return 0;
}
