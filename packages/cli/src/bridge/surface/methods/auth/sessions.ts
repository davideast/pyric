/** List the sessions this sandbox holds: the agent identity and the app session. */
import { z } from 'zod';
import { listHeldSessions } from '../../held-identity.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'auth',
  method: 'sessions',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'sessions()',
  description: 'List the sessions this sandbox holds and their identities.',
  args: z.object({}),
  operation: 'list_auth_sessions',
  example: {},
  async handler(_args, ctx) {
    return listHeldSessions(ctx);
  },
} satisfies MethodRecord;
