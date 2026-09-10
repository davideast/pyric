/**
 * Sign the app session in with a federated provider's credential.
 *
 * A sandbox has no identity provider to redeem a token against, so the
 * credential is resolved the way the sandbox resolves one: the address it
 * asserts names the identity, the identity is created if the pool does not
 * hold it, and the provider is linked onto the record, which is what
 * `listUsers` reports. The tokens are carried and never verified.
 *
 * The session is labelled by the provider this call presented, not by the
 * first provider linked to the record, so presenting a `google.com` credential
 * for an address that already has a password account reports `google.com`.
 */
import { z } from 'zod';
import {
  getAuth,
  sandbox as authSandbox,
  signInWithCredential,
  OAuthCredential,
} from 'pyric/auth';
import { RENAMES, signInCredential } from '../../arguments/auth.js';
import { reportAppSession, scopeToStoredTenant, signInFailure } from '../../sign-in.js';
import type { MethodRecord } from '../../method-types.js';

/** One credential, as the schema has already parsed it. */
interface Credential {
  providerId: string;
  idToken?: string;
  accessToken?: string;
  email: string;
}

/** The tokens the provider returned, carried onto the credential unverified. */
function tokensOf(credential: Credential): { idToken?: string; accessToken?: string } {
  const tokens: { idToken?: string; accessToken?: string } = {};
  if (credential.idToken !== undefined) tokens.idToken = credential.idToken;
  if (credential.accessToken !== undefined) tokens.accessToken = credential.accessToken;
  return tokens;
}

export default {
  tool: 'auth',
  method: 'signInWithCredential',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature:
    'signInWithCredential(credential{providerId: google.com|apple.com|facebook.com|github.com|twitter.com|microsoft.com|yahoo.com, email, idToken?, accessToken?})',
  description: 'Sign the app session in with a federated credential.',
  args: z.object({ credential: signInCredential }),
  operation: 'signin_auth_credential',
  renames: RENAMES,
  example: { credential: { providerId: 'google.com', email: 'alice@example.com' } },
  async handler(args, ctx) {
    const credential = args.credential as Credential;
    const auth = getAuth(ctx.sandbox);
    try {
      authSandbox.assertAuthProviderEnabled(auth, credential.providerId);
      scopeToStoredTenant(ctx.sandbox, { email: credential.email });
      const resolved = authSandbox.createSignInCredential(auth, {
        providerId: credential.providerId,
        spec: { email: credential.email },
      });
      authSandbox.mockSignInResult(auth, resolved);
      const presented = new OAuthCredential(
        credential.providerId,
        credential.providerId,
        tokensOf(credential),
      );
      await signInWithCredential(auth, presented);
    } catch (error) {
      return signInFailure('signInWithCredential', error);
    }
    return reportAppSession(ctx);
  },
} satisfies MethodRecord;
