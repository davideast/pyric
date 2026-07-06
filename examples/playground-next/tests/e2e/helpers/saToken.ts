import { GoogleAuth } from 'google-auth-library';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
export const SA_KEY_FILE = resolve(REPO_ROOT, 'ignored', 'digame-mas-service-account.json');

/**
 * Mint a `cloud-platform` access token from the digame-mas service
 * account. Returns the raw bearer string the playground's deploy
 * hooks consume via `useAccessToken().resolveToken` — exactly the
 * shape `window.__pyricTestToken` expects.
 *
 * Throws with a guidance message if the SA file is missing, so the
 * test surfaces "wrong machine" cleanly instead of a cryptic GoogleAuth
 * stack.
 */
export async function mintSaToken(): Promise<string> {
  const auth = new GoogleAuth({
    keyFile: SA_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  let client;
  try {
    client = await auth.getClient();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to load SA key from ${SA_KEY_FILE}: ${msg}\n` +
        `Place the digame-mas service account JSON at ignored/digame-mas-service-account.json.`,
    );
  }
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('SA token mint returned empty token');
  return token;
}

/** Project id the SA is bound to. Hard-coded — derived from the SA file. */
export const PROOF_PROJECT_ID = 'digame-mas';
/** Default Hosting site (Firebase auto-provisions one named after the project). */
export const PROOF_SITE_ID = 'digame-mas';
