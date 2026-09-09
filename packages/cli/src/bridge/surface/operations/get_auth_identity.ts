/** Report the identity every later call runs under. */
import { z } from 'zod';
import type { OperationRecord } from '../types.js';

const parameters = z.object({});

export default {
  verb: 'get',
  service: 'auth',
  object: 'identity',
  description:
    'Report the caller identity every later call runs under: its mode, uid, tenant, and claims as projected into the auth token.',
  parameters,
  async handler(_args, ctx) {
    const held = ctx.identity.describe();
    return {
      ok: true,
      summary: held.uid ? `Acting as ${held.uid}` : `Acting as ${held.mode}`,
      data: { identity: held },
    };
  },
} satisfies OperationRecord;
