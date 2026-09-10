/**
 * Sign the app session in with an email and a password.
 *
 * This changes what the application sees from `onAuthStateChanged` and nothing
 * about what the agent's own calls run as. `whoami` reports both, and
 * `useAppSession` is the method that adopts one as the other.
 */
import { z } from 'zod';
import { getAuth, signInWithEmailAndPassword } from 'pyric/auth';
import { RENAMES } from '../../arguments/auth.js';
import { reportAppSession, scopeToStoredTenant, signInFailure } from '../../sign-in.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'signInWithEmailAndPassword',
  sdkOrigin: 'firebase-js',
  effect: 'write',
  signature: 'signInWithEmailAndPassword(email, password)',
  description: 'Sign the app session in. The agent identity is unchanged.',
  args: z.object({
    email: z.string().describe('The address on the account.'),
    password: z.string().describe('The password on the account. Never returned.'),
  }),
  operation: 'signin_auth_password',
  renames: RENAMES,
  example: { email: 'alice@example.com', password: 'hunter22' },
  async handler(args, ctx) {
    const email = String(args.email);
    scopeToStoredTenant(ctx.sandbox, { email });
    try {
      await signInWithEmailAndPassword(getAuth(ctx.sandbox), email, String(args.password));
    } catch (error) {
      return signInFailure('signInWithEmailAndPassword', error);
    }
    return reportAppSession(ctx);
  },
} satisfies MethodRecord;
