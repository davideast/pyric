/** BFF sign-out: clear the refresh-token cookie. */
import type { APIRoute } from 'astro';
import { COOKIE } from '~/lib/auth/bff-config';

export const prerender = false;

export const POST: APIRoute = async ({ cookies }) => {
  cookies.delete(COOKIE.refresh, { path: '/' });
  return new Response(null, { status: 204 });
};
