/**
 * Browser client for the BFF auth endpoints. The refresh token never reaches the
 * browser (it's an httpOnly cookie on the server); the browser only pulls
 * short-lived access tokens from `/api/auth/token`. Sign-in is a redirect (the
 * server holds the secret), so persistence survives reloads with no popup.
 */
export interface BffToken {
  accessToken: string;
  expiresIn: number;
}
export type BffStatus = 'signed-in' | 'not-signed-in' | 'not-configured';

/** Pull a fresh access token (or the reason there isn't one). */
export async function fetchBffToken(): Promise<{ status: BffStatus; token?: BffToken }> {
  const r = await fetch('/api/auth/token', { credentials: 'same-origin' });
  if (r.status === 503) return { status: 'not-configured' };
  if (r.status === 401) return { status: 'not-signed-in' };
  if (!r.ok) throw new Error(`bff token endpoint: ${r.status}`);
  return { status: 'signed-in', token: (await r.json()) as BffToken };
}

/** Begin sign-in (full-page redirect; the server completes the exchange). */
export function bffSignIn(): void {
  window.location.href = '/api/auth/start';
}

export async function bffSignOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
}
