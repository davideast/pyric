/**
 * Sign the app session in as a new anonymous user.
 *
 * The user is minted into the same pool `listUsers` reads, with the provider
 * `anonymous` and no email, exactly as an application's own call would.
 */
import { z } from 'zod';
import { getAuth, signInAnonymously } from 'pyric/auth';
import { reportAppSession, scopeToStoredTenant, signInFailure } from '../../sign-in.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'signInAnonymously',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'signInAnonymously()',
  description: 'Sign the app session in as a new anonymous user.',
  args: z.object({}),
  operation: 'signin_auth_anonymous',
  example: {},
  async handler(_args, ctx) {
    scopeToStoredTenant(ctx.sandbox, {});
    try {
      await signInAnonymously(getAuth(ctx.sandbox));
    } catch (error) {
      return signInFailure('signInAnonymously', error);
    }
    return reportAppSession(ctx);
  },
} satisfies MethodRecord;
