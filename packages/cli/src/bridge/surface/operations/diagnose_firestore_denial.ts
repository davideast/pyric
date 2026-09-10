/** Explain why the Firestore rules denied a request. */
import { z } from 'zod';
import { operationFailure } from '../context.js';
import { simulateFirestoreCase, simulationDetail } from '../rules-simulation.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  operation: z.enum(['get', 'list', 'create', 'update', 'delete']).describe('The request method that was denied.'),
  path: z.string().describe('Document path the request targets.'),
  uid: z.string().optional().describe('Act as this user. Omit to use the held identity.'),
  data: z.record(z.unknown()).optional().describe('request.resource.data for a write.'),
});

export default {
  verb: 'diagnose',
  service: 'firestore',
  object: 'denial',
  description:
    'Trace one Firestore request through the loaded rules and report the rule that decided it, so a denial can be explained rather than guessed at.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const outcome = await simulateFirestoreCase(ctx, input);
    if (!outcome.result.ok) return operationFailure(outcome.result.summary, outcome.result.data);
    const detail = simulationDetail(outcome.result);
    return {
      ok: true,
      summary: outcome.allowed
        ? `${input.operation} ${input.path} is allowed for this identity.`
        : `${input.operation} ${input.path} is denied for this identity.`,
      data: { allowed: outcome.allowed, auth: outcome.auth, case: detail },
    };
  },
} satisfies OperationRecord;
