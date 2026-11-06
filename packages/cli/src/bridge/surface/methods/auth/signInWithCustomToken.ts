/**
 * Sign the app session in with a custom token.
 *
 * `auth.createCustomToken` mints the token this redeems, so the two compose the
 * way a backend and a client do: mint on the admin side, redeem here. The
 * token must carry the sandbox signature, name this sandbox's project and be
 * unexpired; an unsigned one is refused with `auth/invalid-custom-token`.
 */
import { z } from 'zod';
import { getAuth, signInWithCustomToken } from 'pyric/auth';
import {
  customTokenSubject,
  reportAppSession,
  scopeToStoredTenant,
  signInFailure,
} from '../../sign-in.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'signInWithCustomToken',
  runsIn: 'sandbox',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'signInWithCustomToken(token)',
  description: 'Sign the app session in with a minted custom token.',
  args: z.object({
    token: z.string().describe('The custom token, from createCustomToken.'),
  }),
  operation: 'signin_auth_token',
  renames: { customToken: 'token', idToken: 'token' },
  example: { token: '<the token auth.createCustomToken returned>' },
  async handler(args, ctx) {
    const token = String(args.token);
    scopeToStoredTenant(ctx.sandbox, { uid: customTokenSubject(token) });
    try {
      await signInWithCustomToken(getAuth(ctx.sandbox), token);
    } catch (error) {
      return signInFailure('signInWithCustomToken', error);
    }
    return reportAppSession(ctx);
  },
} satisfies MethodRecord;
