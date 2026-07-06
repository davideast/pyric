/**
 * BFF sign-in callback: validate state, exchange the code server-side (with the
 * secret), and persist the refresh token in an httpOnly cookie — the session that
 * survives reloads. Then redirect back to the app.
 */
import type { APIRoute } from 'astro';
import { completeAuth } from 'pyric-tools/credentials';
import { COOKIE, bffClient, callbackUri } from '~/lib/auth/bff-config';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const client = bffClient();
  if (!client) return new Response('BFF not configured', { status: 503 });

  const expectedState = cookies.get(COOKIE.state)?.value;
  const verifier = cookies.get(COOKIE.verifier)?.value;
  cookies.delete(COOKIE.state, { path: '/' });
  cookies.delete(COOKIE.verifier, { path: '/' });

  if (url.searchParams.get('error')) return redirect('/?auth=denied', 302);
  const code = url.searchParams.get('code');
  if (!code) return new Response('missing authorization code', { status: 400 });

  try {
    const { refreshToken } = await completeAuth({
      client,
      code,
      returnedState: url.searchParams.get('state') ?? '',
      expectedState,
      verifier,
      redirectUri: callbackUri(url.origin),
    });
    cookies.set(COOKIE.refresh, refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: url.protocol === 'https:',
      maxAge: 60 * 60 * 24 * 30,
    });
    return redirect('/?auth=ok', 302);
  } catch {
    return redirect('/?auth=error', 302);
  }
};
