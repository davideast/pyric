/**
 * The deploy scope-upgrade preflight. A logged-in user lacking a target's
 * `requiredScope` is re-authorized (an incremental login requesting the union of
 * granted + needed scopes) BEFORE dispatch — so the login UI never overlaps the
 * deploy board. A service account (`'all'`) skips this; a non-interactive session
 * (`--json` / no TTY) fails fast rather than silently opening a browser.
 */
import { runLogin } from '../core/flow.js';
import { missingScope } from '../core/scopes.js';
import { fromUserCredential } from '../core/from-user-credential.js';
import { oauthClient } from '../core/client.js';
import { loopbackAuthorizer } from './loopback-authorizer.js';
import { fileCredentialStore } from './file-store.js';
import { openBrowser } from '../../serve/open-browser.js';
import type { Authorizer, CredentialStore, OAuthClient, ProjectScope } from '../core/types.js';

type Sink = { write(s: string): void };

export interface EnsureScopeOptions {
  requiredScope: string;
  target: string;
  scope: ProjectScope;
  grantedScopes: string[] | 'all';
  interactive: boolean;
  env: NodeJS.ProcessEnv;
  out: Sink;
  err: Sink;
  /** Injectable for tests; production builds the loopback + file store + client. */
  authorizer?: Authorizer;
  store?: CredentialStore;
  client?: OAuthClient;
}

export type EnsureScopeResult =
  | { ok: true; scope: ProjectScope; grantedScopes: string[] | 'all' }
  | { ok: false; exit: number };

export async function ensureScope(opts: EnsureScopeOptions): Promise<EnsureScopeResult> {
  // A service account carries every scope — nothing to upgrade.
  if (opts.grantedScopes === 'all') return { ok: true, scope: opts.scope, grantedScopes: 'all' };

  const need = missingScope(opts.grantedScopes, opts.requiredScope);
  if (!need) return { ok: true, scope: opts.scope, grantedScopes: opts.grantedScopes };

  if (!opts.interactive) {
    opts.err.write(
      `pyric deploy ${opts.target}: needs the '${need}' scope, which your sign-in doesn't have. ` +
        'Run `pyric login` interactively to grant it (or use a service account in CI).\n',
    );
    return { ok: false, exit: 1 };
  }

  opts.out.write(
    `pyric deploy ${opts.target}: needs broader Google access ('${need}'). Re-authorizing in your browser...\n`,
  );
  const client =
    opts.client ??
    oauthClient({ clientId: opts.env.PYRIC_OAUTH_CLIENT_ID ?? '', clientSecret: opts.env.PYRIC_OAUTH_CLIENT_SECRET });
  const store = opts.store ?? fileCredentialStore();
  const authorizer =
    opts.authorizer ?? loopbackAuthorizer({ openUrl: openBrowser, print: (l) => opts.out.write(`${l}\n`) });
  try {
    const cred = await runLogin({ authorizer, store, client, scopes: [...opts.grantedScopes, need] });
    // Build the upgraded scope directly from the new credential — no re-resolve.
    return { ok: true, scope: fromUserCredential(cred, client, opts.scope.projectId), grantedScopes: cred.scopes };
  } catch (e) {
    opts.err.write(`pyric deploy ${opts.target}: re-authorization failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return { ok: false, exit: 2 };
  }
}
