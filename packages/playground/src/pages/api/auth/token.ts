/**
 * BFF token endpoint: mint a fresh access token from the httpOnly refresh-token
 * cookie. The browser calls this for `ProjectScope.resolveToken` — silently,
 * across reloads, with no popup. 503 when not configured (browser falls back to
 * GIS); 401 when not signed in; clears the cookie + 401 on an expired refresh.
 */
import type { APIRoute } from 'astro';
import { refreshAccess, AuthExpired } from '@pyric/cli/credentials';
import { COOKIE, bffClient } from '~/lib/auth/bff-config';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export const GET: APIRoute = async ({ cookies }) => {
  const client = bffClient();
  if (!client) return json({ error: 'not_configured' }, 503);

  const refreshToken = cookies.get(COOKIE.refresh)?.value;
  if (!refreshToken) return json({ error: 'not_signed_in' }, 401);

  try {
    const { accessToken, expiresIn } = await refreshAccess({ client, refreshToken });
    return json({ accessToken, expiresIn });
  } catch (e) {
    if (e instanceof AuthExpired) {
      cookies.delete(COOKIE.refresh, { path: '/' });
      return json({ error: 'expired' }, 401);
    }
    return json({ error: 'refresh_failed' }, 500);
  }
};
