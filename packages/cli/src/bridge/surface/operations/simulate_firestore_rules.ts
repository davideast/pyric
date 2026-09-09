/** Evaluate one request against the Firestore rules. */
import { z } from 'zod';
import { operationFailure } from '../context.js';
import { simulateFirestoreCase, simulationDetail } from '../rules-simulation.js';
import type { OperationRecord } from '../types.js';

const parameters = z.object({
  operation: z.enum(['get', 'list', 'create', 'update', 'delete']).describe('The request method to evaluate.'),
  path: z.string().describe('Document path the request targets.'),
  uid: z.string().optional().describe('Act as this user. Omit to use the held identity.'),
  data: z.record(z.unknown()).optional().describe('request.resource.data for a write.'),
  rules: z.string().optional().describe('Rules source to evaluate. Defaults to the rules the sandbox is running.'),
});

export default {
  verb: 'simulate',
  service: 'firestore',
  object: 'rules',
  description:
    'Evaluate one Firestore request against the rules and report whether it is allowed, without touching stored data.',
  parameters,
  async handler(args, ctx) {
    const input = parameters.parse(args);
    const outcome = await simulateFirestoreCase(ctx, input);
    if (!outcome.result.ok) return operationFailure(outcome.result.summary, outcome.result.data);
    return {
      ok: true,
      summary: `${input.operation} ${input.path}: ${outcome.allowed ? 'ALLOW' : 'DENY'}`,
      data: { allowed: outcome.allowed, auth: outcome.auth, case: simulationDetail(outcome.result) },
    };
  },
} satisfies OperationRecord;
