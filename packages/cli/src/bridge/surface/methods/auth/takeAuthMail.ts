/**
 * Read and remove the oldest message in the sandbox's Auth outbox.
 *
 * The outbox holds what the sandbox's mail server would have delivered:
 * password resets, email verifications, email changes, and sign-in links.
 * It is sandbox-wide and in memory, so taking a message changes no stored
 * account. A message an application issued is the same message this returns,
 * because both reach the one outbox on the context's sandbox.
 */
import { z } from 'zod';
import { getAuth, sandbox as sandboxAuth } from 'pyric/auth';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'takeAuthMail',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'takeAuthMail(email?)',
  description: 'Take the oldest outbound mail.',
  args: z.object({
    email: z
      .string()
      .optional()
      .describe('Take the oldest message addressed to this recipient. Matched case-insensitively.'),
  }),
  operation: 'take_auth_mail',
  example: { email: 'alice@example.com' },
  async handler(args, ctx) {
    const recipient = typeof args.email === 'string' ? args.email : undefined;
    const mail = sandboxAuth.takeAuthMail(getAuth(ctx.sandbox), recipient);
    const summary = mail === null
      ? 'The Auth outbox holds no matching message'
      : `Took ${mail.operation} message for ${mail.email}`;
    return { ok: true, summary, data: { mail } };
  },
} satisfies MethodRecord;
