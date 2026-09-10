/**
 * Turn one known-good operation into probes by changing exactly one thing.
 *
 * A mutation changes the path, the query, the payload, or the operation, and
 * only one of them, so a probe that comes back permissive names which single
 * change the rules failed to stop.
 */
import { z } from 'zod';

import { campaignId, probeMutation } from '../../arguments/assurance.js';
import { callAssuranceOperation } from '../../assurance-campaigns.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'assurance',
  method: 'propose',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature:
    'propose(campaignId, observationId, invariantId, mutations; dimension: path|query|payload|operation; operation.service: firestore|rtdb|storage; operation.method: get|list|create|set|merge|update|delete|remove|upload|updateMetadata)',
  description: 'Turn an observation into probes.',
  args: z.object({
    campaignId,
    observationId: z.string().min(1).describe('The known-good observation the probes start from.'),
    invariantId: z.string().min(1).describe('The invariant each probe is judged against.'),
    mutations: z
      .array(probeMutation)
      .min(1)
      .describe(
        'Each names a dimension of path, query, payload, or operation, a description, and the operation.',
      ),
  }),
  operation: 'propose_assurance_probes',
  renames: { caseId: 'observationId', observation: 'observationId', invariant: 'invariantId' },
  example: {
    campaignId: 'first-pass',
    observationId: 'owner-reads-own-order',
    invariantId: 'orders-are-private',
    mutations: [
      {
        dimension: 'path',
        description: 'read an order belonging to another account',
        operation: { service: 'firestore', method: 'get', path: 'orders/o2' },
      },
    ],
  },
  async handler(args, ctx) {
    return callAssuranceOperation(ctx, 'firebase_assurance_propose', args);
  },
} satisfies MethodRecord;
