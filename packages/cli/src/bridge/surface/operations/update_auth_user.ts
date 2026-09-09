/** Change the stored fields of one user. */
import { z } from 'zod';
import { callSandboxTool } from '../context.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  uid: z.string().describe('The user to change.'),
  email: z.string().optional().describe('Replacement email address.'),
  password: z.string().optional().describe('Replacement password.'),
  displayName: z.string().optional().describe('Replacement display name.'),
  disabled: z.boolean().optional().describe('Whether the account is disabled.'),
  emailVerified: z.boolean().optional().describe('Whether the email is verified.'),
});

export default {
  verb: 'update',
  service: 'auth',
  object: 'user',
  description: 'Change one user. Every supplied field replaces what is stored; omitted fields are left alone.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const call: Record<string, unknown> = { uid: input.uid };
    if (input.email !== undefined) call.email = input.email;
    if (input.password !== undefined) call.password = input.password;
    if (input.displayName !== undefined) call.displayName = input.displayName;
    if (input.disabled !== undefined) call.disabled = input.disabled;
    if (input.emailVerified !== undefined) call.emailVerified = input.emailVerified;
    return callSandboxTool(ctx, 'auth_update_user', call);
  },
} satisfies OperationRecord;
