/**
 * The `RtdbHost` contract — what `@pyric/rtdb` needs from its caller
 * to talk to a Realtime Database.
 *
 * Unlike `pyric/storage`'s `ProjectScope` (admin-token-only),
 * RTDB needs four things:
 *
 *   - `projectId` + `databaseUrl` — identity
 *   - `resolveAdminToken()` — admin REST (rules bypassed): IR fetch,
 *     rule deploy, structure crawl when no `auth` is supplied.
 *   - `resolveUserToken(auth)` — mints a Firebase ID token for a
 *     specific `{ uid, claims }`. Used for REST paths that want
 *     rules enforced (crawl with `auth`).
 *   - `getClientForUser(auth)` — returns a `firebase/database`
 *     `Database` instance authenticated as the given user (rules
 *     enforced). Used by the data tools (`rtdb_get`/`set`/etc.)
 *     when an `auth` argument is supplied. The implementation
 *     typically wraps Firebase's `FirebaseServerApp`; keeping it on
 *     the host means `@pyric/rtdb` doesn't replicate that wiring.
 *
 * The factory path (`createRtdbAdminTools`) takes an `RtdbHost` directly;
 * `initialize-from-app.ts` builds one from an `AgentAppLike`.
 */
import type { Database } from 'firebase/database';
import type { UserAuth } from './types.js';

export interface RtdbHost {
  readonly projectId: string;
  readonly databaseUrl: string;
  resolveAdminToken(): Promise<string>;
  resolveUserToken(auth: UserAuth): Promise<string>;
  getClientForUser(auth: UserAuth): Promise<Database>;
}

/**
 * REST fetch helper used by handlers that talk to the RTDB REST API
 * directly (IR generation, rule deploy, crawl). When `userToken` is
 * supplied, the request is signed as that user (`auth` query param);
 * otherwise the admin OAuth token is sent as an `Authorization: Bearer`
 * header.
 *
 * Security: `path` may be caller/agent-controlled (e.g. the structure
 * crawler forwards a user-supplied path). It is resolved through the URL
 * API and pinned to the database origin, so a path like `@evil.com/x` or
 * `//evil.com/x` can never reparse the authority and redirect the
 * request — and the admin credential — to an attacker host. Redirects
 * are refused (`redirect: 'error'`) so a 3xx can't bounce the request,
 * and the admin token rides in a header rather than the query string so
 * it stays out of logs and redirect targets.
 */
export async function fetchDatabase(
  host: RtdbHost,
  path: string,
  params?: Record<string, string>,
  userToken?: string,
): Promise<Response> {
  const base = new URL(host.databaseUrl);
  // Resolve `path` as an absolute path against the database origin.
  const rel = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(rel, base);
  if (url.origin !== base.origin) {
    throw new Error(
      `RTDB path '${path}' resolves outside the database origin ${base.origin}.`,
    );
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = {};
  if (userToken) {
    // The RTDB REST API only accepts Firebase ID tokens via the `auth`
    // query param, not a Bearer header.
    url.searchParams.set('auth', userToken);
  } else {
    // Admin access uses a Google OAuth2 access token, which the REST API
    // accepts as a Bearer header — keeping it out of the URL entirely.
    headers.Authorization = `Bearer ${await host.resolveAdminToken()}`;
  }

  return fetch(url, { headers, redirect: 'error' });
}
