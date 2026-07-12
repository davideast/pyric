/**
 * LOCAL-DEV token endpoint. Mints a Google access token server-side from the
 * machine's durable credentials (`pyric login` -> ADC -> service account) via
 * `resolveLocalAccessToken`, so local development needs no browser OAuth flow
 * (no GIS popup, no per-page re-auth, no custom OAuth client).
 *
 * LOCAL-ONLY: enabled under `astro dev`, and — for a local PROD preview served
 * to your own devices over a private network (e.g. Tailscale `astro preview`) —
 * when the build sets `PUBLIC_ENABLE_LOCAL_AUTH=1`. OFF by default in a normal
 * deployed build, so it can never resolve host credentials for arbitrary
 * visitors; there the client keeps using the BFF (`/api/auth/token`) / GIS path.
 *
 * The token is served to your own same-origin browser (over the private
 * network) — the same exposure as an in-browser GIS token, but durable.
 */
import type { APIRoute } from 'astro';
import { resolveLocalAccessToken } from '@pyric/cli/credentials/node';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const GET: APIRoute = async () => {
  // Available under dev, or a local prod preview built with the opt-in flag.
  // Never in a normal deployed build (flag unset) — protects host credentials.
  const enabled =
    import.meta.env.DEV ||
    (import.meta.env as Record<string, unknown>).PUBLIC_ENABLE_LOCAL_AUTH === '1';
  if (!enabled) return json({ error: 'not_available' }, 404);

  try {
    const tok = await resolveLocalAccessToken();
    if (!tok) {
      return json(
        {
          error: 'no_local_credential',
          hint: 'Run `pyric login` or `gcloud auth application-default login`.',
        },
        401,
      );
    }
    return json({
      accessToken: tok.accessToken,
      source: tok.source,
      ...(tok.email ? { email: tok.email } : {}),
      ...(tok.expiresAt ? { expiresAt: tok.expiresAt } : {}),
    });
  } catch (e) {
    return json(
      { error: 'resolve_failed', message: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
};
