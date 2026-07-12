const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

export interface AuthorizedUserCredential {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUri?: string;
}

export async function exchangeAuthorizedUserCredential(
  credential: AuthorizedUserCredential,
): Promise<{ token: string; expiresIn: number }> {
  const response = await fetch(credential.tokenUri ?? GOOGLE_TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
      refresh_token: credential.refreshToken,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `ADC token exchange failed (${response.status}): ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, expiresIn: body.expires_in };
}
