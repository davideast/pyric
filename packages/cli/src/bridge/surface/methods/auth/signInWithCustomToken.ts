/**
 * Sign the app session in with a custom token.
 *
 * `auth.createCustomToken` mints the token this redeems, so the two compose the
 * way a backend and a client do: mint on the admin side, redeem here. The
 * sandbox has no signing key, so no signature is checked; the token is read for
 * the identity it asserts and the claims it carries.
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
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'signInWithCustomToken(token)',
  description: 'Sign the app session in with a minted custom token.',
  args: z.object({
    token: z.string().describe('The custom token. Its signature is not checked.'),
  }),
  operation: 'signin_auth_token',
  renames: { customToken: 'token', idToken: 'token' },
  example: { token: 'eyJ1aWQiOiJhbGljZSJ9' },
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
