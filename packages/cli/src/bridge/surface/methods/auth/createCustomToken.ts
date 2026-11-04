/**
 * Mint a custom token for a uid.
 *
 * Minting changes nothing: in production a backend signs an assertion with a
 * service account key and the project's user pool is not touched until the
 * token is redeemed. The sandbox signs the same assertion with a sandbox key,
 * for its project and on its clock, and `auth.signInWithCustomToken` is what
 * redeems it.
 */
import { z } from 'zod';
import { getAuth } from 'pyric/auth';
import { mintCustomTokenFor } from 'pyric/auth/internal';
import { developerClaims, uid } from '../../arguments/auth.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'createCustomToken',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-admin',
  effect: 'read',
  signature: 'createCustomToken(uid, developerClaims?)',
  description: 'Mint a token signInWithCustomToken redeems.',
  args: z.object({ uid, developerClaims }),
  operation: 'create_auth_token',
  renames: { claims: 'developerClaims', customClaims: 'developerClaims', userId: 'uid' },
  example: { uid: 'alice', developerClaims: { role: 'owner' } },
  async handler(args, ctx) {
    const subject = String(args.uid);
    const claims = args.developerClaims as Record<string, unknown> | undefined;
    const token = mintCustomTokenFor(getAuth(ctx.sandbox), subject, claims);
    return {
      ok: true,
      summary: `Minted a custom token for ${subject}.`,
      data: { uid: subject, developerClaims: claims ?? {}, token },
    };
  },
} satisfies MethodRecord;
