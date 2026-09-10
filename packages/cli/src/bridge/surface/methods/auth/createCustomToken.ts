/**
 * Mint a custom token for a uid.
 *
 * Minting changes nothing: in production a backend signs an assertion with a
 * service account key and the project's user pool is not touched until the
 * token is redeemed. The sandbox has no key, so the token is the payload a
 * signed one carries, and `auth.signInWithCustomToken` is what redeems it.
 */
import { z } from 'zod';
import { mintSandboxCustomToken } from '../../../../auth/users.js';
import { developerClaims, uid } from '../../arguments/auth.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'createCustomToken',
  sdkOrigin: 'firebase-admin',
  effect: 'read',
  signature: 'createCustomToken(uid, developerClaims?)',
  description: 'Mint a token signInWithCustomToken redeems.',
  args: z.object({ uid, developerClaims }),
  operation: 'create_auth_token',
  renames: { claims: 'developerClaims', customClaims: 'developerClaims', userId: 'uid' },
  example: { uid: 'alice', developerClaims: { role: 'owner' } },
  async handler(args) {
    const subject = String(args.uid);
    const claims = args.developerClaims as Record<string, unknown> | undefined;
    return {
      ok: true,
      summary: `Minted a custom token for ${subject}.`,
      data: { uid: subject, developerClaims: claims ?? {}, token: mintSandboxCustomToken(subject, claims) },
    };
  },
} satisfies MethodRecord;
