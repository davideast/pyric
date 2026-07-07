/**
 * BFF sign-in start: stash PKCE state/verifier in httpOnly cookies and redirect
 * the user to Google's consent screen. The callback completes the exchange.
 */
import type { APIRoute } from 'astro';
import { startAuth } from 'pyric-tools/credentials';
import { BFF_SCOPES, COOKIE, bffClient, callbackUri } from '~/lib/auth/bff-config';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const client = bffClient();
  if (!client) return new Response('BFF not configured (set GIS_CLIENT_SECRET)', { status: 503 });

  const { authUrl, state, verifier } = await startAuth({
    client,
    redirectUri: callbackUri(url.origin),
    scopes: BFF_SCOPES,
  });
  const opts = { httpOnly: true, sameSite: 'lax', path: '/', secure: url.protocol === 'https:', maxAge: 600 } as const;
  cookies.set(COOKIE.state, state, opts);
  cookies.set(COOKIE.verifier, verifier, opts);
  return redirect(authUrl, 302);
};
