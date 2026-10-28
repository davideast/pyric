/**
 * Request headers for the ai-logic rig. Header names match what @firebase/ai
 * 2.12.0 sends (requests/request.ts): the API key as `x-goog-api-key` and the
 * App Check token as `X-Firebase-AppCheck`. AI Logic on the oracle project
 * answers 403 to any request without a valid App Check token, so every probe,
 * error-envelope probes included, carries one.
 */

/** A minted token is replaced once this little of its lifetime remains. */
const REMINT_MARGIN_MS = 5 * 60 * 1000;

export interface MintedToken {
  mintedAtMs: number;
  ttlMillis: number;
}

export function aiLogicHeaders(apiKey: string, appCheckToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
    'X-Firebase-AppCheck': appCheckToken,
  };
}

export function tokenNeedsRemint(token: MintedToken, nowMs: number): boolean {
  const expiresAtMs = token.mintedAtMs + token.ttlMillis;
  return expiresAtMs - nowMs <= REMINT_MARGIN_MS;
}
