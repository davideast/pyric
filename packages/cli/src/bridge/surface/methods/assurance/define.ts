/**
 * State the authorization boundaries this campaign judges against.
 *
 * Permissive behaviour is not a finding until something says what was supposed
 * to happen. An invariant is that statement, and the campaign refuses to
 * classify a probe no invariant covers.
 */
import { z } from 'zod';

import { authoredRecord, campaignId } from '../../arguments/assurance.js';
import { callAssuranceOperation } from '../../assurance-campaigns.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'assurance',
  method: 'define',
  sdkOrigin: 'pyric',
  effect: 'write',
  signature: 'define(campaignId, invariants)',
  description: 'Add the invariants a probe is judged against.',
  args: z.object({
    campaignId,
    invariants: z
      .array(authoredRecord)
      .min(1)
      .describe(
        'Each names an id, a statement, a service, an expected ALLOW or DENY, a source, and a confidence.',
      ),
  }),
  operation: 'define_assurance_invariants',
  renames: { rules: 'invariants', expectations: 'invariants', case: 'invariants' },
  example: {
    campaignId: 'first-pass',
    invariants: [
      {
        id: 'orders-are-private',
        statement: 'Only the owner reads an order.',
        service: 'firestore',
        expected: 'DENY',
        source: 'declared',
        confidence: 'authoritative',
      },
    ],
  },
  async handler(args, ctx) {
    return callAssuranceOperation(ctx, 'firebase_assurance_define', args);
  },
} satisfies MethodRecord;
