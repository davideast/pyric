/**
 * Sign the app session out.
 *
 * The agent identity is untouched, so an agent that signed in as a user and
 * then signed the app out is still whatever it was administering as, and can
 * go on administering users.
 */
import { z } from 'zod';
import { getAuth, signOut as signOutOfApp } from 'pyric/auth';
import { reportAppSession, signInFailure } from '../../sign-in.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'signOut',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'signOut()',
  description: 'Sign the app session out. The agent identity is unchanged.',
  args: z.object({}),
  operation: 'signout_auth_session',
  example: {},
  async handler(_args, ctx) {
    try {
      await signOutOfApp(getAuth(ctx.sandbox));
    } catch (error) {
      return signInFailure('signOut', error);
    }
    return reportAppSession(ctx);
  },
} satisfies MethodRecord;
